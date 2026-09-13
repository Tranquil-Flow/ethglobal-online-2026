// Append-only audit journal for ensemble evaluations and audit escalations.
//
// Each call writes a single JSON line to W6_AUDIT_JOURNAL_PATH (default
// ~/.mycelium/w6-audit-journal.jsonl). The file is created with mode 0600
// and the parent directory with mode 0700 so that audit evidence is not
// world-readable. Lines are flushed before the function returns to keep
// crash-recovery ordering honest.
//
// The journal is intentionally synchronous because it is the
// authoritative local audit trail; if a write fails, the caller must know
// before the inference event is reported as clean.

import { appendFileSync, mkdirSync, statSync, openSync, closeSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_PATH = resolve(
  process.env.W6_AUDIT_JOURNAL_PATH ?? `${process.env.HOME ?? "/tmp"}/.mycelium/w6-audit-journal.jsonl`,
);

function ensureJournal(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("not-a-file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, "");
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
  }
  // Always re-assert mode in case it drifted (e.g. umask was reset).
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

export function createAuditJournal({ path = DEFAULT_PATH } = {}) {
  ensureJournal(path);

  function append(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("audit event must be a plain object");
    }
    const record = {
      event_id: event.event_id ?? randomUUID(),
      recorded_at: new Date().toISOString(),
      ...event,
    };
    appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });
    return record;
  }

  return Object.freeze({
    append,
    path,
  });
}

export const AUDIT_JOURNAL_DEFAULT_PATH = DEFAULT_PATH;
