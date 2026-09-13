import Database from "better-sqlite3";
import { mkdirSync, chmodSync, lstatSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { fail } from "./safety.mjs";
export function createSqliteStore({ path }) {
  if (typeof path !== "string" || !path || path === ":memory:")
    fail("DURABLE_STORE_REQUIRED");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    fail("INVALID_STORE");
  chmodSync(path, 0o600);
  const db = new Database(path, { timeout: 1000 });
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, principal TEXT NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), principal TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, transaction_id TEXT NOT NULL UNIQUE, proof_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL, UNIQUE(principal,key_hash),UNIQUE(principal,request_hash));
 CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),outcome TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS refunds (transaction_id TEXT PRIMARY KEY,payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id));`);
  const getMetadata = (key) =>
    db.prepare("SELECT value FROM metadata WHERE key=?").get(key)?.value;
  const setMetadata = (key, value) =>
    db.prepare("INSERT INTO metadata VALUES(?,?)").run(key, value);
  const reconcileConfigurationBinding = (binding) => {
    if (typeof binding !== "string" || !binding) fail("INVALID_CONFIG");
    const retainedPayments = db
      .prepare("SELECT COUNT(*) AS count FROM payments")
      .get().count;
    if (retainedPayments > 0) fail("STORE_CONFIG_CONFLICT");
    const removedQuotes = db.prepare("DELETE FROM quotes").run().changes;
    db.prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(
      "binding",
      binding,
    );
    return {
      status: "rebound-quote-only-store",
      removedQuotes,
      retainedPayments: 0,
    };
  };
  return {
    transaction: (fn) => db.transaction(fn).immediate(),
    getMetadata,
    setMetadata,
    reconcileConfigurationBinding,
    countQuotes: (principal) =>
      principal
        ? db
            .prepare("SELECT COUNT(*) AS count FROM quotes WHERE principal=?")
            .get(principal).count
        : db.prepare("SELECT COUNT(*) AS count FROM quotes").get().count,
    putQuote: (q) =>
      db
        .prepare("INSERT INTO quotes VALUES(?,?,?,?)")
        .run(
          q.quote.quoteId,
          q.principalHash,
          q.quote.requestHash,
          JSON.stringify(q),
        ),
    getQuote: (id) => {
      const r = db.prepare("SELECT data FROM quotes WHERE id=?").get(id);
      return r ? JSON.parse(r.data) : null;
    },
    getPayment: (id) => {
      const r = db.prepare("SELECT data FROM payments WHERE id=?").get(id);
      return r ? JSON.parse(r.data) : null;
    },
    byQuote: (id) => {
      const r = db
        .prepare("SELECT data FROM payments WHERE quote_id=?")
        .get(id);
      return r ? JSON.parse(r.data) : null;
    },
    byKey: (principal, key) => {
      const r = db
        .prepare("SELECT data FROM payments WHERE principal=? AND key_hash=?")
        .get(principal, key);
      return r ? JSON.parse(r.data) : null;
    },
    byRequest: (principal, hash) => {
      const r = db
        .prepare("SELECT id FROM payments WHERE principal=? AND request_hash=?")
        .get(principal, hash);
      return r?.id;
    },
    byTransaction: (id) =>
      db.prepare("SELECT id FROM payments WHERE transaction_id=?").get(id)?.id,
    listPayments: (principal) =>
      db
        .prepare("SELECT data FROM payments WHERE principal=?")
        .all(principal)
        .map((r) => JSON.parse(r.data)),
    insertPayment: (r) =>
      db
        .prepare("INSERT INTO payments VALUES(?,?,?,?,?,?,?,?)")
        .run(
          r.payment.paymentId,
          r.payment.quoteId,
          r.principalHash,
          r.keyHash,
          r.payment.requestHash,
          r.transactionId,
          r.proofHash,
          JSON.stringify(r),
        ),
    savePayment: (r) =>
      db
        .prepare("UPDATE payments SET data=? WHERE id=?")
        .run(JSON.stringify(r), r.payment.paymentId),
    getJob: (id) => db.prepare("SELECT * FROM jobs WHERE payment_id=?").get(id),
    putJob: (job, payment, outcome) =>
      db.prepare("INSERT INTO jobs VALUES(?,?,?)").run(job, payment, outcome),
    putRefund: (id, payment) =>
      db.prepare("INSERT INTO refunds VALUES(?,?)").run(id, payment),
    close: () => {
      if (db.open) db.close();
    },
  };
}
