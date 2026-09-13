// SPDX-License-Identifier: AGPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordObservation,
  getProviderVerifications,
  listAudits,
  listProviderIds,
  summary,
  resetForTests,
  VERIFICATIONS_CONST,
} from "../../composition/w12-verifications-store.mjs";

test("counter increments on each mismatch and audits after threshold", () => {
  resetForTests();
  const providerId = "service.ethonline-attacker.eth";
  for (let i = 1; i <= VERIFICATIONS_CONST.MISMATCH_THRESHOLD; i++) {
    const r = recordObservation({ providerId, verdict: "mismatch" });
    assert.equal(r.row.mismatchCount, i);
    if (i < VERIFICATIONS_CONST.MISMATCH_THRESHOLD) {
      assert.equal(r.audited, false);
      assert.equal(r.auditId, null);
      assert.match(r.suspicionCounter, new RegExp(`^${i}/${VERIFICATIONS_CONST.MISMATCH_THRESHOLD}$`));
    } else {
      assert.equal(r.audited, true);
      assert.match(r.auditId, /^demo-audit-/);
      assert.match(r.suspicionCounter, /^audited \(/);
    }
  }
  const audits = listAudits(10);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].providerId, providerId);
  assert.equal(audits[0].verdict, "mismatch");
  assert.equal(audits[0].demoOnly, true);
  assert.equal(audits[0].signedBy, "demo-in-memory");
});

test("match verdicts do not advance the suspicion counter", () => {
  resetForTests();
  const providerId = "service.ethonline-node-a.eth";
  for (let i = 0; i < 5; i++) {
    recordObservation({ providerId, verdict: "match" });
  }
  const v = getProviderVerifications(providerId);
  assert.equal(v.matchCount, 5);
  assert.equal(v.mismatchCount, 0);
  assert.equal(v.audited, false);
  assert.equal(v.suspicionCounter, `0/${VERIFICATIONS_CONST.MISMATCH_THRESHOLD}`);
});

test("missing provider returns zeroed record", () => {
  resetForTests();
  const v = getProviderVerifications("service.ethonline-ghost.eth");
  assert.equal(v.totalObservations, 0);
  assert.equal(v.suspicionCounter, `0/${VERIFICATIONS_CONST.MISMATCH_THRESHOLD}`);
  assert.equal(v.demoOnly, true);
  assert.equal(v.audited, false);
});

test("summary reports threshold and demoOnly=true", () => {
  resetForTests();
  const s = summary();
  assert.equal(s.threshold, VERIFICATIONS_CONST.MISMATCH_THRESHOLD);
  assert.equal(s.demoOnly, true);
});

test("invalid verdict throws", () => {
  assert.throws(
    () => recordObservation({ providerId: "x", verdict: "WRONG" }),
    /INVALID_VERDICT/,
  );
  assert.throws(
    () => recordObservation({ verdict: "match" }),
    /PROVIDER_ID_REQUIRED/,
  );
});

test("listAudits is bounded by MAX_AUDITS and limit param", () => {
  resetForTests();
  // 4 providers × 3 mismatches each = 4 audits (one per provider).
  for (let i = 0; i < 12; i++) {
    recordObservation({
      providerId: `provider-${i % 4}.eth`,
      verdict: "mismatch",
    });
  }
  const audits = listAudits(10);
  assert.equal(audits.length, 4);
  assert.equal(listAudits(2).length, 2);
  assert.ok(listProviderIds().length >= 4);
});
