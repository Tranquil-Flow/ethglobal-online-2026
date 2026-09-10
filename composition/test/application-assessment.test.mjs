import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import { setup } from "./fixtures/application.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";

test("replaceable provider-scoped checker lifecycle is append-only, bounded, and never reruns inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-assessment-"));
  let app;
  try {
    const f = setup(dir);
    let calls = 0,
      outcome = "passed",
      release,
      waiting,
      aborted = false;
    const reached = () =>
      new Promise((r) => {
        waiting = r;
      });
    for (const [i, b] of f.bindings.providers.entries()) {
      const create = b.runtime.create;
      b.runtime.create = (context) => ({
        ...create(context),
        assessor: {
          mode: "development",
          method: "fixture-method-" + i,
          verifierId: "fixture-checker-" + i,
          async assess({ receipt, profile, evidenceRef, signal }) {
            const callId = ++calls,
              callbackOutcome = outcome;
            const privateEvidence = await context.loadEvidence(evidenceRef);
            assert.equal(privateEvidence.request.providerId, b.providerId);
            assert.equal(
              digestOf(privateEvidence.output),
              receipt.payload.outputHash,
            );
            if (callbackOutcome === "delayed") {
              waiting?.();
              await new Promise((r) => {
                release = r;
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    r();
                  },
                  { once: true },
                );
              });
            }
            if (callbackOutcome === "throw")
              throw Error("private detail never returned");
            const a = {
              version: "1",
              assessmentId: "fixture-" + callId,
              receiptDigest: digestOf(receipt),
              method: "fixture-method-" + i,
              verifierId: "fixture-checker-" + i,
              profileId: digestOf(profile),
              outcome: [
                "delayed",
                "malformed",
                "wrong-profile",
                "wrong-checker",
                "missing-evidence",
              ].includes(callbackOutcome)
                ? "passed"
                : callbackOutcome,
              mode: "development",
              createdAt: new Date().toISOString(),
              evidenceDigest: digestOf("fixture-not-proof"),
            };
            if (callbackOutcome === "malformed")
              a.receiptDigest = digestOf("wrong-output");
            if (callbackOutcome === "wrong-profile")
              a.profileId = digestOf("other-profile");
            if (callbackOutcome === "wrong-checker")
              a.verifierId = "other-checker";
            if (callbackOutcome === "missing-evidence") delete a.evidenceDigest;
            return a;
          },
        },
      });
    }
    f.config.core.portTimeoutMs = 150;
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
    const client = createClient({ baseUrl: app.url });
    await client.connect();
    const p = f.providers[1],
      request = await createRequest({
        providerId: p.providerId,
        profileId: p.profileIds[0],
        prompt: "public lifecycle fixture",
        maxOutputTokens: 2,
        seed: 0,
      });
    const q = await client.createQuote(request),
      accepted = await client.submitJob({
        request,
        quoteId: q.quoteId,
        idempotencyKey: "one",
        authorization: {
          maxAmountBaseUnits: "0",
          network: q.network,
          asset: q.asset,
        },
      });
    const id = accepted.job.jobId;
    for await (const e of client.streamJob(id)) {
    }
    const receipt = await client.getReceipt(id),
      original = JSON.stringify(receipt);
    const cfg = await (await fetch(app.url + "/config.json")).json();
    assert.equal(cfg.assessment, "configured-observations-not-proof");
    assert.equal(
      (await client.createAssessment(id, "fixture-method-0", "wrong-provider"))
        .outcome,
      "unavailable",
    );
    assert.equal(calls, 0);
    for (const state of [
      "passed",
      "mismatch",
      "inconclusive",
      "pending",
      "malformed",
      "wrong-profile",
      "wrong-checker",
      "missing-evidence",
      "throw",
    ]) {
      outcome = state;
      const a = await client.createAssessment(id, "fixture-method-1", state);
      assert.equal(
        a.outcome,
        [
          "malformed",
          "wrong-profile",
          "wrong-checker",
          "missing-evidence",
          "throw",
        ].includes(state)
          ? "unavailable"
          : state,
      );
    }
    outcome = "delayed";
    const entered = reached();
    const first = client.createAssessment(id, "fixture-method-1", "repeat");
    await entered;
    const second = client.createAssessment(id, "fixture-method-1", "repeat");
    release();
    assert.deepEqual(await first, await second);
    outcome = "delayed";
    const a = await client.createAssessment(id, "fixture-method-1", "timeout");
    assert.equal(a.outcome, "unavailable");
    assert.equal(aborted, true);
    assert.equal(JSON.stringify(await client.getReceipt(id)), original);
    assert.deepEqual(f.counts, [0, 1]);
    // Per-job serialization prevents response reordering from replacing observations.
    outcome = "delayed";
    const olderEntered = reached();
    const older = client.createAssessment(id, "fixture-method-1", "older");
    await olderEntered;
    const releaseOlder = release;
    outcome = "mismatch";
    const newerPending = client.createAssessment(
      id,
      "fixture-method-1",
      "newer",
    );
    releaseOlder();
    const oldResult = await older,
      newer = await newerPending;
    assert.equal(oldResult.outcome, "passed");
    assert.equal(newer.outcome, "mismatch");
    assert.notEqual(oldResult.assessmentId, newer.assessmentId);
    const history = await client.listAssessments(id);
    assert.equal(history.length, 14);
    const port = Number(new URL(app.url).port);
    await app.close();
    f.config.port = port;
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
    assert.deepEqual(await client.listAssessments(id), history);
    assert.deepEqual(f.counts, [0, 1]);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
