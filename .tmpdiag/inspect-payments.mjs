
import Database from "../../packages/payments/node_modules/better-sqlite3/lib/index.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const APP = process.argv[2];
for (const pid of ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"]) {
  const did = createHash("sha256").update(pid).digest("hex");
  const path = join(APP, "providers", did, "payments.sqlite");
  if (existsSync(path)) {
    console.log(`\n${path}: EXISTS`);
    const db = new Database(path, { readonly: true, timeout: 1000 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const t of tables) {
      try {
        const rows = db.prepare(`SELECT * FROM ${t.name}`).all();
        console.log(`  ${t.name}: ${JSON.stringify(rows)}`);
      } catch (e) { console.log(`  ${t.name}: error ${e.message}`); }
    }
    db.close();
  } else {
    console.log(`\n${path}: MISSING (wiped by gate, never recreated)`);
  }
}
