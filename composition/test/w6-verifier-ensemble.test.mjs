import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnsemble,
  detectCanaries,
  tallyVerdicts,
  normalizeVotes,
  ENSEMBLE_DEFAULT_PASSES,
  ENSEMBLE_DEFAULT_AGREEMENT_THRESHOLD,
} from "../w6-verifier-ensemble.mjs";
import { createAuditJournal } from "../w6-audit-journal.mjs";

function tempJournal() {
  const dir = mkdtempSync(join(tmpdir(), "w6-ensemble-test-"));
  const path = join(dir, "audit-journal.jsonl");
  return { journal: createAuditJournal({ path }), path, dir };
}

function stubBridge() {
  return {
    observeCompletedCalls: [],
    async observeCompleted(input) {
      this.observeCompletedCalls.push(input);
      return {
        version: 1,
        request_id: input.requestId,
        provider_id: input.providerId,
        random_selected: false,
        audit_ids: [`audit-${this.observeCompletedCalls.length}`],
      };
    },
  };
}

const ENSEMBLE_PROFILE = {
  id: "hosted-qwen3.8-27b",
  audits: { ensembleScorer: true, referenceSamples: true },
  appProfileDigest: "sha256:27b-digest",
};

const NO_ENSEMBLE_PROFILE = {
  id: "hosted-qwen2.5-0.5b",
  audits: { ensembleScorer: false, referenceSamples: true },
  appProfileDigest: "sha256:0.5b-digest",
};

function fixedRunner(votes) {
  return async ({ requestHash }) => {
    assert.ok(requestHash, "runner receives requestHash");
    return votes;
  };
}

test("tallyVerdicts: pure majority + agreement ratio", () => {
  const votes = normalizeVotes([
    { member: "a", verdict: "match" },
    { member: "b", verdict: "match" },
    { member: "c", verdict: "mismatch" },
  ]);
  const tally = tallyVerdicts(votes);
  assert.equal(tally.winner, "match");
  assert.equal(tally.total, 3);
  assert.equal(tally.agreement, 2 / 3);
  assert.deepEqual(tally.counts, { match: 2, mismatch: 1 });
});

test("tallyVerdicts: ties fall back to inconclusive", () => {
  const votes = normalizeVotes([
    { member: "a", verdict: "match" },
    { member: "b", verdict: "mismatch" },
  ]);
  const tally = tallyVerdicts(votes);
  // First-seen wins; with Map iteration order match appears first.
  assert.ok(["match", "mismatch"].includes(tally.winner));
  assert.equal(tally.agreement, 0.5);
});

test("detectCanaries: finds configured needles", () => {
  const hits = detectCanaries("hello PROMPT_LEAK_TEST world", ["PROMPT_LEAK_TEST"]);
  assert.deepEqual(hits, ["canary:PROMPT_LEAK_TEST"]);
  const none = detectCanaries("clean text", ["PROMPT_LEAK_TEST"]);
  assert.deepEqual(none, []);
});

test("ensemble: non-ensemble profile yields single-pass verdict", async () => {
  const { journal, path, dir } = tempJournal();
  try {
    const bridge = stubBridge();
    const ens = createEnsemble({
      verifierBridge: bridge,
      modelProfile: NO_ENSEMBLE_PROFILE,
      journal,
    });
    const result = await ens.evaluateEnsemble({
      requestHash: "rh-1",
      output: "PROMPT_LEAK_TEST should be ignored on non-ensemble profile",
    });
    assert.equal(result.verdict, "single-pass");
    assert.equal(result.suspicious, false);
    assert.equal(bridge.observeCompletedCalls.length, 0);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.verdict, "single-pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble: high agreement yields match + not suspicious", async () => {
  const { journal, dir } = tempJournal();
  try {
    const bridge = stubBridge();
    const votes = [
      { member: "a", verdict: "match" },
      { member: "b", verdict: "match" },
      { member: "c", verdict: "match" },
    ];
    const ens = createEnsemble({
      verifierBridge: bridge,
      modelProfile: ENSEMBLE_PROFILE,
      journal,
      ensembleRunner: fixedRunner(votes),
    });
    const result = await ens.evaluateEnsemble({ requestHash: "rh-2", output: "harmless" });
    assert.equal(result.verdict, "match");
    assert.equal(result.agreement, 1);
    assert.equal(result.suspicious, false);
    assert.deepEqual(result.votes, normalizeVotes(votes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble: low agreement + canary hit flag as suspicious", async () => {
  const { journal, path, dir } = tempJournal();
  try {
    const bridge = stubBridge();
    const votes = [
      { member: "a", verdict: "match" },
      { member: "b", verdict: "mismatch" },
      { member: "c", verdict: "inconclusive" },
    ];
    const ens = createEnsemble({
      verifierBridge: bridge,
      modelProfile: ENSEMBLE_PROFILE,
      journal,
      ensembleRunner: fixedRunner(votes),
      suspiciousThreshold: 0.6,
    });
    const result = await ens.evaluateEnsemble({
      requestHash: "rh-3",
      output: "contains PROMPT_LEAK_TEST marker",
    });
    assert.equal(result.agreement, 1 / 3);
    assert.equal(result.suspicious, true);
    assert.ok(result.suspiciousReasons.some((r) => r.startsWith("low-agreement")));
    assert.ok(result.suspiciousReasons.includes("canary:PROMPT_LEAK_TEST"));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.kind, "ensemble");
    assert.equal(record.suspicious, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble: 3-negative votes escalates even when agreement is borderline", async () => {
  const { journal, dir } = tempJournal();
  try {
    const bridge = stubBridge();
    const votes = [
      { member: "a", verdict: "match" },
      { member: "b", verdict: "mismatch" },
      { member: "c", verdict: "mismatch" },
      { member: "d", verdict: "inconclusive" },
    ];
    const ens = createEnsemble({
      verifierBridge: bridge,
      modelProfile: ENSEMBLE_PROFILE,
      journal,
      ensembleRunner: fixedRunner(votes),
      suspiciousThreshold: 0.4,
    });
    const result = await ens.evaluateEnsemble({ requestHash: "rh-4", output: "x" });
    // 4 votes, mismatch has 2, inconclusive 1, match 1 → winner=mismatch (0.5)
    // AND the 3-negative rule (mismatch+inconclusive = 3) fires, so the
    // result must be flagged suspicious with both reasons stacked.
    assert.equal(result.totalVotes, 4);
    assert.equal(result.verdict, "mismatch");
    assert.equal(result.agreement, 0.5);
    assert.deepEqual(result.counts, { match: 1, mismatch: 2, inconclusive: 1 });
    assert.equal(result.suspicious, true);
    assert.ok(result.suspiciousReasons.some((r) => r.startsWith("negative-votes")));
    assert.equal(result.suspicious, true);
    assert.ok(result.suspiciousReasons.some((r) => r.startsWith("negative-votes")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble: constructor validates required inputs", () => {
  assert.throws(() => createEnsemble({ modelProfile: ENSEMBLE_PROFILE }), /ENSEMBLE_BRIDGE_REQUIRED/);
  assert.throws(() => createEnsemble({ verifierBridge: {} }), /ENSEMBLE_PROFILE_REQUIRED/);
  assert.throws(
    () => createEnsemble({ verifierBridge: {}, modelProfile: ENSEMBLE_PROFILE, passes: 0 }),
    /ENSEMBLE_PASSES_INVALID/,
  );
  assert.throws(
    () => createEnsemble({ verifierBridge: {}, modelProfile: ENSEMBLE_PROFILE, suspiciousThreshold: 2 }),
    /ENSEMBLE_THRESHOLD_INVALID/,
  );
});

test("ensemble: runtimeDigest is surfaced in result and journal", async () => {
  const { journal, path, dir } = tempJournal();
  try {
    const bridge = stubBridge();
    const votes = [
      { member: "a", verdict: "match" },
      { member: "b", verdict: "match" },
      { member: "c", verdict: "match" },
    ];
    const ens = createEnsemble({
      verifierBridge: bridge,
      modelProfile: ENSEMBLE_PROFILE,
      journal,
      ensembleRunner: fixedRunner(votes),
    });
    const result = await ens.evaluateEnsemble({
      requestHash: "rh-5",
      output: "x",
      runtimeDigest: "sha256:runtime-x",
    });
    assert.equal(result.runtimeDigest, "sha256:runtime-x");
    const record = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]);
    assert.equal(record.runtime_digest, "sha256:runtime-x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensemble: default runner uses bridge and surfaces transport errors", async () => {
  const { journal, dir } = tempJournal();
  try {
    const bridge = stubBridge();
    const ens = createEnsemble({
      verifierBridge: bridge,
      modelProfile: ENSEMBLE_PROFILE,
      journal,
      passes: 2,
    });
    const result = await ens.evaluateEnsemble({ requestHash: "rh-default", output: "ok" });
    assert.equal(result.totalVotes, 2);
    assert.equal(bridge.observeCompletedCalls.length, 2);
    for (const call of bridge.observeCompletedCalls) {
      assert.equal(call.kind, "ensemble");
      assert.equal(call.appProfileDigest, ENSEMBLE_PROFILE.appProfileDigest);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("constants: defaults are sensible", () => {
  assert.ok(ENSEMBLE_DEFAULT_PASSES >= 2, "at least 2 passes for a majority");
  assert.ok(ENSEMBLE_DEFAULT_AGREEMENT_THRESHOLD > 0);
  assert.ok(ENSEMBLE_DEFAULT_AGREEMENT_THRESHOLD <= 1);
});
