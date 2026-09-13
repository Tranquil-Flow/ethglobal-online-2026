// SPDX-License-Identifier: AGPL-3.0-or-later
// L-REWARD-SLASH: tests for composition/w6-reward-splitter.mjs
//
// 6 tests: 80/15/5 split, BigInt remainder handling, zero amount,
// max amount, custom policy override, and policy normalization guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePayout,
  normalizePolicy,
  loadPolicy,
  DEFAULT_POLICY,
} from '../w6-reward-splitter.mjs';

const SHARES = { inferenceProviderShare: 0.80, verifierEnsembleShare: 0.15, treasuryShare: 0.05 };

test('splits 100 base units into 80 / 15 / 5', () => {
  const out = computePayout({ amountBaseUnits: 100n, policy: { split: SHARES } });
  assert.equal(out.amountBaseUnits, 100n);
  assert.equal(out.inferenceProviderShare, 80n);
  assert.equal(out.verifierEnsembleShare, 15n);
  assert.equal(out.treasuryShare, 5n);
  assert.equal(
    out.inferenceProviderShare + out.verifierEnsembleShare + out.treasuryShare,
    out.amountBaseUnits,
  );
});

test('remainder from integer division goes to treasury', () => {
  // 1 wei: 0.80 → 0, 0.15 → 0, treasury → 1. Sum MUST equal amount.
  const out = computePayout({ amountBaseUnits: 1n, policy: { split: SHARES } });
  assert.equal(out.amountBaseUnits, 1n);
  assert.equal(out.inferenceProviderShare, 0n);
  assert.equal(out.verifierEnsembleShare, 0n);
  assert.equal(out.treasuryShare, 1n);
  assert.equal(
    out.inferenceProviderShare + out.verifierEnsembleShare + out.treasuryShare,
    1n,
  );

  // 7 wei: 0.80 → 5, 0.15 → 1, treasury → 1. Sum = 7.
  const out2 = computePayout({ amountBaseUnits: 7n, policy: { split: SHARES } });
  assert.equal(out2.inferenceProviderShare + out2.verifierEnsembleShare + out2.treasuryShare, 7n);
});

test('zero amount returns three zero rails', () => {
  const out = computePayout({ amountBaseUnits: 0n, policy: { split: SHARES } });
  assert.equal(out.amountBaseUnits, 0n);
  assert.equal(out.inferenceProviderShare, 0n);
  assert.equal(out.verifierEnsembleShare, 0n);
  assert.equal(out.treasuryShare, 0n);
});

test('large BigInt amount preserves exact 80/15/5 share', () => {
  // 1e24 base units is well within safe-integer * 1e9 range; verifies no
  // precision loss when amount is far beyond 2^53.
  const amount = 1_000_000_000_000_000_000_000_000n; // 1e24
  const out = computePayout({ amountBaseUnits: amount, policy: { split: SHARES } });
  // 80% of 1e24 = 8e23
  assert.equal(out.inferenceProviderShare, 800_000_000_000_000_000_000_000n);
  // 15% of 1e24 = 1.5e23
  assert.equal(out.verifierEnsembleShare, 150_000_000_000_000_000_000_000n);
  // 5% of 1e24 = 5e22
  assert.equal(out.treasuryShare, 50_000_000_000_000_000_000_000n);
  assert.equal(
    out.inferenceProviderShare + out.verifierEnsembleShare + out.treasuryShare,
    amount,
  );
});

test('accepts number and integer-string inputs and normalizes', () => {
  const fromNumber = computePayout({ amountBaseUnits: 1000, policy: { split: SHARES } });
  const fromString = computePayout({ amountBaseUnits: '1000', policy: { split: SHARES } });
  for (const out of [fromNumber, fromString]) {
    assert.equal(out.amountBaseUnits, 1000n);
    assert.equal(
      out.inferenceProviderShare + out.verifierEnsembleShare + out.treasuryShare,
      1000n,
    );
  }
});

test('custom policy override replaces default 80/15/5', () => {
  const custom = {
    split: { inferenceProviderShare: 0.5, verifierEnsembleShare: 0.3, treasuryShare: 0.2 },
    escrow: { escrowHoldPeriodSeconds: 60 },
  };
  const norm = normalizePolicy(custom);
  assert.deepEqual(norm.split, custom.split);
  assert.equal(norm.escrow.escrowHoldPeriodSeconds, 60);

  const out = computePayout({ amountBaseUnits: 100n, policy: custom });
  assert.equal(out.inferenceProviderShare, 50n);
  assert.equal(out.verifierEnsembleShare, 30n);
  assert.equal(out.treasuryShare, 20n);
});

test('policy shares that do not sum to 1.0 throw', () => {
  assert.throws(
    () =>
      normalizePolicy({
        split: { inferenceProviderShare: 0.5, verifierEnsembleShare: 0.4, treasuryShare: 0.0 },
      }),
    /must sum to 1\.0/,
  );
  // Partial policy requires the caller to specify ALL three shares; otherwise
  // the merged policy would not sum to 1.0 (0.9 + 0.15 + 0.05 = 1.10).
  assert.throws(
    () => normalizePolicy({ split: { inferenceProviderShare: 0.9 } }),
    /must sum to 1\.0/,
  );
});

test('loadPolicy falls back to defaults when file missing', async () => {
  const policy = await loadPolicy('/nonexistent/w6-reward-policy.json');
  assert.deepEqual(policy.split, DEFAULT_POLICY.split);
  assert.equal(policy.escrow.escrowHoldPeriodSeconds, 300);
});
