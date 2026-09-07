import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("SQLite durable private store migrates and rolls back atomic writes", async () => {
  const { createStore } = await import("../src/store.mjs");
  const dir = mkdtempSync(join(tmpdir(), "core-store-"));
  const path = join(dir, "private.sqlite");
  try {
    let s = createStore({ path });
    s.set("sessions", "one", { hash: "only-hash" });
    assert.throws(() =>
      s.transaction(() => {
        s.set("jobs", "one", { state: "queued" });
        throw Error("rollback");
      }),
    );
    assert.equal(s.get("jobs", "one"), undefined);
    s.close();
    s = createStore({ path });
    assert.deepEqual(s.get("sessions", "one"), { hash: "only-hash" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    s.delete("sessions", "one");
    assert.deepEqual(s.list("sessions"), []);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
