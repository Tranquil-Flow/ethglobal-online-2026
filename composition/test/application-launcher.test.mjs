import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "./fixtures/application.mjs";
test(
  "documented production launcher accepts explicit v2 non-economic bindings, no legacy payment mode",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-launch-"));
    let child, exited;
    try {
      const f = setup(join(dir, "state"));
      const configPath = join(dir, "application.json");
      await writeFile(configPath, JSON.stringify(f.config), { mode: 0o600 });
      child = spawn(
        process.execPath,
        [
          "composition/serve.mjs",
          "--config",
          configPath,
          "--bindings",
          fileURLToPath(
            new URL("./fixtures/application-bindings.mjs", import.meta.url),
          ),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      exited = new Promise((r) => child.once("exit", r));
      let output = "",
        errors = "";
      child.stderr.on("data", (b) => {
        errors += b;
      });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("START_TIMEOUT " + errors)),
          6000,
        );
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(Error("EXIT " + code + " " + errors));
        });
        child.stdout.on("data", (b) => {
          output += b;
          const line = output.split("\n").find((l) => l.startsWith("{"));
          if (line)
            try {
              const result = JSON.parse(line);
              clearTimeout(timer);
              resolve(result);
            } catch {}
        });
      });
      assert.equal(ready.payment, "non-monetary-no-settlement");
      assert.equal(ready.history, "unavailable");
      assert.equal((await fetch(ready.url + "/healthz")).status, 200);
    } finally {
      child?.kill("SIGTERM");
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
