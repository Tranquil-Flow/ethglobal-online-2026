import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test(
  "documented configuration CLI starts the real local workbench and shuts down",
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "workbench-cli-"));
    let child;
    try {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({
          version: "1",
          mode: "simulation",
          dataDir: join(dir, "state"),
          port: 0,
          providers: [
            { providerId: "alpha.example.eth", amountBaseUnits: "2" },
            { providerId: "beta.example.eth", amountBaseUnits: "3" },
          ],
        }),
        { mode: 0o600 },
      );
      child = spawn(
        process.execPath,
        ["composition/serve.mjs", "--config", path],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = new Promise((r) =>
        child.once("exit", (code, signal) => r({ code, signal })),
      );
      let text = "",
        errors = "";
      child.stderr.on("data", (b) => {
        errors = (errors + b).slice(-4096);
      });
      const info = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("STARTUP_TIMEOUT")), 60000);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(Error("STARTUP_FAILED: " + errors));
        });
        child.stdout.on("data", (b) => {
          text += b;
          for (const line of text.split("\n")) {
            try {
              const info = JSON.parse(line);
              if (info.url) {
                clearTimeout(timer);
                resolve(info);
                return;
              }
            } catch {}
          }
        });
      });
      assert.equal(info.mode, "simulation");
      assert.equal(
        (await (await fetch(info.url + "/healthz")).json()).status,
        "ok",
      );
      const cfg = await (await fetch(info.url + "/config.json")).json();
      assert.equal(cfg.providers.length, 2);
      assert.equal(cfg.replayMethod, "simulator-replay-v1");
      child.kill("SIGTERM");
      assert.equal((await exited).code, 0);
      child = undefined;
      await assert.rejects(fetch(info.url + "/healthz"));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
