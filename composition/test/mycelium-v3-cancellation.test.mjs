import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevelopment } from "../index.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import {
  observe,
  finishHeldCancellation,
} from "./fixtures/v3-cancellation.mjs";

for (const synchronize of [false, true]) {
  test(
    `native cancellation: ${synchronize ? "release waits for request-scoped upstream stop" : "local core ACK does not guarantee remote cancellation wins"}`,
    { timeout: 30000 },
    async () => {
      const fixture = await startGatewayFixture();
      const dir = await mkdtemp(join(tmpdir(), "v3-cancel-regression-"));
      let app, completion;
      try {
        const binding = await createMyceliumRuntimeBinding(
          conformanceOptions(fixture.descriptor),
        );
        app = await startDevelopment({
          development: true,
          dataDir: dir,
          port: 0,
          runtimeDefinition: binding,
          providerCatalog: [
            { providerId: "alpha.example.eth", amountBaseUnits: "2" },
          ],
        });
        const client = createClient({
          baseUrl: app.url,
          pins: app.pins,
          paymentAuthorizer: app.authorizeDevelopment,
        });
        await client.connect();
        await fixture.command("hold");
        await fixture.command("hold-cancel");
        const request = await createRequest({
          providerId: "alpha.example.eth",
          profileId: app.profileId,
          prompt: "synthetic cancellation ordering",
          maxOutputTokens: 3,
          seed: 0,
          publishConsent: false,
        });
        const quote = await client.createQuote(request);
        const paid = await client.submitJob({
          request,
          quoteId: quote.quoteId,
          idempotencyKey: "ordered-cancellation",
          authorization: {
            maxAmountBaseUnits: "2",
            network: quote.network,
            asset: quote.asset,
          },
        });
        const held = await observe(
          fixture,
          "native-worker-held",
          (s) => s,
          (s) => s.workerHeld,
        );
        const requestId = held.heldRequestId;
        const local = await client.cancelJob(paid.job.jobId);
        assert.equal(local.executionStatus, "cancelled");
        await observe(
          fixture,
          "cancel-transport-arrived",
          (s) => s.cancelArrived,
          Boolean,
        );
        const before = (await fixture.command("stats")).peers[0].sessions.find(
          (s) => s.requestId === requestId,
        );
        assert.equal(before.stopRequested, false);
        assert.equal(before.terminal, null);
        if (synchronize) {
          completion = finishHeldCancellation(fixture, requestId);
          // Register rejection immediately; on RED still join it in finally.
          completion.catch(() => {});
          // FIFO command stream: the helper's first command precedes this observation.
          const stillHeld = await fixture.command("stats");
          assert.equal(
            stillHeld.workerHeld,
            true,
            "core ACK must not release the native worker before upstream stop",
          );
          await fixture.command("allow-cancel");
          const terminal = await completion;
          assert.equal(terminal.terminal, "cancelled");
          assert.equal(terminal.cleanup, "confirmed");
          assert.equal(terminal.stopRequested, true);
        } else {
          await fixture.command("release");
          const terminal = await observe(
            fixture,
            "completion-wins-before-cancel",
            (s) => s.peers[0].sessions.find((x) => x.requestId === requestId),
            (s) => Boolean(s?.terminal),
          );
          assert.equal(terminal.terminal, "completed");
          assert.equal(terminal.cleanup, "confirmed");
          await fixture.command("allow-cancel");
        }
        assert.equal(
          (await client.getJob(paid.job.jobId)).executionStatus,
          "cancelled",
        );
        await assert.rejects(client.getReceipt(paid.job.jobId));
        const end = await fixture.command("stats");
        assert.deepEqual(
          end.peers.map((p) => p.submissions),
          [1, 0],
        );
        assert.equal(end.peers[0].active, 0);
        console.log(
          JSON.stringify({
            synchronize,
            core: local.executionStatus,
            before,
            terminal: end.peers[0].sessions.find(
              (s) => s.requestId === requestId,
            ),
            submissions: [1, 0],
          }),
        );
      } finally {
        await fixture.command("allow-cancel");
        await fixture.command("release");
        await completion?.catch(() => {});
        await app?.close();
        await fixture.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}
