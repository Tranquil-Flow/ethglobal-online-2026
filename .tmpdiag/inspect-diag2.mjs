
import Database from "../packages/payments/node_modules/better-sqlite3/lib/index.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
const APP = process.argv[2];
const providersDir = join(APP, "providers");
if (existsSync(providersDir)) {
  const entries = readdirSync(providersDir);
  for (const e of entries) {
    const p = join(providersDir, e, "payments.sqlite");
    if (existsSync(p)) {
      console.log(`\n${p}: EXISTS`);
      const db = new Database(p, { readonly: true, timeout: 1000 });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        for (const t of tables) {
          const rows = db.prepare(`SELECT * FROM ${t.name}`).all();
          console.log(`  ${t.name}: ${JSON.stringify(rows)}`);
        }
      } catch (e) { console.log("  err:", e.message); }
      db.close();
    } else {
      console.log(`\n${p}: MISSING`);
    }
  }
}
