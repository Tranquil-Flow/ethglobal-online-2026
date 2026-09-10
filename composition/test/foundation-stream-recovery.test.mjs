import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import {
  observe,
  finishHeldCancellation,
} from "./fixtures/v3-cancellation.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import { startWorkbench } from "../workbench.mjs";
test(
  "real OpenAI native partial stream: disconnect, accepted native stop, deadline, completed restart recovery",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "foundation-stream-"));
    let fixture, app;
    try {
      fixture = await startGatewayFixture();
      const runtime = await createMyceliumRuntimeBinding(
        conformanceOptions(fixture.descriptor),
      );
      const config = {
        version: "1",
        mode: "mycelium-v3-conformance",
        accessPolicy: "sponsored-local",
        dataDir: join(dir, "state"),
        port: 0,
        providers: [{ providerId: "alpha.example.eth", amountBaseUnits: "0" }],
      };
      app = await startWorkbench({ config, runtime });
      const session = await (
        await fetch(app.url + "/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      const headers = {
        authorization: "Bearer " + session.capability,
        "content-type": "application/json",
      };
      const models = await (
        await fetch(app.url + "/v1/models", { headers })
      ).json();
      const input = {
        model: models.data[0].id,
        messages: [{ role: "user", content: "synthetic stream lifecycle" }],
        max_tokens: 3,
      };
      const submit = (key, stream) =>
        fetch(app.url + "/v1/chat/completions", {
          method: "POST",
          headers: { ...headers, "idempotency-key": key },
          body: JSON.stringify({ ...input, stream }),
          signal: AbortSignal.timeout(25000),
        });
      await fixture.command("hold");
      const first = await submit("disconnect-cancel", true);
      assert.equal(first.status, 200);
      const cancelledJob = first.headers.get("x-mycelium-job-id");
      const held = await observe(
        fixture,
        "first partial native event",
        (s) => s,
        (s) => s.entered && s.workerHeld,
      );
      assert.ok(held.heldRequestId);
      await first.body.cancel();
      const cancelled = await fetch(
        app.url + "/v1/jobs/" + cancelledJob + "/cancel",
        { method: "POST", headers, body: "{}" },
      );
      assert.equal(cancelled.status, 200);
      const stop = await finishHeldCancellation(fixture, held.heldRequestId);
      assert.equal(stop.cleanup, "confirmed");
      const retry = await submit("disconnect-cancel", true);
      const failed = await retry.text();
      assert.ok(!failed.includes("[DONE]"));
      assert.match(failed, /EXECUTION_CANCELLED/);
      assert.ok(
        (
          await fetch(app.url + "/v1/jobs/" + cancelledJob + "/receipt", {
            headers,
          })
        ).status >= 400,
      );
      await fixture.command("hold");
      const deadline = await submit("native-deadline", true);
      const deadlineJob = deadline.headers.get("x-mycelium-job-id");
      const partial = await deadline.text();
      assert.match(partial, /"error"/);
      assert.ok(!partial.includes("[DONE]"));
      assert.ok(
        (
          await fetch(app.url + "/v1/jobs/" + deadlineJob + "/receipt", {
            headers,
          })
        ).status >= 400,
      );
      await fixture.command("release");
      const completed = await submit("completed-restart", false);
      assert.equal(completed.status, 200);
      const before = await completed.json();
      assert.equal(before.mycelium.execution_verified, false);
      assert.equal(before.choices[0].finish_reason, "length");
      const counts = (await fixture.command("stats")).peers.map(
        (p) => p.submissions,
      );
      assert.deepEqual(counts, [3, 0]);
      await app.close();
      app = undefined;
      app = await startWorkbench({ config, runtime });
      const recovered = await submit("completed-restart", false);
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).id, before.id);
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        counts,
      );
      console.log(
        "FOUNDATION_STREAM " +
          JSON.stringify({
            disconnectRetained: true,
            nativeStopAccepted: true,
            nativeCleanupConfirmed: true,
            partialDeadlineNoReceipt: true,
            completedRestartSameJob: true,
            nativeSubmissions: counts,
            modelExecution: false,
          }),
      );
    } finally {
      await app?.close();
      await fixture?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
