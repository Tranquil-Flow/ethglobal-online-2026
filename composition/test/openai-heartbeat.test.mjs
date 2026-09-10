import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createApp,
  createStore,
  createSigner,
  developmentProfile,
  createDevelopmentPayments,
} from "../../packages/core/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";

for (const client of ["sync", "async"])
  for (const failExecution of [false, true])
    test(
      `stock ${client} SDK: repeated heartbeats preserve ${failExecution ? "terminal error" : "Unicode, finish and idempotency"}`,
      { timeout: 30000 },
      async () => {
        assert.ok(
          process.env.C_UC1_PYTHON,
          "installed stock OpenAI SDK environment required",
        );
        const dir = await mkdtemp(join(tmpdir(), "openai-heartbeat-"));
        let store, app, proxy, child;
        let executions = 0;
        const wires = [];
        try {
          store = createStore({ path: join(dir, "state.sqlite") });
          const signer = createSigner({
            privateKey: generateKeyPairSync("ed25519").privateKey,
            keyId: "heartbeat-fixture",
          });
          app = createApp({
            config: {
              mode: "development",
              profiles: [developmentProfile],
              providerIds: ["heartbeat.invalid"],
              jobDeadlineMs: 10000,
            },
            store,
            signer,
            payments: createDevelopmentPayments({ store, sponsored: true }),
            executor: {
              mode: "development",
              async *execute({ profile, signal }) {
                executions++;
                yield { type: "delta", text: "é", tokenIds: [11] };
                // Long enough for repeated transport heartbeats AFTER an SSE ID.
                // This is artificial executor latency, not a model performance measurement.
                await delay(2300, undefined, { signal });
                if (failExecution)
                  throw Error("PRIVATE_SYNTHETIC_FAILURE_DO_NOT_ECHO");
                yield { type: "delta", text: "🌙", tokenIds: [12] };
                yield {
                  type: "completed",
                  profileId: digestOf(profile),
                  output: {
                    text: "é🌙",
                    tokenIds: [11, 12],
                    finishReason: "length",
                  },
                };
              },
            },
          });
          const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
          // Observe actual HTTP bytes without modifying/buffering the SDK's stream.
          proxy = createServer((req, res) => {
            const upstream = httpRequest(
              url + req.url,
              {
                method: req.method,
                headers: { ...req.headers, host: new URL(url).host },
              },
              (up) => {
                res.writeHead(up.statusCode, up.headers);
                if (up.headers["content-type"] === "text/event-stream") {
                  const wire = { text: "" };
                  wires.push(wire);
                  up.on("data", (b) => {
                    wire.text += b.toString();
                  });
                }
                up.pipe(res);
              },
            );
            upstream.on("error", () => res.destroy());
            res.on("close", () => upstream.destroy());
            req.pipe(upstream);
          });
          await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
          const origin = "http://127.0.0.1:" + proxy.address().port;
          const sessionResponse = await fetch(origin + "/v1/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          assert.equal(sessionResponse.status, 201);
          const { capability } = await sessionResponse.json();
          const models = await (
            await fetch(origin + "/v1/models", {
              headers: { authorization: "Bearer " + capability },
            })
          ).json();
          const result = await new Promise((resolve, reject) => {
            child = spawn(
              process.env.C_UC1_PYTHON,
              [
                "-I",
                "-B",
                fileURLToPath(
                  new URL("./fixtures/openai-heartbeat.py", import.meta.url),
                ),
              ],
              { stdio: ["pipe", "pipe", "pipe"] },
            );
            let stdout = "",
              stderr = "";
            const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
            child.stdout.on("data", (b) => {
              stdout += b;
              if (stdout.length > 65536) child.kill("SIGTERM");
            });
            child.stderr.on("data", (b) => {
              stderr += b;
              if (stderr.length > 65536) child.kill("SIGTERM");
            });
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("close", (code) => {
              clearTimeout(timer);
              if (code !== 0)
                return reject(
                  Error("Stock SDK failed: " + stderr.slice(-4096)),
                );
              try {
                resolve(JSON.parse(stdout));
              } catch (error) {
                reject(error);
              }
            });
            child.stdin.end(
              JSON.stringify({
                url: origin,
                capability,
                model: models.data[0].id,
                client,
                fail_execution: failExecution,
              }),
            );
          });
          assert.equal(result.error, failExecution ? "EXECUTION_FAILED" : null);
          assert.equal(
            executions,
            1,
            "same-key stream/nonstream recovery must not rerun execution",
          );
          assert.equal(wires.length, 1);
          const wire = wires[0].text;
          assert.ok(
            (wire.match(/: heartbeat\n/g) ?? []).length >= 2,
            "exercise repeated real heartbeats",
          );
          assert.ok(
            wire.indexOf("id: ") < wire.indexOf(": heartbeat"),
            "heartbeat must follow a persisted cursor",
          );
          assert.equal(
            (wire.match(/data: \[DONE\]/g) ?? []).length,
            failExecution ? 0 : 1,
          );
          assert.equal(
            wire.includes("PRIVATE_SYNTHETIC_FAILURE_DO_NOT_ECHO"),
            false,
          );
          console.log(
            JSON.stringify({
              sdk: result.sdk,
              client,
              failExecution,
              heartbeats: (wire.match(/: heartbeat\n/g) ?? []).length,
              executions,
              scope: result.scope,
            }),
          );
        } finally {
          if (child && child.exitCode === null && child.signalCode === null)
            child.kill("SIGTERM");
          if (proxy) {
            proxy.closeAllConnections();
            await new Promise((ok) => proxy.close(ok));
          }
          await app?.close();
          store?.close();
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
