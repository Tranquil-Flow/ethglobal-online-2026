import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openSync, closeSync, chmodSync, lstatSync } from "node:fs";

/** Explicitly opened, single-service-owner SQLite store. No logs or implicit paths. */
export function createStore({ path }) {
  if (!path || path === ":memory:")
    throw new Error("Explicit durable database path required");
  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error("Regular database required");
  chmodSync(path, 0o600);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("secure_delete = ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY); CREATE TABLE IF NOT EXISTS records(namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,id)); INSERT OR IGNORE INTO migrations VALUES(1)",
  );
  const get = db.prepare(
    "SELECT value FROM records WHERE namespace=? AND id=?",
  );
  const put = db.prepare(
    "INSERT INTO records VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value",
  );
  const del = db.prepare("DELETE FROM records WHERE namespace=? AND id=?");
  const list = db.prepare(
    "SELECT id,value FROM records WHERE namespace=? ORDER BY id",
  );
  const instance = randomUUID();
  let owned = false;
  const release = () => {
    if (owned) {
      db.transaction(() => {
        const row = get.get("metadata", "owner");
        if (row && JSON.parse(row.value).instance === instance)
          del.run("metadata", "owner");
      }).immediate();
      owned = false;
    }
  };
  return {
    acquire: () =>
      db
        .transaction(() => {
          const row = get.get("metadata", "owner");
          if (row) {
            const owner = JSON.parse(row.value);
            let alive = true;
            try {
              process.kill(owner.pid, 0);
            } catch (e) {
              if (e.code === "ESRCH") alive = false;
            }
            if (alive)
              throw Error("Database already has an active service owner");
          }
          put.run(
            "metadata",
            "owner",
            JSON.stringify({ pid: process.pid, instance }),
          );
          owned = true;
        })
        .immediate(),
    release,
    get: (ns, id) => {
      const r = get.get(ns, id);
      return r ? JSON.parse(r.value) : undefined;
    },
    set: (ns, id, value) => put.run(ns, id, JSON.stringify(value)),
    delete: (ns, id) => del.run(ns, id),
    list: (ns) =>
      list.all(ns).map((r) => ({ id: r.id, ...JSON.parse(r.value) })),
    transaction: (fn) => db.transaction(fn).immediate(),
    compact: () => {
      db.pragma("wal_checkpoint(TRUNCATE)");
    },
    close: () => {
      release();
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
