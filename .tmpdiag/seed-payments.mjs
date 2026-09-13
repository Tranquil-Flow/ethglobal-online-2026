
import Database from "../../packages/payments/node_modules/better-sqlite3/lib/index.js";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const APP = process.argv[2];
for (const pid of ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"]) {
  const did = createHash("sha256").update(pid).digest("hex");
  const dir = join(APP, "providers", did);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "payments.sqlite");
  const db = new Database(path, { timeout: 1000 });
  db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE payments (id TEXT PRIMARY KEY, quote_id TEXT, principal TEXT, key_hash TEXT, request_hash TEXT, transaction_id TEXT, proof_hash TEXT, data TEXT);
CREATE TABLE quotes (id TEXT PRIMARY KEY, principal TEXT, hash TEXT, data TEXT);
CREATE TABLE jobs (job_id TEXT PRIMARY KEY, payment_id TEXT, outcome TEXT);
CREATE TABLE refunds (transaction_id TEXT PRIMARY KEY, payment_id TEXT);`);
  db.prepare("INSERT INTO payments VALUES (?,?,?,?,?,?,?,?)").run("p1","q1","x","kh","rh","tx","pr","data");
  db.prepare("INSERT INTO metadata VALUES (?,?)").run("binding", "sha256:beefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");
  db.close();
}
console.log("seeded");
