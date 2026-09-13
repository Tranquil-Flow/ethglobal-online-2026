# L-ECONOMICS-FORMULA — Stake / Incentive Math for the Verifier Swarm

**Wave:** Wave C — L-TEE-ENSEMBLE / L-STAKE-GATE follow-up
**Status:** Local-ready. Reference implementation in
`composition/w6-economics.mjs`. 36/36 unit tests passing
(`composition/test/w6-economics.test.mjs` + `composition/test/w6-stake-gate.test.mjs`).
**Public-safe:** No keys, no transactions, no private artifacts.

This document derives the three equations that make bad-inference
economically infeasible, shows the worked numbers for both DEMO and
production, and explains how CLI / owner-console can compute the threshold
on demand.

---

## 1. Goal

Two asymmetric incentives:

| Provider type | Per-inference expectation | Status |
| --- | --- | --- |
| **Honest** | profit = `share * price − inference_cost` | positive (provider is paid to do good work) |
| **Dishonest** | profit = `share * price − inference_cost − expected_slash_loss` | negative (cheating is unprofitable in expectation) |

The dishonest case must hold even assuming the cheater **beats the verifier
ensemble** with probability `pBeat` — i.e. the deterrent must survive the
ensemble being fooled.

---

## 2. The three equations

All amounts in base units / wei (BigInt). All probabilities / ratios in
`[0, 1]` (Number, 1e18-fixed-point internally to avoid IEEE-754 drift).

### 2.1 Honest profit per inference

```
honest_profit = share * priceBaseUnits − inferenceCostBaseUnits
```

If positive, honest providers are willing to do the work. If non-positive,
no stake policy can rescue the lane — set the price, share, or cost.

### 2.2 Expected slash loss per inference

```
expected_slash_loss
  = stake * auditProbability * slashRatio * pBeat
```

A dishonest provider loses this much, on average, every time they emit
a bad inference: with probability `auditProbability` an audit fires, with
probability `pBeat` they slipped past the ensemble, and when both hit,
a fraction `slashRatio` of their stake is destroyed.

### 2.3 Economic-infeasibility condition

Providing bad inference is **economically infeasible** iff:

```
(a) honest_profit > 0
(b) honest_profit < expected_slash_loss(stake_required)
```

Equivalently, a rational provider looks at the two expected outcomes and
sees that the dishonest branch dominates the honest branch in expected
loss, so they pick honest.

### 2.4 Required-stake formula

To make the condition above hold with equality margin and a +10% safety
buffer against IEEE-754 / probability drift:

```
lower_bound  = honest_profit / (auditProbability * slashRatio * pBeat)
required     = round_up_to_wei(lower_bound * 1.10)        # +10% safety
```

If `auditProbability * slashRatio * pBeat == 0`, `required = 2^256 − 1`
(impossible to satisfy — a deliberately impossible stake, since no
deterrent can be paid for in expectation).

If `honest_profit <= 0`, `required = 0n` (no need to gate; the lane is
vacuous).

---

## 3. Worked examples

### 3.1 DEMO profile (`hosted-qwen2.5-0.5b`)

```
share              = 0.80
inferencePrice     = 1        tinybar  (  1 base unit)
inferenceCost      = 0        (sponsor covers)
auditProbability   = 0.10
slashRatio         = 0.10
pBeat              = 0.001    (3-verifier ensemble with e=0.1)
```

**Step 1 — honest profit:**
```
0.80 * 1 − 0 = 0n   (truncation; 0.8 × 1 tinybar = 0 tinybar)
```

`honest_profit` is **0** (or effectively non-positive), so the formula
returns `required = 0n`. The DEMO profile does **not** gate on the
formula — it gates on the legacy flat 0.1 ETH dev minimum
(`stakeRequirement`). The sponsor absorbs the slashing risk during DEMO;
that's an explicit owner choice.

### 3.2 PRODUCTION profile (`hosted-qwen3.8-27b`)

```
share              = 0.80
inferencePrice     = 1.0      ETH  (  1e18 wei  = 1000000000000000000)
inferenceCost      = 0.5      ETH  (  5e17 wei  =  500000000000000000)
auditProbability   = 0.50
slashRatio         = 0.10
pBeat              = 0.001
```

**Step 1 — honest profit:**
```
0.80 * 1e18 − 5e17 = 8e17 − 5e17 = 3e17 wei = 0.30 ETH
```

**Step 2 — denominator:**
```
0.50 * 0.10 * 0.001 = 5e-5   →  1e18 fixed-point = 5e13
```

**Step 3 — lower bound:**
```
3e17 * 1e18 / 5e13 = 6e21 wei = 6000 ETH
```

**Step 4 — +10% safety margin:**
```
6000 ETH * 1.10 = 6600 ETH  = 6.6e21 wei = 6_600_000_000_000_000_000_000 wei
```

**Step 5 — check infeasibility:**
```
expected_slash_loss = 6.6e21 * 5e-5 = 3.3e17 wei = 0.33 ETH
0.30 ETH (honest profit) < 0.33 ETH (expected loss) ✓
```

`isEconomicallyInfeasible = TRUE`. A cheater would need to post **6600 ETH**
of stake to slip past the gate, and even then they would, on expectation,
lose **0.33 ETH per inference** — more than their **0.30 ETH honest margin**.

A rational provider prefers honesty.

### 3.3 Comparison table

| Profile | Required stake | Honest margin | Expected loss | Infeasible? |
| --- | ---: | ---: | ---: | :---: |
| DEMO (`qwen2.5-0.5b`) | 0n (formula returns 0) | 0 ETH | 0 ETH | n/a (gates via legacy 0.1 ETH) |
| PRODUCTION (`qwen3.8-27b`) | **6 600 ETH** | 0.30 ETH | 0.33 ETH | **YES** |

---

## 4. CLI / UI exposure

The formula is consumed by `composition/w6-stake-gate.mjs`:

```js
import {
  buildStakeGateFromPolicy,    // async factory
  requiredStakeFromPolicySync, // sync for owner-console / CLI
  normalizePolicy,
} from "./composition/w6-stake-gate.mjs";
import * as economics from "./composition/w6-economics.mjs";

const profile = JSON.parse(profileJson).profiles[1]; // PRODUCTION

// Sync — for the owner-console "what stake does this profile require?" panel:
const stakeWei = requiredStakeFromPolicySync({ profile, economics });
console.log(`Required stake: ${stakeWei} wei  = ${Number(stakeWei)/1e18} ETH`);

// Async — for the verifier-bridge hot path (returns a gate function):
const gate = await buildStakeGateFromPolicy({ profile });
const verdict = await gate(providerIdHex); // { ok, reason, required, actual }
```

The owner-console can render the formula breakdown live (price, cost,
audit%, slash%, pBeat → required stake, honest margin, expected loss,
infeasibility verdict) so judges and providers can audit the math
without reading Solidity.

---

## 5. Honest-provider profit margin analysis

Under the production policy, a provider's **honest** per-inference P&L is:

```
gross_revenue   = share * price = 0.80 * 1.00 ETH = 0.80 ETH
inference_cost  = 0.50 ETH
honest_profit   = 0.30 ETH
```

They are paid 0.80 ETH gross (less 0.05 ETH verifier ensemble + 0.15 ETH
treasury per `w6-reward-policy.json`), keep 0.30 ETH net, and have **zero
expected slash exposure** because they don't cheat. The audit mechanism is
dormant for them.

A dishonest provider keeps the same 0.80 ETH gross, pays the same 0.50 ETH
cost, **but** loses 0.33 ETH in expected slashing — net **−0.03 ETH per
inference**. Even before considering reputation / ban risk, the math
already says "don't do it".

The formula's +10% safety margin ensures the inequality survives IEEE-754
rounding in `1/3 * 1e18`-style sub-1 ratios; without it, a boundary case
at `pBeat = 0.001` could land on exactly zero loss and collapse the
deterrent.

---

## 6. Reference

- Implementation: `composition/w6-economics.mjs`
- Stake gate integration: `composition/w6-stake-gate.mjs`
  (`normalizePolicy`, `buildStakeGateFromPolicy`, `requiredStakeFromPolicySync`)
- Per-profile config: `composition/w6-verifier-profiles.json`
  (`stakeRequirementPolicy` per profile)
- Reward split: `composition/w6-reward-policy.json` (80/15/5)
- Audit scheduler: `composition/w6-verifier-audit-scheduler.mjs`
  (auditProbability + 3-negative escalation trigger)
- Tests: `composition/test/w6-economics.test.mjs` (23 tests),
  `composition/test/w6-stake-gate.test.mjs` (13 tests) — **36 / 36 pass**.
