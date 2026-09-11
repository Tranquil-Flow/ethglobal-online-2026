// Actual local Ollama integration, never a fixture substitution. Explicit local
// model approval is required even when this file is discovered by check:all.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { channel } from "node:diagnostics_channel";
import { digestOf } from "../../packages/contracts/index.mjs";
import { createOllamaAdapter } from "../mycelium-adapter-ollama.mjs";
import {
  profileFor,
  configFor,
  requestFor,
  options,
  model,
} from "./fixtures/ollama.mjs";

const endpoint = "http://127.0.0.1:11434";
const privateDir = fileURLToPath(
  new URL("../../../.private/wave5/", import.meta.url),
);
async function metadata(path, body) {
  const response = await fetch(endpoint + path, {
    signal: AbortSignal.timeout(10000),
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  assert.equal(response.status, 200, "LOCAL_OLLAMA_PREFLIGHT_FAILED");
  return response.json();
}
async function unloaded() {
  const deadline = Date.now() + 15000;
  do {
    const state = await metadata("/api/ps");
    if (!state.models.some((x) => x.name === model)) return true;
    await delay(200);
  } while (Date.now() < deadline);
  return false;
}
for (const cancel of [false, true])
  test(
    cancel
      ? "real local qwen2.5:7b abort at 200ms never completes"
      : "real local qwen2.5:7b produces nonempty deltas and one complete raw-prompt output",
    { timeout: 120000 },
    async () => {
      assert.equal(
        process.env.WAVE5_OLLAMA_LIVE_APPROVED,
        "1",
        "Explicit WAVE5_OLLAMA_LIVE_APPROVED=1 required for bounded local model runs",
      );
      await mkdir(privateDir, { recursive: true, mode: 0o700 });
      await chmod(privateDir, 0o700);
      const artifact =
        privateDir + "/step2-live-ollama-" + randomUUID() + ".json";
      const result = {
        status: "failed",
        kind: cancel ? "cancel" : "complete",
        capturedAt: new Date().toISOString(),
        model,
        endpoint,
        raw: true,
        inferenceVerified: false,
        tokenIdsAvailable: false,
        events: [],
      };
      let timer,
        observedGeneration = 0;
      const requestChannel = channel("undici:request:create");
      const observe = ({ request }) => {
        if (request.origin === endpoint && request.path === "/api/generate")
          observedGeneration++;
      };
      try {
        const ps = await metadata("/api/ps");
        assert.equal(
          ps.models.length,
          0,
          "Existing Ollama workload: do not unload or displace it",
        );
        const tags = await metadata("/api/tags");
        const installed = tags.models.find((x) => x.name === model);
        assert.ok(installed, "Approved model absent; no implicit download");
        const shown = await metadata("/api/show", { model });
        assert.equal(shown.details.family, "qwen2");
        assert.equal(shown.details.quantization_level, "Q4_K_M");
        assert.equal(shown.model_info["tokenizer.ggml.add_bos_token"], false);
        const ggufDigest = shown.modelfile.match(/sha256-([0-9a-f]{64})/)?.[1];
        assert.ok(ggufDigest, "GGUF_DIGEST_NOT_REPORTED");
        const { version } = await metadata("/api/version");
        const profile = profileFor({
          manifestDigest: "sha256:" + installed.digest,
          artifactDigest: "sha256:" + ggufDigest,
          version,
        });
        const request = requestFor(profile, {
          nonce: randomBytes(32).toString("hex"),
          prompt: "Continue this short sentence: A peaceful garden has",
          maxOutputTokens: 32,
        });
        result.profile = profile;
        result.profileId = digestOf(profile);
        result.request = request;
        result.policy = options;
        result.identityBasis =
          "Local Ollama-reported manifest/GGUF identifiers; not hardware attestation or independent model verification";
        result.adapterSha256 = createHash("sha256")
          .update(
            await readFile(
              new URL("../mycelium-adapter-ollama.mjs", import.meta.url),
            ),
          )
          .digest("hex");
        const port = createOllamaAdapter(configFor(endpoint, profile));
        await port.validateRequest(request);
        const controller = new AbortController();
        requestChannel.subscribe(observe);
        if (cancel) timer = setTimeout(() => controller.abort(), 200);
        for await (const event of port.execute({
          jobId: randomUUID(),
          request,
          profile,
          signal: controller.signal,
        }))
          result.events.push(event);
        result.generationRequestsCreated = observedGeneration;
        assert.equal(
          observedGeneration,
          1,
          "Exactly one generation attempt; no retries",
        );
        const completions = result.events.filter((e) => e.type === "completed");
        const deltas = result.events.filter((e) => e.type === "delta");
        if (cancel) {
          assert.equal(controller.signal.aborted, true);
          assert.equal(completions.length, 0);
        } else {
          assert.ok(deltas.length > 0);
          assert.equal(completions.length, 1);
          assert.ok(completions[0].output.text.length > 0);
          assert.equal(
            completions[0].output.text,
            deltas.map((d) => d.text).join(""),
          );
          assert.deepEqual(completions[0].output.tokenIds, []);
        }
        result.modelUnloaded = await unloaded();
        assert.equal(
          result.modelUnloaded,
          true,
          "Owned Ollama request did not release its model",
        );
        result.status = "passed";
      } catch (error) {
        result.errorCode = error.code ?? "LIVE_OLLAMA_CHECK_FAILED";
        throw error;
      } finally {
        clearTimeout(timer);
        requestChannel.unsubscribe(observe);
        await writeFile(artifact, JSON.stringify(result, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        console.log(
          JSON.stringify({
            artifact,
            status: result.status,
            kind: result.kind,
            eventCount: result.events.length,
            inferenceVerified: false,
          }),
        );
      }
    },
  );
