// W12 / Phase 8 — Graph-informed, recomputable audit selection.
//
// Context. `w6-verifier-audit-scheduler.mjs` fires an audit on two hard rules
// (suspicious observation; three-or-more negative votes) and otherwise draws a
// flat `randomFn() < 0.1`. That flat draw is not checkable by anyone: a judge
// cannot tell whether a provider was picked because the dice landed or because
// someone wanted it looked at.
//
// This module supplies the *selection* half only — the weighted, seeded draw —
// and leaves the trigger rules exactly where they are. Both can run together:
// the scheduler still escalates on suspicion and on the three-negative rule;
// this decides who to sample for an independent audit when nothing suspicious
// has happened, and it publishes its inputs so the draw can be recomputed.
//
// OWNER REQUIREMENTS (2026-09-13, verbatim intent):
//   * new providers are audited MORE often, not less;
//   * providers audited recently are LESS likely;
//   * over time the chance of being audited again grows;
//   * total uptime / time served inference must be taken into account.
//
// DESIGN
//   weight(p) = newness * suspicion * maturity / recencyPenalty
//     newness       1 + 3/(1 + receipts)         → ~4 for a brand-new provider, →1 as history builds
//     suspicion     1 + 2*min(1, mismatches/3)   → recent mismatches raise it, capped at 3x
//     maturity      1 + log2(1 + uptimeDays)/4   → long-serving providers accrue cumulative chance
//     recency       1 + 4*exp(-since/HALF_LIFE)  → just-audited divides it by up to 5, decaying
//   P(audit) = min(1, baseProbability * weight)
//
// HONESTY RULES
//   * No Graph inputs ⇒ method "unweighted": the draw still happens, from a
//     documented local seed, and every record says so. We never invent a trust
//     score from missing data.
//   * The seed is a digest over published inputs (previous HCS sequence hash,
//     Graph observation digest, block hash, epoch). Same inputs ⇒ same
//     provider, so a judge can recompute the selection from public data alone.
//   * `weight` is derived only from data the *provider cannot author*: the
//     public subgraph read and the node's own observation record.

import { createHash } from "node:crypto";

export const SELECTION_METHOD_WEIGHTED = "weighted-graph-v1";
export const SELECTION_METHOD_UNWEIGHTED = "unweighted-local-v1";

const DEFAULT_BASE_PROBABILITY = 0.1;
const THRESHOLD = 3;
// Time constants: an audit is "recent" for about a day and then fades.
const RECENCY_HALF_LIFE_MS = 12 * 60 * 60 * 1000;
const MAX_RECENCY_PENALTY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Canonical digest of the draw inputs. Mirrors the workbench's digestOf
 * vocabulary (RFC 8785 canonical JSON of {value}) so there is one digest
 * language end to end.
 */
export function selectionSeed(inputs = {}) {
  const canonical = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  };
  const body = canonical({
    previous_hcs_sequence_hash: inputs.previousHcsSequenceHash ?? null,
    graph_observation_digest: inputs.graphObservationDigest ?? null,
    block_hash: inputs.blockHash ?? null,
    epoch: inputs.epoch ?? 0,
  });
  return "sha256:" + createHash("sha256").update(`{"value":${body}}`).digest("hex");
}

/** Deterministic PRNG (xorshift128+) seeded from the selection seed. */
export function selectionRandom(seed) {
  const hex = String(seed).replace(/^sha256:/, "").slice(0, 32).padEnd(32, "0");
  let s0 = parseInt(hex.slice(0, 8), 16) || 1;
  let s1 = parseInt(hex.slice(8, 16), 16) || 2;
  let s2 = parseInt(hex.slice(16, 24), 16) || 3;
  let s3 = parseInt(hex.slice(24, 32), 16) || 4;
  return function next() {
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    // >>> 0 keeps every step in uint32 space; the sum is a valid [0,1) uniform.
    return ((s0 + s3) >>> 0) / 4294967296;
  };
}

/**
 * Factor table for one provider. Every factor is returned so a judge can see
 * *why* a provider was weighted the way it was, not just the final number.
 */
export function providerWeight({
  receipts = 0,
  mismatches = 0,
  uptimeDays = 0,
  lastAuditedAtMs = null,
  nowMs = Date.now(),
} = {}) {
  const newness = 1 + 3 / (1 + Math.max(0, receipts));
  const suspicion = 1 + 2 * Math.min(1, Math.max(0, mismatches) / THRESHOLD);
  const maturity = 1 + Math.log2(1 + Math.max(0, uptimeDays)) / 4;
  let recency = 1;
  if (Number.isFinite(lastAuditedAtMs)) {
    const since = Math.max(0, nowMs - lastAuditedAtMs);
    recency = 1 + (MAX_RECENCY_PENALTY - 1) * Math.exp(-since / RECENCY_HALF_LIFE_MS);
  }
  const weight = (newness * suspicion * maturity) / recency;
  return {
    newness,
    suspicion,
    maturity,
    recencyPenalty: recency,
    weight,
  };
}

/** Audits per rolling window, so selection cannot spend unbounded credit. */
export function withinBudget({
  auditTimestampsMs = [],
  nowMs = Date.now(),
  windowMs = 60 * 60 * 1000,
  maxPerWindow = 3,
} = {}) {
  const recent = auditTimestampsMs.filter((t) => Number.isFinite(t) && nowMs - t < windowMs);
  return { allowed: recent.length < maxPerWindow, used: recent.length, maxPerWindow, windowMs };
}

/**
 * Build the selection decision.
 *
 * @param {object} args
 * @param {Array} args.providers  [{providerId, receipts, mismatches, uptimeDays, lastAuditedAtMs}]
 * @param {object} [args.graph]   {previousHcsSequenceHash, graphObservationDigest, blockHash, epoch}
 * @param {number} [args.nowMs]
 * @param {number} [args.baseProbability]
 * @param {number} [args.forceProviderIndex] internal: deterministic index override for tests
 */
export function selectAuditTarget({
  providers = [],
  graph = null,
  nowMs = Date.now(),
  baseProbability = DEFAULT_BASE_PROBABILITY,
} = {}) {
  const rows = providers
    .filter((p) => p && typeof p.providerId === "string" && p.providerId)
    .map((p) => {
      const factors = providerWeight({
        receipts: p.receipts ?? 0,
        mismatches: p.mismatches ?? 0,
        uptimeDays: p.uptimeDays ?? 0,
        lastAuditedAtMs: p.lastAuditedAtMs ?? null,
        nowMs,
      });
      return {
        providerId: p.providerId,
        ...factors,
        probability: clamp01(baseProbability * factors.weight),
      };
    })
    .sort((a, b) => (a.providerId < b.providerId ? -1 : 1)); // stable order ⇒ stable draw

  if (!rows.length) {
    return {
      method: graph ? SELECTION_METHOD_WEIGHTED : SELECTION_METHOD_UNWEIGHTED,
      selected: null,
      reason: "NO_PROVIDERS",
      weights: [],
      seed: null,
      inputs: null,
    };
  }

  // A Graph-informed draw is a *recomputable* draw: the seed is derived from
  // published inputs, so anyone with the same inputs lands on the same
  // provider. Without those inputs we still draw, but we label it unweighted
  // and take the seed from the candidates themselves rather than pretending.
  const weighted = Boolean(graph && (graph.graphObservationDigest || graph.previousHcsSequenceHash || graph.blockHash));
  // Both branches carry the SAME key shape, with explicit nulls where the
  // input genuinely did not exist. A consumer must be able to tell "there was
  // no block hash" from "this record forgot to include it".
  const inputs = {
    previousHcsSequenceHash: weighted ? graph.previousHcsSequenceHash ?? null : null,
    graphObservationDigest: weighted ? graph.graphObservationDigest ?? null : null,
    blockHash: weighted ? graph.blockHash ?? null : null,
    epoch: graph?.epoch ?? 0,
    ...(weighted ? {} : { candidates: rows.map((r) => r.providerId) }),
  };
  const seed = selectionSeed(weighted ? inputs : { epoch: inputs.epoch, block_hash: null });
  const next = selectionRandom(seed);

  const total = rows.reduce((sum, r) => sum + r.weight, 0);
  const roll = next() * total;
  let acc = 0;
  let selected = rows[rows.length - 1];
  for (const row of rows) {
    acc += row.weight;
    if (roll < acc) {
      selected = row;
      break;
    }
  }

  return {
    method: weighted ? SELECTION_METHOD_WEIGHTED : SELECTION_METHOD_UNWEIGHTED,
    selected: selected.providerId,
    selectedProbability: selected.probability,
    weights: rows,
    seed,
    inputs,
    roll,
    totalWeight: total,
    note: weighted
      ? "Weighted by public Graph history; recompute the seed from the published inputs to verify the draw."
      : "No Graph inputs were available, so this draw is labelled unweighted: it used the candidate list only and claims no trust weighting.",
  };
}
