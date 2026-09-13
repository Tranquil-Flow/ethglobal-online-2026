import { mkdirSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { BetterSqlite3 } from "./deps.mjs";

export const DEFAULT_OUTBOX_PATH =
  "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/relayer/outbox.sqlite";

const VALID_TYPES = new Set(["settle", "slash", "ledgerEvent"]);
const VALID_STATUSES = new Set(["pending", "in_flight", "confirmed", "failed"]);

function encodeJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function decodeJson(value) {
  return JSON.parse(value);
}

function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? "UNKNOWN_ERROR");
}

export class SettlementOutbox {
  constructor({ dbPath = DEFAULT_OUTBOX_PATH, now = () => Date.now() } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const existed = existsSync(dbPath);
    this.db = new BetterSqlite3(dbPath);
    chmodSync(dbPath, 0o600);
    if (!existed) chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.#migrate();
    this.#secureFiles();
  }

  #secureFiles() {
    for (const candidate of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('settle','slash','ledgerEvent')),
        payload JSON NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','in_flight','confirmed','failed')),
        createdAt INTEGER NOT NULL,
        lastAttemptAt INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        txHash TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_pending_idx
        ON outbox(status, attempts, createdAt, id);
      CREATE INDEX IF NOT EXISTS outbox_cleanup_idx
        ON outbox(status, lastAttemptAt, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_unique_type_verdict
        ON outbox(type, json_extract(payload, '$.verdictId'))
        WHERE json_extract(payload, '$.verdictId') IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_unique_type_idempotency
        ON outbox(type, json_extract(payload, '$.idempotencyKey'))
        WHERE json_extract(payload, '$.idempotencyKey') IS NOT NULL;
    `);
  }

  journalMode() {
    return this.db.pragma("journal_mode", { simple: true });
  }

  append(type, payload, { createdAt = this.now() } = {}) {
    if (!VALID_TYPES.has(type)) throw new Error(`INVALID_OUTBOX_TYPE:${type}`);
    const payloadText = encodeJson(payload);
    try {
      const info = this.db
        .prepare(
          `INSERT INTO outbox (type, payload, status, createdAt, attempts)
           VALUES (?, ?, 'pending', ?, 0)`,
        )
        .run(type, payloadText, createdAt);
      this.#secureFiles();
      return this.get(info.lastInsertRowid);
    } catch (error) {
      if (error?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw error;
      const existing = this.#findExistingByIdempotency(type, payload);
      if (!existing) throw error;
      return existing;
    }
  }

  #findExistingByIdempotency(type, payload) {
    if (payload?.verdictId !== undefined) {
      const row = this.db
        .prepare(
          `SELECT * FROM outbox
           WHERE type = ? AND json_extract(payload, '$.verdictId') = ?
           ORDER BY id LIMIT 1`,
        )
        .get(type, String(payload.verdictId));
      if (row) return this.#row(row);
    }
    if (payload?.idempotencyKey !== undefined) {
      const row = this.db
        .prepare(
          `SELECT * FROM outbox
           WHERE type = ? AND json_extract(payload, '$.idempotencyKey') = ?
           ORDER BY id LIMIT 1`,
        )
        .get(type, String(payload.idempotencyKey));
      if (row) return this.#row(row);
    }
    return null;
  }

  findPending({ limit = 100, maxAttempts = 5, staleInFlightMs = 300_000, now = this.now() } = {}) {
    this.requeueStaleInFlight({ staleInFlightMs, now });
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'failed', error = COALESCE(error, 'MAX_RETRIES')
         WHERE status = 'pending' AND attempts >= ?`,
      )
      .run(maxAttempts);
    this.#secureFiles();
    return this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE status = 'pending' AND attempts < ?
         ORDER BY createdAt ASC, id ASC
         LIMIT ?`,
      )
      .all(maxAttempts, limit)
      .map((row) => this.#row(row));
  }

  requeueStaleInFlight({ staleInFlightMs = 300_000, now = this.now() } = {}) {
    const changes = this.db
      .prepare(
        `UPDATE outbox
         SET status = 'pending', error = COALESCE(error, 'STALE_IN_FLIGHT_REQUEUED')
         WHERE status = 'in_flight' AND COALESCE(lastAttemptAt, createdAt) <= ?`,
      )
      .run(now - staleInFlightMs).changes;
    this.#secureFiles();
    return changes;
  }

  markInFlight(id, { at = this.now() } = {}) {
    const info = this.db
      .prepare(
        `UPDATE outbox
         SET status = 'in_flight', attempts = attempts + 1, lastAttemptAt = ?, error = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(at, id);
    if (info.changes !== 1) throw new Error(`OUTBOX_ROW_NOT_PENDING:${id}`);
    this.#secureFiles();
    return this.get(id);
  }

  markFailure(id, error, { maxAttempts = 5, at = this.now() } = {}) {
    const row = this.get(id);
    if (!row) throw new Error(`OUTBOX_ROW_NOT_FOUND:${id}`);
    const status = row.attempts >= maxAttempts ? "failed" : "pending";
    this.db
      .prepare(
        `UPDATE outbox
         SET status = ?, lastAttemptAt = ?, error = ?
         WHERE id = ?`,
      )
      .run(status, at, normalizeError(error), id);
    this.#secureFiles();
    return this.get(id);
  }

  markConfirmed(id, txHash, { at = this.now() } = {}) {
    this.db
      .prepare(
        `UPDATE outbox
         SET status = 'confirmed', lastAttemptAt = ?, txHash = ?, error = NULL
         WHERE id = ?`,
      )
      .run(at, txHash, id);
    this.#secureFiles();
    return this.get(id);
  }

  updateStatus(id, status, { at = this.now(), txHash = null, error = null } = {}) {
    if (!VALID_STATUSES.has(status)) throw new Error(`INVALID_OUTBOX_STATUS:${status}`);
    this.db
      .prepare(
        `UPDATE outbox
         SET status = ?, lastAttemptAt = ?, txHash = COALESCE(?, txHash), error = ?
         WHERE id = ?`,
      )
      .run(status, at, txHash, error, id);
    this.#secureFiles();
    return this.get(id);
  }

  deleteConfirmedBefore(cutoffMs) {
    const changes = this.db
      .prepare(
        `DELETE FROM outbox
         WHERE status = 'confirmed' AND COALESCE(lastAttemptAt, createdAt) < ?`,
      )
      .run(cutoffMs).changes;
    this.#secureFiles();
    return changes;
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id);
    return row ? this.#row(row) : null;
  }

  countRows({ type, status } = {}) {
    const clauses = [];
    const params = [];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT COUNT(*) AS count FROM outbox ${where}`).get(...params).count;
  }

  close() {
    this.db.close();
  }

  #row(row) {
    return {
      id: row.id,
      type: row.type,
      payload: decodeJson(row.payload),
      status: row.status,
      createdAt: row.createdAt,
      lastAttemptAt: row.lastAttemptAt,
      attempts: row.attempts,
      txHash: row.txHash,
      error: row.error,
    };
  }
}
