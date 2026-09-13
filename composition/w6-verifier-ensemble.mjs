// Model-specific ensemble runner (Wave C — L-TEE-ENSEMBLE).
//
// Runs a multi-pass ensemble evaluation against the verifier bridge so
// every observed inference is verified by at least N independent scoring
// passes (the "model-specific trained ensemble" called out in
// W6-FINISH-PLAN-2026-09-13.md §1.4). The verdict is produced by
// majority vote across the ensemble members, plus a per-pass agreement
// score that downstream heuristics can use to flag suspicious outputs.
//
// Two profiles from w6-verifier-profiles.json opt into ensemble
// scoring (`audits.ensembleScorer === true`). For other profiles the
// ensemble is a no-op and emits `verdict: "single-pass"` so the
// integration contract is preserved.
//
// Suspicious reasons are surfaced as a list (not a single enum) so the
// audit scheduler can stack them and decide whether to escalate.

const DEFAULT_PASSES = 3;
const DEFAULT_AGREEMENT_THRESHOLD = 0.6;
const DEFAULT_CANARIES = ["PROMPT_LEAK_TEST", "VERIFIER_INJECTION", "BACKDOOR_PAYLOAD"];
const VALID_VERDICTS = new Set(["match", "mismatch", "inconclusive", "single-pass"]);

function normalizeVotes(votes) {
  if (!Array.isArray(votes)) throw new TypeError("ensemble votes must be an array");
  return votes.map((vote, index) => {
    if (!vote || typeof vote !== "object") {
      throw new TypeError(`ensemble vote[${index}] must be an object`);
    }
    const verdict = vote.verdict ?? vote.label;
    if (typeof verdict !== "string") {
      throw new TypeError(`ensemble vote[${index}].verdict must be a string`);
    }
    return {
      member: vote.member ?? `m${index}`,
      verdict,
      score: typeof vote.score === "number" ? vote.score : null,
      notes: vote.notes ?? null,
    };
  });
}

function tallyVerdicts(normalized) {
  const counts = new Map();
  for (const v of normalized) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  let winner = "inconclusive";
  let winnerCount = 0;
  for (const [verdict, count] of counts) {
    if (count > winnerCount) {
      winner = verdict;
      winnerCount = count;
    }
  }
  const total = normalized.length;
  return {
    winner,
    agreement: total === 0 ? 0 : winnerCount / total,
    counts: Object.fromEntries(counts),
    total,
  };
}

function detectCanaries(text, canaries) {
  if (typeof text !== "string" || !text) return [];
  const hits = [];
  for (const needle of canaries) {
    if (typeof needle !== "string" || !needle) continue;
    if (text.includes(needle)) hits.push(`canary:${needle}`);
  }
  return hits;
}

export function createEnsemble({
  verifierBridge,
  modelProfile,
  passes = DEFAULT_PASSES,
  suspiciousThreshold = DEFAULT_AGREEMENT_THRESHOLD,
  canaries = DEFAULT_CANARIES,
  journal,
  ensembleRunner,
} = {}) {
  if (!verifierBridge) {
    throw Object.assign(new Error("ENSEMBLE_BRIDGE_REQUIRED"), { code: "ENSEMBLE_BRIDGE_REQUIRED" });
  }
  if (!modelProfile || typeof modelProfile !== "object") {
    throw Object.assign(new Error("ENSEMBLE_PROFILE_REQUIRED"), { code: "ENSEMBLE_PROFILE_REQUIRED" });
  }
  if (!Number.isInteger(passes) || passes < 1) {
    throw Object.assign(new Error("ENSEMBLE_PASSES_INVALID"), { code: "ENSEMBLE_PASSES_INVALID" });
  }
  if (typeof suspiciousThreshold !== "number" || !(suspiciousThreshold > 0 && suspiciousThreshold <= 1)) {
    throw Object.assign(new Error("ENSEMBLE_THRESHOLD_INVALID"), { code: "ENSEMBLE_THRESHOLD_INVALID" });
  }

  const ensembleEnabled = modelProfile.audits?.ensembleScorer === true;

  async function runEnsembles({ requestHash, output }) {
    if (typeof ensembleRunner === "function") {
      return normalizeVotes(await ensembleRunner({ requestHash, output, passes }));
    }
    // Default runner: re-runs the verifier observation `passes` times and
    // treats each receipt's audit_ids.length > 0 as a positive verdict.
    // Real verifier TEE returns deterministic receipts given identical
    // input, so this surfaces transport-level disagreement only — enough
    // to wire the contract until a model-trained scorer ships.
    const votes = [];
    for (let i = 0; i < passes; i++) {
      try {
        const receipt = await verifierBridge.observeCompleted({
          requestId: `${requestHash}-pass${i}`,
          providerId: modelProfile.providerId ?? "ensemble-pass",
          appProfileDigest: modelProfile.appProfileDigest,
          responseText: output,
          kind: "ensemble",
        });
        votes.push({
          member: `pass-${i}`,
          verdict: receipt.audit_ids?.length ? "match" : "inconclusive",
          score: receipt.audit_ids?.length ?? 0,
          notes: receipt.random_selected ? "random-selected" : null,
        });
      } catch (error) {
        votes.push({
          member: `pass-${i}`,
          verdict: "inconclusive",
          score: 0,
          notes: `error:${error?.code ?? "ENSEMBLE_PASS_FAILED"}`,
        });
      }
    }
    return normalizeVotes(votes);
  }

  async function evaluateEnsemble({ requestHash, output, runtimeDigest }) {
    if (typeof requestHash !== "string" || !requestHash) {
      throw Object.assign(new Error("ENSEMBLE_REQUEST_HASH_REQUIRED"), {
        code: "ENSEMBLE_REQUEST_HASH_REQUIRED",
      });
    }
    const recordedAt = new Date().toISOString();
    if (!ensembleEnabled) {
      const result = {
        verdict: "single-pass",
        agreement: 1,
        sampleRateHit: false,
        suspicious: false,
        suspiciousReasons: [],
        votes: [],
        profileId: modelProfile.id ?? null,
        runtimeDigest: runtimeDigest ?? null,
        requestHash,
        recordedAt,
      };
      journal?.append({
        kind: "ensemble",
        request_hash: requestHash,
        profile_id: result.profileId,
        verdict: result.verdict,
        agreement: result.agreement,
        votes: result.votes,
        suspicious: result.suspicious,
        suspicious_reasons: result.suspiciousReasons,
        runtime_digest: result.runtimeDigest,
      });
      return result;
    }
    const votes = await runEnsembles({ requestHash, output });
    const tally = tallyVerdicts(votes);
    const canaryHits = detectCanaries(output, canaries);
    const suspiciousReasons = [];
    if (tally.agreement < suspiciousThreshold) {
      suspiciousReasons.push(`low-agreement:${tally.agreement.toFixed(3)}<${suspiciousThreshold}`);
    }
    if (canaryHits.length > 0) {
      suspiciousReasons.push(...canaryHits);
    }
    const negativeVotes = (tally.counts.mismatch ?? 0) + (tally.counts["inconclusive"] ?? 0);
    if (negativeVotes >= 3) {
      suspiciousReasons.push(`negative-votes:${negativeVotes}`);
    }
    const result = {
      verdict: VALID_VERDICTS.has(tally.winner) ? tally.winner : "inconclusive",
      agreement: tally.agreement,
      sampleRateHit: false,
      suspicious: suspiciousReasons.length > 0,
      suspiciousReasons,
      votes,
      counts: tally.counts,
      totalVotes: tally.total,
      profileId: modelProfile.id ?? null,
      runtimeDigest: runtimeDigest ?? null,
      requestHash,
      recordedAt,
    };
    journal?.append({
      kind: "ensemble",
      request_hash: requestHash,
      profile_id: result.profileId,
      verdict: result.verdict,
      agreement: result.agreement,
      votes,
      counts: result.counts,
      negative_votes: negativeVotes,
      suspicious: result.suspicious,
      suspicious_reasons: result.suspiciousReasons,
      runtime_digest: result.runtimeDigest,
    });
    return result;
  }

  return Object.freeze({
    evaluateEnsemble,
    profile: modelProfile,
    passes,
    suspiciousThreshold,
    ensembleEnabled,
  });
}

export const ENSEMBLE_DEFAULT_PASSES = DEFAULT_PASSES;
export const ENSEMBLE_DEFAULT_AGREEMENT_THRESHOLD = DEFAULT_AGREEMENT_THRESHOLD;
export const ENSEMBLE_DEFAULT_CANARIES = DEFAULT_CANARIES;
export { detectCanaries, tallyVerdicts, normalizeVotes };
