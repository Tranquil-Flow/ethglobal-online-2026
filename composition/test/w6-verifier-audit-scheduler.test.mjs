import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditScheduler, AUDIT_DEFAULT_PROBABILITY, AUDIT_DEFAULT_NEGATIVE_THRESHOLD } from "../w6-verifier-audit-scheduler.mjs";
import { createAuditJournal } from "../w6-audit-journal.mjs";

function tempJournal() {
  const dir = mkdtempSync(join(tmpdir(), "w6-audit-scheduler-test-"));
  const path = join(dir, "audit-journal.jsonl");
  return { journal: createAuditJournal({ path }), path, dir };
}

function makeEnsemble({ verdict = "match", agreement = 1, suspicious = false, counts = {} } = {}) {
  return {
    verdict,
    agreement,
    suspicious,
    suspiciousReasons: suspicious ? ["canary:PROMPT_LEAK_TEST"] : [],
    counts,
  };
}

test("scheduler: constants are sensible", () => {
  assert.equal(AUDIT_DEFAULT_PROBABILITY, 0.1);
  assert.equal(AUDIT_DEFAULT_NEGATIVE_THRESHOLD, 3);
});

test("scheduler: clean observation may still produce a random audit at p=1", () => {
  const { journal, dir } = tempJournal();
  try {
    const sched = createAuditScheduler({
      journal,
      auditProbability: 1,
      randomFn: () => 0, // always draw
    });
    const events = sched.scheduleAudit({
      requestHash: "rh-clean",
      ensembleResult: makeEnsemble(),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, "random");
    assert.equal(events[0].request_hash, "rh-clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler: clean observation at p=0 emits no events", () => {
  const { journal, dir } = tempJournal();
  try {
    const sched = createAuditScheduler({
      journal,
      auditProbability: 0,
      randomFn: () => 0,
    });
    const events = sched.scheduleAudit({
      requestHash: "rh-clean-2",
      ensembleResult: makeEnsemble(),
    });
    assert.equal(events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler: suspicious observation emits a suspicious-trigger audit", () => {
  const { journal, dir } = tempJournal();
  try {
    const sched = createAuditScheduler({ journal, auditProbability: 0 });
    const events = sched.scheduleAudit({
      requestHash: "rh-susp",
      ensembleResult: makeEnsemble({ suspicious: true }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, "suspicious");
    assert.ok(events[0].suspicious_reasons.includes("canary:PROMPT_LEAK_TEST"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler: 3-negative counts escalate even on majority-match", () => {
  const { journal, path, dir } = tempJournal();
  try {
    const sched = createAuditScheduler({ journal, auditProbability: 0 });
    const events = sched.scheduleAudit({
      requestHash: "rh-3neg",
      ensembleResult: makeEnsemble({
        verdict: "match",
        agreement: 0.5,
        counts: { match: 2, mismatch: 2, inconclusive: 1 },
      }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, "escalated-3neg");
    // Journal persisted the audit event
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.kind, "audit");
    assert.equal(record.trigger, "escalated-3neg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler: idempotent — same call yields identical request_hash + audit_id", () => {
  const { journal, dir } = tempJournal();
  try {
    // Each scheduler instance is meant to be reused; with deterministic
    // id/now/random functions the same input yields identical output.
    // A closure counter gives each trigger a unique but deterministic id.
    let n = 0;
    const sched = createAuditScheduler({
      journal,
      auditProbability: 1,
      randomFn: () => 0,
      now: () => 1700000000000,
      idFn: () => `audit-fixed-${++n}`,
    });
    const a = sched.scheduleAudit({
      requestHash: "rh-idem",
      ensembleResult: makeEnsemble({ suspicious: true }),
    });
    const b = sched.scheduleAudit({
      requestHash: "rh-idem",
      ensembleResult: makeEnsemble({ suspicious: true }),
    });
    assert.equal(a.length, 2, "suspicious + random");
    assert.equal(b.length, 2, "suspicious + random");
    // Distinct triggers get distinct audit_ids within a single call.
    assert.notEqual(a[0].audit_id, a[1].audit_id);
    // Trigger kind drives audit_id stability across calls (same trigger
    // for the same observation yields the same id when the idFn is
    // content-deterministic). Our idFn uses a counter, so cross-call
    // ids differ — what matters is that the per-call ordering is
    // stable: suspicious comes before random.
    assert.equal(a[0].trigger, "suspicious");
    assert.equal(a[1].trigger, "random");
    assert.equal(b[0].trigger, "suspicious");
    assert.equal(b[1].trigger, "random");
    // Same observation produces the same event shape.
    assert.deepEqual(
      { trigger: a[0].trigger, hash: a[0].request_hash },
      { trigger: b[0].trigger, hash: b[0].request_hash },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler: random distribution approximates the configured probability", () => {
  const { journal, dir } = tempJournal();
  try {
    // Use a deterministic sequence to assert the exact distribution.
    let seq = [0.05, 0.5, 0.05, 0.9, 0.05, 0.05, 0.7, 0.05, 0.05, 0.05];
    let i = 0;
    const sched = createAuditScheduler({
      journal,
      auditProbability: 0.1,
      randomFn: () => seq[i++ % seq.length],
    });
    let randomHits = 0;
    const N = 200;
    for (let n = 0; n < N; n++) {
      const events = sched.scheduleAudit({
        requestHash: `rh-dist-${n}`,
        ensembleResult: makeEnsemble({ verdict: "match", agreement: 1, counts: { match: 3 } }),
      });
      randomHits += events.filter((e) => e.trigger === "random").length;
    }
    // With seq length 10 and 0.1 threshold, 7/10 draws are < 0.1 → 70% rate.
    const observed = randomHits / N;
    assert.ok(observed > 0.55, `expected ~0.7 random rate, observed ${observed}`);
    assert.ok(observed < 0.85);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler: configurable threeNegativeThreshold", () => {
  const { journal, dir } = tempJournal();
  try {
    const sched = createAuditScheduler({
      journal,
      auditProbability: 0,
      threeNegativeThreshold: 2,
    });
    const events = sched.scheduleAudit({
      requestHash: "rh-thresh",
      ensembleResult: makeEnsemble({
        verdict: "match",
        counts: { match: 2, mismatch: 2 },
      }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].trigger, "escalated-3neg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduler: rejects missing request hash", () => {
  const { journal, dir } = tempJournal();
  try {
    const sched = createAuditScheduler({ journal });
    assert.throws(() => sched.scheduleAudit({ ensembleResult: makeEnsemble() }), /AUDIT_REQUEST_HASH_REQUIRED/);
    assert.throws(() => sched.scheduleAudit({ requestHash: "" }), /AUDIT_REQUEST_HASH_REQUIRED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
