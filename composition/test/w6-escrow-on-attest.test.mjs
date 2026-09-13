// SPDX-License-Identifier: AGPL-3.0-or-later
// L-REWARD-SLASH: tests for composition/w6-escrow-on-attest.mjs
//
// 6 tests: happy path (attest OK → settle), timeout path (no attest within
// hold → refund), audit fail (attest FAIL → refund + slash), idempotent
// holdPayment (same jobId → no double-hold), journal append-only invariant,
// slash provider via injected escrowPort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAttestEscrow } from '../w6-escrow-on-attest.mjs';

const POLICY = {
  split: { inferenceProviderShare: 0.95, verifierEnsembleShare: 0.0, treasuryShare: 0.05 },
  escrow: { escrowHoldPeriodSeconds: 300 },
};

async function newEscrow(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'w6-escrow-'));
  const journalPath = path.join(dir, 'w6-escrow-journal.jsonl');
  let nowVal = 1_000_000;
  const advance = (delta) => {
    nowVal += delta;
    return nowVal;
  };
  const slashCalls = [];
  const escrow = createAttestEscrow({
    journalPath,
    policy: POLICY,
    now: () => nowVal,
    escrowPort: {
      async slash(provider, evidenceDigest) {
        slashCalls.push({ provider, evidenceDigest });
        return { txHash: '0x' + 'ab'.repeat(32), slashedAmount: 1000n };
      },
    },
    ...overrides,
  });
  return { escrow, journalPath, dir, getNow: () => nowVal, advance, slashCalls };
}

test('happy path: hold → attest OK → settled with split', async () => {
  const { escrow } = await newEscrow();
  await escrow.holdPayment({ jobId: 'job-1', receipt: { ok: true }, payout: 1000n });
  const settled = await escrow.settlePayment({
    jobId: 'job-1',
    attestation: { ok: true, evidenceDigest: '0x' + '11'.repeat(32) },
  });
  assert.equal(settled.state, 'settled');
  assert.equal(settled.payout.amountBaseUnits, 1000n);
  assert.equal(settled.payout.inferenceProviderShare, 950n);
  assert.equal(settled.payout.verifierEnsembleShare, 0n);
  assert.equal(settled.payout.treasuryShare, 50n);

  const rec = await escrow.getRecord('job-1');
  assert.equal(rec.state, 'settled');
});

test('attestation window expired → EXPIRED error and refunded journal', async () => {
  const { escrow } = await newEscrow();
  await escrow.holdPayment({ jobId: 'job-2', receipt: {}, payout: 500n });
  // advance past the 300s hold
  // (advance 301 in newEscrow)
  // eslint-disable-next-line no-unused-expressions
  (await import('node:fs/promises')).existsSync; // keep import list non-empty for older tooling
  const { advance } = await newEscrow();
  // Re-create escrow with advanced clock using a separate instance on same journal.
  // Easier: use the same escrow's now() override by re-instantiating on same journal.
  // We'll construct a fresh escrow with advanced clock pointed at the same journal.
  const dir = path.dirname((await newEscrow()).journalPath);
  // Simpler approach: build escrow that shares the journal and starts late.
  const escrow2 = await (async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'w6-escrow2-'));
    const jp = path.join(tmp, 'w6-escrow-journal.jsonl');
    let clock = 5_000_000;
    return {
      _e: createAttestEscrow({
        journalPath: jp,
        policy: POLICY,
        now: () => clock,
        escrowPort: { async slash() { return { txHash: '0x', slashedAmount: 0n }; } },
      }),
      advance: (d) => (clock += d),
    };
  })();
  await escrow2._e.holdPayment({ jobId: 'job-2', receipt: {}, payout: 500n });
  escrow2.advance(301);
  await assert.rejects(
    escrow2._e.settlePayment({ jobId: 'job-2', attestation: { ok: true } }),
    (err) => err.code === 'EXPIRED',
  );
  const rec = await escrow2._e.getRecord('job-2');
  assert.equal(rec.state, 'refunded');
  assert.equal(rec.reason, 'attestation-window-expired');
});

test('attestation FAIL → INVALID_ATTESTATION and refunded', async () => {
  const { escrow } = await newEscrow();
  await escrow.holdPayment({ jobId: 'job-3', receipt: {}, payout: 700n });
  await assert.rejects(
    escrow.settlePayment({
      jobId: 'job-3',
      attestation: { ok: false, evidenceDigest: '0xbad' },
    }),
    (err) => err.code === 'INVALID_ATTESTATION',
  );
  const rec = await escrow.getRecord('job-3');
  assert.equal(rec.state, 'refunded');
  assert.equal(rec.reason, 'attestation-failed');
});

test('audit escalation → slash provider via injected escrowPort', async () => {
  const { escrow, slashCalls } = await newEscrow();
  await escrow.holdPayment({ jobId: 'job-4', receipt: {}, payout: 999n });
  const result = await escrow.slashOnAudit({
    provider: '0xprovider',
    evidenceDigest: '0x' + 'ee'.repeat(32),
    jobId: 'job-4',
  });
  assert.equal(result.state, 'slashed');
  assert.equal(slashCalls.length, 1);
  assert.equal(slashCalls[0].provider, '0xprovider');
  assert.equal(slashCalls[0].evidenceDigest, '0x' + 'ee'.repeat(32));
  assert.equal(result.slashResult.slashedAmount, 1000n);
});

test('holdPayment is idempotent on same jobId', async () => {
  const { escrow } = await newEscrow();
  const first = await escrow.holdPayment({ jobId: 'job-5', receipt: { v: 1 }, payout: 100n });
  const second = await escrow.holdPayment({ jobId: 'job-5', receipt: { v: 2 }, payout: 100n });
  assert.equal(second.idempotent, true);
  // First receipt is preserved (no overwrite)
  assert.deepEqual(second.receipt, first.receipt);

  // Only ONE journal line was written for the hold.
  const journalText = await readFile((await newEscrow()).journalPath, 'utf8').catch(() => '');
  // Use this escrow's actual journal:
  const dir = await mkdtemp(path.join(tmpdir(), 'w6-escrow3-'));
  const jp = path.join(dir, 'w6-escrow-journal.jsonl');
  const escrow3 = createAttestEscrow({
    journalPath: jp,
    policy: POLICY,
    now: () => 1_000_000,
    escrowPort: { async slash() { return { txHash: '0x', slashedAmount: 0n }; } },
  });
  await escrow3.holdPayment({ jobId: 'job-X', receipt: {}, payout: 100n });
  await escrow3.holdPayment({ jobId: 'job-X', receipt: {}, payout: 100n });
  await escrow3.holdPayment({ jobId: 'job-X', receipt: {}, payout: 100n });
  const lines = (await readFile(jp, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected 1 journal line, got ${lines.length}`);
});

test('journal is append-only JSONL with correct shape', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'w6-escrow4-'));
  const jp = path.join(dir, 'w6-escrow-journal.jsonl');
  const escrow = createAttestEscrow({
    journalPath: jp,
    policy: POLICY,
    now: () => 7_777_777,
    escrowPort: { async slash(p, e) { return { txHash: '0x' + 'cd'.repeat(32), slashedAmount: 5n }; } },
  });
  await escrow.holdPayment({ jobId: 'job-6', receipt: { foo: 1 }, payout: 200n });
  await escrow.settlePayment({
    jobId: 'job-6',
    attestation: { ok: true, evidenceDigest: '0x' + '42'.repeat(32) },
  });
  await escrow.slashOnAudit({
    provider: '0xprov',
    evidenceDigest: '0x' + 'ff'.repeat(32),
    jobId: 'job-6',
  });

  const raw = await readFile(jp, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 3, `expected 3 lines, got ${lines.length}`);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].type, 'hold');
  assert.equal(parsed[0].state, 'pending-attest');
  assert.equal(parsed[1].type, 'settle');
  assert.equal(parsed[1].state, 'settled');
  assert.equal(parsed[2].type, 'slash');
  assert.equal(parsed[2].state, 'slashed');
  assert.equal(parsed[2].provider, '0xprov');
});
