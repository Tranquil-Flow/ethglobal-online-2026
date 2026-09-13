// SPDX-License-Identifier: AGPL-3.0-or-later
// L-REWARD-SLASH: Pure BigInt reward split for inference payments.
//
// Splits an inference payment into three named shares:
//   * inferenceProviderShare — paid to the provider that served inference
//   * verifierEnsembleShare — paid to the attestation ensemble that verified TEE output
//   * treasuryShare         — protocol treasury (also absorbs integer-division remainder)
//
// Integer-division remainder is allocated to the treasury so the three payouts
// always sum to the original `amountBaseUnits` exactly (no rounding loss).
//
// Pairs with `composition/w6-escrow-on-attest.mjs` (which calls computePayout
// once an attestation lands) and the policy document at
// `composition/w6-reward-policy.json`.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_POLICY_PATH = resolve(__dirname, 'w6-reward-policy.json');

export const DEFAULT_POLICY = Object.freeze({
  split: Object.freeze({
    inferenceProviderShare: 0.80,
    verifierEnsembleShare: 0.15,
    treasuryShare: 0.05,
  }),
  escrow: Object.freeze({ escrowHoldPeriodSeconds: 300 }),
});

/**
 * Load a reward policy from disk. Falls back to DEFAULT_POLICY when the file
 * is absent or malformed — callers can pass the result to computePayout()
 * with no further normalization.
 *
 * @param {string} [path=DEFAULT_POLICY_PATH]
 * @returns {Promise<{split: {inferenceProviderShare:number,verifierEnsembleShare:number,treasuryShare:number},escrow:{escrowHoldPeriodSeconds:number}}>}
 */
export async function loadPolicy(path = DEFAULT_POLICY_PATH) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizePolicy(parsed);
  } catch {
    return DEFAULT_POLICY;
  }
}

/**
 * Normalize a raw policy object, falling back to defaults for any missing
 * field. Throws if the shares do not sum to 1.0 (±1e-9).
 *
 * @param {object} raw
 * @returns {{split:{inferenceProviderShare:number,verifierEnsembleShare:number,treasuryShare:number},escrow:{escrowHoldPeriodSeconds:number}}}
 */
export function normalizePolicy(raw) {
  const split = raw?.split ?? {};
  const norm = {
    inferenceProviderShare:
      typeof split.inferenceProviderShare === 'number'
        ? split.inferenceProviderShare
        : DEFAULT_POLICY.split.inferenceProviderShare,
    verifierEnsembleShare:
      typeof split.verifierEnsembleShare === 'number'
        ? split.verifierEnsembleShare
        : DEFAULT_POLICY.split.verifierEnsembleShare,
    treasuryShare:
      typeof split.treasuryShare === 'number'
        ? split.treasuryShare
        : DEFAULT_POLICY.split.treasuryShare,
  };
  const total = norm.inferenceProviderShare + norm.verifierEnsembleShare + norm.treasuryShare;
  if (Math.abs(total - 1.0) > 1e-9) {
    throw new Error(
      `reward policy shares must sum to 1.0 (got ${total.toFixed(9)}): ` +
        JSON.stringify(norm),
    );
  }
  const escrow = raw?.escrow ?? {};
  const hold =
    typeof escrow.escrowHoldPeriodSeconds === 'number'
      ? escrow.escrowHoldPeriodSeconds
      : DEFAULT_POLICY.escrow.escrowHoldPeriodSeconds;
  return { split: norm, escrow: { escrowHoldPeriodSeconds: hold } };
}

/**
 * Compute the three-rail payout for an inference payment. Returns BigInt
 * base units (e.g. wei-style) so no precision is lost on large values.
 *
 * Integer-division order: provider → verifier → treasury absorbs remainder.
 * This guarantees:
 *     inferenceProviderShare + verifierEnsembleShare + treasuryShare === amountBaseUnits
 * for every non-negative integer amount, including odd splits like 1, 3, 7.
 *
 * @param {{amountBaseUnits:bigint|number|string, policy?:object}} args
 * @returns {{amountBaseUnits:bigint, inferenceProviderShare:bigint, verifierEnsembleShare:bigint, treasuryShare:bigint}}
 */
export function computePayout({ amountBaseUnits, policy = DEFAULT_POLICY } = {}) {
  const norm = normalizePolicy(policy);
  const amount = toBigInt(amountBaseUnits, 'amountBaseUnits');
  if (amount < 0n) {
    throw new Error(`amountBaseUnits must be non-negative (got ${amount})`);
  }
  // Use a 9-decimal fixed point (1e9 = 100%) for share * amount math so we
  // never hit a float in the BigInt path. 1e9 is plenty of headroom for any
  // realistic share ratio and fits easily in a BigInt.
  const SCALE = 1_000_000_000n;
  const providerBps = BigInt(Math.round(norm.split.inferenceProviderShare * 1e9));
  const verifierBps = BigInt(Math.round(norm.split.verifierEnsembleShare * 1e9));
  const treasuryBps = SCALE - providerBps - verifierBps;
  let provider = (amount * providerBps) / SCALE;
  let verifier = (amount * verifierBps) / SCALE;
  let treasury = amount - provider - verifier;
  // Diff sanity: if rounding somehow assigned more than `amount`, clamp
  // (treasury absorbs the diff). This is defensive — should not trigger.
  if (treasury < 0n) {
    treasury = 0n;
    const overflow = -treasury;
    if (provider >= overflow) provider -= overflow;
    else if (verifier >= overflow) verifier -= overflow;
  }
  return {
    amountBaseUnits: amount,
    inferenceProviderShare: provider,
    verifierEnsembleShare: verifier,
    treasuryShare: treasury,
  };
}

function toBigInt(v, name) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${name} must be finite`);
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    if (!/^-?\d+$/.test(v)) throw new Error(`${name} must be an integer string`);
    return BigInt(v);
  }
  throw new Error(`${name} must be bigint, number, or integer string`);
}
