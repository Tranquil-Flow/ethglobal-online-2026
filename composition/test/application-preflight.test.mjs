import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { startApplicationWorkbench } from "../application-workbench.mjs";
import { setup } from "./fixtures/application.mjs";
test("occupied ports and insecure retained stores fail before provider startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "preflight-app-"));
  let app;
  const server = createServer();
  try {
    const f = setup(root);
    let starts = 0;
    for (const p of f.bindings.providers) {
      const original = p.runtime.create;
      p.runtime.create = (x) => {
        starts++;
        return original(x);
      };
    }
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    f.config.port = server.address().port;
    await assert.rejects(startApplicationWorkbench(f), /PORT_UNAVAILABLE/);
    assert.equal(starts, 0);
    await new Promise((r) => server.close(r));
    f.config.port = 0;
    app = await startApplicationWorkbench(f);
    await app.close();
    app = undefined;
    starts = 0;
    await chmod(join(root, "core.sqlite"), 0o644);
    await assert.rejects(
      startApplicationWorkbench(f),
      /PRIVATE_STATE_REQUIRED/,
    );
    assert.equal(starts, 0);
  } finally {
    if (server.listening) await new Promise((r) => server.close(r));
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
