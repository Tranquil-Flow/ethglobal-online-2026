import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  fsyncSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { digestOf } from "../packages/contracts/index.mjs";
import { createVerifierBridge } from "./w6-verifier-bridge.mjs";
import { enqueueObservation } from "./w12-verifications-endpoint.mjs";

/**
 * W12 (demo-only) — classify a completed job's output as `match`,
 * `mismatch`, or `inconclusive` deterministically without contacting the
 * TEE verifier. Used only when W12_DEMO_VERIFIER=1 and the real
 * verifier bridge is unavailable; the malicious provider fixture
 * always returns the literal string `demo attacker`, so any job whose
 * output contains that substring is classified as a mismatch, which
 * drives the suspicion counter in the public viewer.
 *
 * Production code paths ignore this helper entirely.
 */
function classifyDemoOutput(job) {
  const text = String(job?.output?.text ?? "");
  if (!text) return "inconclusive";
  if (/demo attacker/i.test(text)) return "mismatch";
  return "match";
}

// Honest provenance labels attached to every demo-classifier observation.
// They let a recorded per-request verdict become an on-chain assessment
// claim (packages/core `recordVerdictAssessment` via the completion path)
// without ever pretending the demo classifier is a TEE verifier.
export const DEMO_VERIFIER_ID = "demo-classifier";
export const DEMO_VERIFIER_METHOD = "demo-output-classifier-v1";

/**
 * Build the verifier observation boundary for the paid app. A configured local
 * or TEE bridge is used verbatim. Until one is configured, successful-job
 * observations are still durably emitted as privacy-minimized metadata with an
 * explicit unavailable assessment; raw output is never written by this sink.
 */
export function createPaidObservationBridge({ env = process.env, stateDir }) {
  if (env.W6_VERIFIER_TEE_URL || env.W6_VERIFIER_LOCAL_CMD) {
    return createVerifierBridge({ env, stateDir });
  }
  const root = resolve(stateDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, "verified-executor-observations.jsonl");
  if (!existsSync(path)) {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  let closed = false;
  return Object.freeze({
    mode: "observation-only-assessment-unavailable",
    enqueueCompletedJob(job) {
      if (closed) throw new Error("VERIFIER_BRIDGE_CLOSED");
      const record = {
        version: "1",
        kind: "verified-executor-observation",
        requestId: job.requestId,
        providerId: job.providerId,
        profileId: job.profileId,
        executionStatus: job.executionStatus,
        outputDigest: digestOf(job.output),
        assessment: "unavailable",
        observedAt: new Date().toISOString(),
      };
      const fd = openSync(path, "a", 0o600);
      try {
        appendFileSync(fd, JSON.stringify(record) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // W12 (demo-only) — when the W12_DEMO_VERIFIER env flag is set,
      // also classify the observation using the deterministic demo
      // classifier and record it into the in-memory verifications store.
      // This drives the public viewer's suspicion counter. Never used
      // when W6_VERIFIER_TEE_URL / W6_VERIFIER_LOCAL_CMD is configured.
      //
      // The row carries honest demo provenance labels
      // (DEMO_VERIFIER_ID / DEMO_VERIFIER_METHOD) so a completed job's
      // verdict can be published as an on-chain assessment claim by the
      // core completion path without mislabelling the demo classifier.
      let demoVerdict = null;
      if (env.W12_DEMO_VERIFIER === "1") {
        try {
          demoVerdict = classifyDemoOutput(job);
          enqueueObservation({
            providerId: job.providerId,
            verdict: demoVerdict,
            receiptDigest: record.outputDigest,
            requestId: job.requestId,
            verifierId: DEMO_VERIFIER_ID,
            method: DEMO_VERIFIER_METHOD,
          });
        } catch {
          // Demo observation must never fail the served response.
        }
      }
      return Object.freeze({
        enqueued: true,
        completion: Promise.resolve({
          status: "unavailable",
          reason: "verifier-transport-not-configured",
          ...(demoVerdict ? { demoVerdict } : {}),
        }),
      });
    },
    async close() {
      closed = true;
    },
  });
}
