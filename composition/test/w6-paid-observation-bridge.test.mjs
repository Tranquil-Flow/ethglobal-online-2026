import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaidObservationBridge } from "../w6-paid-observation-bridge.mjs";

test("unconfigured verifier still emits privacy-minimized unavailable observations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w6-observation-only-"));
  try {
    const bridge = createPaidObservationBridge({ env: {}, stateDir: dir });
    const result = bridge.enqueueCompletedJob({
      requestId: "job-1",
      providerId: "provider-1",
      profileId: "sha256:" + "a".repeat(64),
      executionStatus: "succeeded",
      output: { text: "private output canary", tokenIds: [1, 2], finishReason: "stop" },
    });
    assert.equal(result.enqueued, true);
    assert.deepEqual(await result.completion, {
      status: "unavailable",
      reason: "verifier-transport-not-configured",
    });
    const retained = readFileSync(join(dir, "verified-executor-observations.jsonl"), "utf8");
    assert.doesNotMatch(retained, /private output canary/);
    const row = JSON.parse(retained);
    assert.equal(row.requestId, "job-1");
    assert.equal(row.assessment, "unavailable");
    assert.match(row.outputDigest, /^sha256:[0-9a-f]{64}$/);
    await bridge.close();
    assert.throws(() => bridge.enqueueCompletedJob({}), /VERIFIER_BRIDGE_CLOSED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
