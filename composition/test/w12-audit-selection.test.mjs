// Phase 8 tests — Graph-informed, recomputable audit selection.
//
// These pin the four properties the owner asked for (new providers audited
// more, recently-audited less, chance recovering over time, uptime counted)
// plus the two honesty properties (recomputable draw; explicit unweighted
// label when the Graph is unavailable).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerWeight,
  selectAuditTarget,
  selectionSeed,
  selectionRandom,
  withinBudget,
  SELECTION_METHOD_UNWEIGHTED,
  SELECTION_METHOD_WEIGHTED,
} from "../w12-audit-selection.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_789_300_000_000;

test("new providers carry more audit weight than settled ones", () => {
  const fresh = providerWeight({ receipts: 0, uptimeDays: 1, nowMs: NOW });
  const settled = providerWeight({ receipts: 200, uptimeDays: 1, nowMs: NOW });
  assert.ok(fresh.weight > settled.weight * 2, `fresh ${fresh.weight} should clearly exceed settled ${settled.weight}`);
  assert.equal(fresh.newness, 4);
});

test("recently audited providers are less likely; the penalty decays over time", () => {
  const base = { receipts: 10, uptimeDays: 5, nowMs: NOW };
  const justAudited = providerWeight({ ...base, lastAuditedAtMs: NOW - 60_000 });
  const auditedYesterday = providerWeight({ ...base, lastAuditedAtMs: NOW - DAY });
  const neverAudited = providerWeight({ ...base, lastAuditedAtMs: null });
  assert.ok(justAudited.weight < auditedYesterday.weight, "just audited must be less likely than a day ago");
  assert.ok(auditedYesterday.weight < neverAudited.weight, "penalty must decay, not vanish instantly at t=0");
  assert.ok(justAudited.recencyPenalty > 4.5, "a fresh audit should divide the weight by ~5");
});

test("longer serving time increases cumulative chance; mismatches raise it", () => {
  const young = providerWeight({ receipts: 10, uptimeDays: 1, nowMs: NOW });
  const old = providerWeight({ receipts: 10, uptimeDays: 64, nowMs: NOW });
  assert.ok(old.weight > young.weight, "an older provider should accrue more chance");
  const clean = providerWeight({ receipts: 10, uptimeDays: 5, nowMs: NOW });
  const suspect = providerWeight({ receipts: 10, uptimeDays: 5, mismatches: 3, nowMs: NOW });
  assert.equal(suspect.suspicion, 3);
  assert.ok(suspect.weight > clean.weight);
});

test("the draw is recomputable: same published inputs, same provider", () => {
  const providers = [
    { providerId: "a.eth", receipts: 0, uptimeDays: 2 },
    { providerId: "b.eth", receipts: 50, uptimeDays: 9 },
    { providerId: "c.eth", receipts: 5, mismatches: 1, uptimeDays: 3 },
  ];
  const graph = {
    previousHcsSequenceHash: "sha256:" + "1".repeat(64),
    graphObservationDigest: "sha256:" + "2".repeat(64),
    blockHash: "0x" + "3".repeat(64),
    epoch: 7,
  };
  const first = selectAuditTarget({ providers, graph, nowMs: NOW });
  const second = selectAuditTarget({ providers: [...providers].reverse(), graph, nowMs: NOW });
  assert.equal(first.seed, second.seed, "seed depends only on published inputs, not on iteration order");
  assert.equal(first.selected, second.selected, "same inputs must select the same provider");
  assert.equal(first.method, SELECTION_METHOD_WEIGHTED);
  assert.deepEqual(first.inputs, {
    previousHcsSequenceHash: graph.previousHcsSequenceHash,
    graphObservationDigest: graph.graphObservationDigest,
    blockHash: graph.blockHash,
    epoch: 7,
  });
  // A judge recomputing from the record alone must reach the same seed.
  assert.equal(selectionSeed(first.inputs), first.seed);
});

test("a changed input changes the draw (it is not a constant)", () => {
  const providers = [{ providerId: "a.eth", receipts: 1 }, { providerId: "b.eth", receipts: 1 }];
  const base = { graphObservationDigest: "sha256:" + "a".repeat(64), blockHash: "0x" + "b".repeat(64), epoch: 1 };
  const seeds = new Set();
  for (let i = 0; i < 8; i += 1) {
    const graph = { ...base, blockHash: "0x" + String(i).repeat(64) };
    seeds.add(selectAuditTarget({ providers, graph, nowMs: NOW }).seed);
  }
  assert.equal(seeds.size, 8, "every distinct block hash should produce a distinct seed");
});

test("no Graph inputs ⇒ unweighted, and it says so", () => {
  const result = selectAuditTarget({
    providers: [{ providerId: "a.eth", receipts: 3 }],
    graph: null,
    nowMs: NOW,
  });
  assert.equal(result.method, SELECTION_METHOD_UNWEIGHTED);
  assert.match(result.note, /unweighted/i);
  assert.equal(result.selected, "a.eth", "an unweighted draw must still pick a real candidate");
  assert.equal(result.inputs.blockHash, null);
});

test("the PRNG is uniform enough and deterministic", () => {
  const next = selectionRandom("sha256:" + "f".repeat(64));
  const values = Array.from({ length: 5 }, () => next());
  const again = selectionRandom("sha256:" + "f".repeat(64));
  assert.deepEqual(values, Array.from({ length: 5 }, () => again()));
  const many = Array.from({ length: 400 }, () => next());
  assert.ok(many.every((v) => v >= 0 && v < 1));
  const mean = many.reduce((a, b) => a + b, 0) / many.length;
  assert.ok(mean > 0.35 && mean < 0.65, `mean ${mean} should be near 0.5`);
});

test("audit budget caps a window instead of spending without limit", () => {
  const nowMs = NOW;
  const fresh = withinBudget({ auditTimestampsMs: [nowMs - 60_000, nowMs - 120_000], nowMs });
  assert.equal(fresh.allowed, true);
  const full = withinBudget({
    auditTimestampsMs: [nowMs - 1_000, nowMs - 2_000, nowMs - 3_000],
    nowMs,
  });
  assert.equal(full.allowed, false);
  assert.equal(full.used, 3);
  const stale = withinBudget({
    auditTimestampsMs: [nowMs - 5 * 60 * 60 * 1000, nowMs - 6 * 60 * 60 * 1000, nowMs - 7 * 60 * 60 * 1000],
    nowMs,
  });
  assert.equal(stale.allowed, true, "audits outside the window must not consume budget");
});

test("empty provider set is reported, not fabricated", () => {
  const result = selectAuditTarget({ providers: [], graph: null, nowMs: NOW });
  assert.equal(result.selected, null);
  assert.equal(result.reason, "NO_PROVIDERS");
  assert.deepEqual(result.weights, []);
});
