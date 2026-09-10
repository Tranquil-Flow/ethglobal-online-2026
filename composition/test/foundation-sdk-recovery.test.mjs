import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import { startWorkbench } from "../workbench.mjs";
import { checkBuyerEvidenceJson } from "../../packages/access/src/index.mjs";
test(
  "stock SDK loses accepted response, recovers same attempt, streams native Unicode; private original-bound export",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "foundation-sdk-"));
    let fixture, app, proxy;
    let dropped = 0;
    try {
      fixture = await startGatewayFixture();
      const runtime = await createMyceliumRuntimeBinding(
        conformanceOptions(fixture.descriptor),
      );
      app = await startWorkbench({
        config: {
          version: "1",
          mode: "mycelium-v3-conformance",
          accessPolicy: "sponsored-local",
          dataDir: join(dir, "state"),
          port: 0,
          providers: [
            { providerId: "alpha.example.eth", amountBaseUnits: "0" },
          ],
        },
        runtime,
      });
      proxy = createServer((req, res) => {
        const upstream = httpRequest(
          app.url + req.url,
          {
            method: req.method,
            headers: { ...req.headers, host: new URL(app.url).host },
          },
          (up) => {
            if (
              !dropped &&
              req.url === "/v1/chat/completions" &&
              up.statusCode === 200
            ) {
              dropped++;
              up.resume();
              res.destroy();
              return;
            }
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res);
          },
        );
        upstream.on("error", () => res.destroy());
        req.pipe(upstream);
      });
      await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
      const origin = "http://127.0.0.1:" + proxy.address().port;
      const session = await (
        await fetch(origin + "/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      assert.equal(
        (
          await fetch(app.url + "/v1/models", {
            headers: {
              authorization: "Bearer " + session.capability,
              origin: app.url,
            },
          })
        ).status,
        200,
        "validated outer origin must traverse fixed internal hop",
      );
      assert.equal(
        (
          await fetch(app.url + "/v1/models", {
            headers: {
              authorization: "Bearer " + session.capability,
              origin: "https://evil.invalid",
            },
          })
        ).status,
        403,
      );
      const sdk = await new Promise((resolve, reject) => {
        const child = spawn(
          process.env.C_UC1_PYTHON,
          [fileURLToPath(new URL("./fixtures/openai-sdk.py", import.meta.url))],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let out = "",
          err = "";
        child.stdout.on("data", (b) => {
          out += b;
          if (out.length > 65536) child.kill();
        });
        child.stderr.on("data", (b) => {
          err += b;
          if (err.length > 65536) child.kill();
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code) reject(Error("SDK failed: " + err));
          else
            try {
              resolve(JSON.parse(out));
            } catch (e) {
              reject(e);
            }
        });
        child.stdin.end(
          JSON.stringify({
            origin,
            capability: session.capability,
            expect_response_loss: true,
          }),
        );
      });
      assert.equal(dropped, 1);
      assert.equal(sdk.response_loss_observed, true);
      assert.equal(sdk.sdk_recovery_same_job, true);
      const headers = { authorization: "Bearer " + session.capability };
      for (const id of [sdk.nonstream_job, sdk.stream_job]) {
        const job = await (
          await fetch(app.url + "/v1/jobs/" + id, { headers })
        ).json();
        const text = await (
          await fetch(app.url + "/v1/jobs/" + id + "/evidence", { headers })
        ).text();
        const expected = {
          chat: sdk.original_chat,
          providerId: "alpha.example.eth",
          profileId: app.profileId,
          jobId: id,
          quoteId: job.payment.quoteId,
          paymentId: job.payment.paymentId,
          output: job.output,
        };
        assert.equal(
          (await checkBuyerEvidenceJson(text, app.pins, expected))
            .originalRequestBound,
          true,
        );
        const stranger = await (
          await fetch(app.url + "/v1/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).json();
        assert.equal(
          (
            await fetch(app.url + "/v1/jobs/" + id + "/evidence", {
              headers: { authorization: "Bearer " + stranger.capability },
            })
          ).status,
          404,
        );
      }
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        [2, 0],
      );
      await fetch(app.url + "/v1/sessions/revoke", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(
        (
          await fetch(app.url + "/v1/jobs/" + sdk.nonstream_job + "/evidence", {
            headers,
          })
        ).status,
        401,
      );
      console.log(
        "FOUNDATION_SDK " +
          JSON.stringify({
            sdk: sdk.sdk_version,
            responseLoss: true,
            sameJob: true,
            nativeSubmissions: 2,
            nonMonetary: true,
            executionClass: "conformance-not-inference",
          }),
      );
    } finally {
      if (proxy) {
        proxy.closeAllConnections();
        await new Promise((ok) => proxy.close(ok));
      }
      await app?.close();
      await fixture?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
