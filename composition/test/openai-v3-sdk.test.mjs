import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import { startWorkbench } from "../workbench.mjs";
import { verifyEvidence } from "../../packages/core/src/receipts.mjs";

test(
  "ordinary OpenAI Python SDK traverses composed v3 gateway, x402 challenge, receipt and independent replay",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "openai-v3-sdk-"));
    let fixture, app;
    try {
      fixture = await startGatewayFixture();
      const runtime = await createMyceliumRuntimeBinding(
        conformanceOptions(fixture.descriptor),
      );
      app = await startWorkbench({
        config: {
          version: "1",
          mode: "mycelium-v3-conformance",
          dataDir: join(dir, "state"),
          port: 0,
          providers: [
            { providerId: "alpha.example.eth", amountBaseUnits: "2" },
          ],
        },
        runtime,
      });
      const session = await fetch(app.url + "/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(session.status, 201);
      const { capability } = await session.json();
      const sdk = await new Promise((resolve, reject) => {
        const child = spawn(
          process.env.C_UC1_PYTHON || "python3",
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
          if (code !== 0) reject(Error(`SDK failed ${code}: ${err}`));
          else {
            try {
              resolve(JSON.parse(out));
            } catch (e) {
              reject(e);
            }
          }
        });
        child.stdin.end(JSON.stringify({ origin: app.url, capability }));
      });
      assert.equal(sdk.sdk_recovery_same_job, true);
      const headers = { authorization: "Bearer " + capability };
      for (const id of [sdk.nonstream_job, sdk.stream_job]) {
        const r = await fetch(`${app.url}/v1/jobs/${id}/evidence`, { headers });
        assert.equal(r.status, 200);
        const bundle = await r.json();
        verifyEvidence(bundle, {
          trustedKeys: { [app.pins.keyId]: app.pins.publicKeyJwk },
          maxBytes: 2097152,
        });
        assert.equal(bundle.output.text, "é🌙");
        assert.deepEqual(bundle.output.tokenIds, [101, 102, 103]);
        assert.equal(bundle.request.profileId, app.profileId);
      }
      const { replayMethod } = await (
        await fetch(app.url + "/config.json")
      ).json();
      const a = await fetch(
        `${app.url}/v1/jobs/${sdk.nonstream_job}/assessments`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
            "idempotency-key": "sdk-native-replay",
          },
          body: JSON.stringify({ method: replayMethod }),
        },
      );
      assert.equal(a.status, 202);
      const assessment = await a.json();
      assert.equal(assessment.outcome, "passed");
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        [2, 1],
      );
      const { original_chat: _privateOriginal, ...safeSdk } = sdk;
      const record = {
        ...safeSdk,
        receipt_verified: true,
        assessment: {
          outcome: assessment.outcome,
          method: assessment.method,
          mode: assessment.mode,
        },
        native_submissions: [2, 1],
      };
      console.log("OPENAI_SDK_EVIDENCE " + JSON.stringify(record));
    } finally {
      try {
        if (app) await app.close();
      } finally {
        try {
          if (fixture) await fixture.close();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  },
);
