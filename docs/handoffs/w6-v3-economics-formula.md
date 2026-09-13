# L-ECONOMICS-FORMULA v3 — Dynamic Per-Provider-Set-Price + Rolling-Earnings Stake Floor

**Wave:** Wave C — L-ECONOMICS-DYNAMIC-STAKE follow-up to L-ECONOMICS-FORMULA
**Status:** Local-ready. Reference implementation in
`composition/w6-economics.mjs`. 56/56 unit tests passing
(42 in `composition/test/w6-economics.test.mjs` +
14 in `composition/test/w6-stake-gate.test.mjs`).
**Public-safe:** No keys, no transactions, no private artifacts.

This document derives the three equations that make bad-inference
economically infeasible under the v3 dynamic model (Hedera tinybar, providers
set their own price, required stake scales with both price AND recent
earnings), shows five worked examples covering new / busy / gaming / premium
providers, and explains how CLI / owner-console can compute the threshold on
demand.

---

## 1. Goal — v3 changes from v2

Owner feedback driving v3:

> "the stake amount should also maybe depend on how much inference is earning
> the provider right? If they set the inference price themselves it should be
> dynamic I think?"

v3 adds two things:

1. **Hedera tinybar native** — currency is tinybar (1 HBAR = 1e8 tinybar), not
   ETH/wei. All formula inputs/outputs use tinybar BigInt.
2. **Dynamic per-provider-set-price + rolling-earnings floor** — providers
   can set ANY `inferencePriceBaseUnits`; the required stake scales with both
   the price and the provider's recent rolling earnings.

```
requiredStake = max(
    requiredStakeTheory(price, cost, auditProb, slashRatio, pBeat),
    rollingEarnings * slashingRatePerDay,
    theoreticalFloorBaseUnits (default 2 HBAR)
)
```

The `share` parameter is **removed** from the formula because the reward
splitter (`composition/w6-reward-splitter.mjs`, provider=0.95 / ensemble=0.0
/ treasury=0.05) already handles the provider's effective revenue share. The
formula now uses the gross price directly: `honest_profit = price − cost`.

---

## 2. The three equations (v3)

All amounts in tinybar BigInt. All probabilities / ratios in `[0, 1]`
(Number, 1e18-fixed-point internally to avoid IEEE-754 drift).

### 2.1 Honest profit per inference

```
honest_profit = priceBaseUnits − inferenceCostBaseUnits
```

Positive ⇒ honest providers willing to do the work. Non-positive ⇒ no
stake policy can rescue the lane.

### 2.2 Expected slash loss per inference

```
expected_slash_loss = stake * auditProbability * slashRatio * pBeat
```

The dishonest provider loses this much, on average, every time they emit a
bad inference.

### 2.3 Required stake — game-theoretic floor

```
lower_bound = honest_profit / (auditProbability * slashRatio * pBeat)
required_stake_theory = round_up_to_tinybar(lower_bound * 1.10)   # +10% safety
```

If `auditProbability * slashRatio * pBeat == 0`, returns `2^256 − 1`
(impossible to satisfy).
If `honest_profit <= 0`, returns `0n`.

### 2.4 Earnings-based dynamic floor

```
required_stake_earnings = rollingEarningsBaseUnits * slashingRatePerDay
```

`rollingEarningsBaseUnits` comes from the receipt publisher's stored
payments to this provider over the lookback window (default 30d).
`slashingRatePerDay` defaults to `0.10` (10% of recent earnings).

### 2.5 Combined required stake

```
required_stake = max(theoretical_floor,
                     rolling_earnings * slashing_rate,
                     required_stake_theory)
```

`theoretical_floor` defaults to **2 HBAR** (2e8 tinybar). This is the floor
applied to *every* provider regardless of price or earnings — it prevents
adversaries from gaming the system with a zero-price profile and zero
earnings.

### 2.6 Cumulative slash cap

```
cumulative_slash = min(stake * slashPerStrike * totalStrikes, stake)
```

Total slash is capped at the stake amount. A cheater can never be slashed
into the negative. Default `slashPerStrike = 0.10`, `maxTotalSlashRatio = 1.0`.

---

## 3. Why dynamic per-provider-set-price?

Providers set their own `inferencePriceBaseUnits`. This is honest —
the provider is pricing their own compute cost and they should be free to
charge what they want. The formula auto-scales:

- **Premium price** (e.g. 10 HBAR): the theoretical floor scales up
  proportionally because the dishonest gross margin scales up.
- **Cheap price** (e.g. 1 tinybar): the theoretical floor shrinks to ~0,
  BUT the earnings floor still pulls the stake up if the provider is busy.

A rational provider who wants to minimize their stake can either:
- Set a low price AND keep low earnings (new provider, theoretical floor only).
- Set a high price and accept the higher stake requirement (because the
  expected dishonest loss also goes up — the formula is self-consistent).

---

## 4. Why the rolling-earnings floor?

A naive formula-only floor has a known attack: a busy cheater can game the
price down to 1 tinybar, post only the theoretical floor (~2 HBAR), and
pocket the difference between real revenue and slashed stake.

v3 closes this hole with `rollingEarnings * slashingRatePerDay`:

- A provider with **0 HBAR/day earnings** (new provider) gets the theoretical
  floor only (~2 HBAR).
- A provider with **100 HBAR/day** rolling earnings needs to post at least
  **10 HBAR** (10% of earnings) regardless of their price.
- A provider with **1000 HBAR/day** needs to post **100 HBAR**.

The 10% rate is conservative — it matches the `slashPerStrike` value, so
one strike on a busy provider already costs them 10% of their recent
earnings. Multiple strikes cumulate up to 100% of stake (cumulative cap).

---

## 5. Worked examples

All amounts in tinybar (1 HBAR = 1e8 tinybar).

### 5.1 Provider A — DEMO new provider

```
inferencePrice        = 1         tinybar
inferenceCost         = 0         (sponsor covers)
auditProbability      = 0.15      (0.10 random + 0.05 escalated)
slashRatio            = 0.10
pBeat                 = 0.001
rollingEarnings(30d)  = 0         (new provider, no history)
slashingRatePerDay    = 0.10
theoreticalFloor      = 200_000_000  tinybar (2 HBAR)
```

**Step 1 — theory:**
```
grossMargin = 1 − 0 = 1 tinybar
lowerBound = 1 * 1e18 / 1.5e13 = 6.666...e4 tinybar ≈ 0.000666 HBAR
*1.10 ≈ 7.333e4 tinybar ≈ 0.000733 HBAR
```

**Step 2 — earnings floor:**
```
0 * 0.10 = 0 tinybar
```

**Step 3 — combined:**
```
requiredStake = max(7.333e4, 0, 2e8) = 2e8 tinybar = 2 HBAR
```

**Verdict:** Provider A must post **2 HBAR** (theoretical floor only).

### 5.2 Provider B — PRODUCTION new provider

```
inferencePrice        = 100_000_000  tinybar (1 HBAR)
inferenceCost         = 50_000_000   tinybar (0.5 HBAR)
auditProbability      = 0.15
slashRatio            = 0.10
pBeat                 = 0.001
rollingEarnings(30d)  = 0
slashingRatePerDay    = 0.10
theoreticalFloor      = 200_000_000  tinybar (2 HBAR)
```

**Step 1 — theory:**
```
grossMargin = 5e7 tinybar (0.5 HBAR)
lowerBound = 5e7 * 1e18 / 1.5e13 = 3.333e12 tinybar (3333 HBAR)
*1.10 = 3.666e12 tinybar ≈ 3666 HBAR
```

**Step 2 — earnings floor:**
```
0 * 0.10 = 0
```

**Step 3 — combined:**
```
requiredStake = max(3.666e12, 0, 2e8) ≈ 3666 HBAR
```

**Verdict:** Provider B must post **~3666 HBAR** (theoretical floor for the
production price/cost profile dominates).

### 5.3 Provider C — PRODUCTION busy provider (100 HBAR/day)

```
inferencePrice        = 100_000_000  tinybar (1 HBAR)
inferenceCost         = 50_000_000   tinybar (0.5 HBAR)
auditProbability      = 0.15
slashRatio            = 0.10
pBeat                 = 0.001
rollingEarnings(30d)  = 10_000_000_000  tinybar (100 HBAR/day * ~30d → ~3000 HBAR)
slashingRatePerDay    = 0.10
```

For earnings to dominate over the theoretical floor (~3666 HBAR), the
rolling earnings must exceed ~36660 HBAR (≈ 10% rate). A provider at
**100 HBAR/day sustained** has ~3000 HBAR rolling — below the theoretical
floor. Earnings floor = 300 HBAR (10%). Theory still wins at 3666 HBAR.

For a provider earning **1000 HBAR/day** (~30000 HBAR rolling), the
earnings floor becomes **3000 HBAR** — still below theory.

For a provider earning **10000 HBAR/day** (~300000 HBAR rolling), the
earnings floor becomes **30000 HBAR** and dominates.

**Verdict:** Earnings floor dominates the theoretical floor when
`rollingEarnings > 36660 HBAR`. Below that threshold, theory wins.

### 5.4 Provider D — GAMING provider (1 tinybar price, 100 HBAR/day earnings)

```
inferencePrice        = 1         tinybar (slash-hedge attempt)
inferenceCost         = 0
auditProbability      = 0.15
slashRatio            = 0.10
pBeat                 = 0.001
rollingEarnings(30d)  = 10_000_000_000  tinybar (100 HBAR/day)
```

**Step 1 — theory:**
```
grossMargin = 1 * 0.5 = 0 (truncated); theory = 0n
```

**Step 2 — earnings floor:**
```
10_000_000_000 * 0.10 = 1_000_000_000 tinybar = 10 HBAR
```

**Step 3 — combined:**
```
requiredStake = max(0, 1e9, 2e8) = 1e9 tinybar = 10 HBAR
```

**Verdict:** Provider D must post **10 HBAR** despite the 1-tinybar price.
The earnings floor catches the slash-hedge attempt — **the price doesn't
help when earnings are high**. This is the core v3 security property.

### 5.5 Provider E — PREMIUM new provider (10 HBAR price)

```
inferencePrice        = 1_000_000_000  tinybar (10 HBAR)
inferenceCost         = 500_000_000    tinybar (5 HBAR)
auditProbability      = 0.15
slashRatio            = 0.10
pBeat                 = 0.001
rollingEarnings(30d)  = 0
slashingRatePerDay    = 0.10
```

**Step 1 — theory:**
```
grossMargin = 5e8 tinybar (5 HBAR)
lowerBound = 5e8 * 1e18 / 1.5e13 = 3.333e13 tinybar (33,333 HBAR)
*1.10 = 3.666e13 tinybar ≈ 36,666 HBAR
```

**Step 2 — earnings floor:**
```
0 * 0.10 = 0
```

**Step 3 — combined:**
```
requiredStake = max(3.666e13, 0, 2e8) ≈ 36,666 HBAR
```

**Verdict:** Provider E must post **~36,666 HBAR** — the theoretical floor
scales with the premium price. Premium providers face premium stake
requirements, which is the correct economic signal.

---

## 6. Comparison table

| Provider | Price | Earnings (30d) | Required stake | Dominant floor |
| --- | ---: | ---: | ---: | :--- |
| A — DEMO new | 1 tinybar | 0 | **2 HBAR** | theoretical floor |
| B — PROD new | 1 HBAR | 0 | **~3,666 HBAR** | theory |
| C — PROD busy | 1 HBAR | 3,000 HBAR | **~3,666 HBAR** | theory (earnings below threshold) |
| D — Gaming | 1 tinybar | 3,000 HBAR | **~300 HBAR** | earnings floor |
| E — Premium | 10 HBAR | 0 | **~36,666 HBAR** | theory |

**Key insight:** the formula self-regulates — busy gaming providers get
caught by the earnings floor, premium honest providers face proportionally
higher stakes, and new honest providers pay only the small theoretical floor.

---

## 7. Honest provider profit per inference

```
honest_profit = priceBaseUnits − inferenceCostBaseUnits
```

**PRODUCTION example** (1 HBAR price, 0.5 HBAR cost):
```
honest_profit = 1e8 − 5e7 = 5e7 tinybar = 0.5 HBAR per inference
```

The reward splitter then takes 20% (0.10 to verifier ensemble, 0.05 to
treasury, 0.05 to incentive pool), leaving the provider with **0.40 HBAR
net** per inference. This is positive — honest providers are paid to do
good work.

**Dishonest expected loss** at the required ~3666 HBAR stake:
```
expected_loss = 3666 HBAR * 0.15 * 0.10 * 0.001
             = 3666 * 0.000015 HBAR = 0.05499 HBAR per inference
```

The dishonest provider loses 0.055 HBAR per inference (in expectation)
versus gaining 0.40 HBAR (honest). **Rational providers choose honesty.**

---

## 8. CLI / UI exposure

The formula is consumed by `composition/w6-stake-gate.mjs`:

```js
import {
  buildStakeGateFromPolicy,    // async factory (reads rolling earnings)
  requiredStakeFromPolicySync, // sync for owner-console / CLI
  normalizePolicy,
  DEFAULT_MIN_STAKE_TINYBAR,   // 200000000 = 2 HBAR
} from "./composition/w6-stake-gate.mjs";
import * as economics from "./composition/w6-economics.mjs";

// Async — for the verifier-bridge hot path:
const gate = await buildStakeGateFromPolicy({
  profile,
  providerId,
  paymentStore,                  // receipt publisher's stored payments
});
const verdict = await gate(providerIdHex);

// Sync — for the owner-console "what stake does this profile require?" panel:
const stakeTinybar = requiredStakeFromPolicySync({ profile, economics });
```

The owner-console can render the formula breakdown live (price, cost,
audit%, slash%, pBeat, rolling earnings, slashing rate) and show the
combined `max(theory, earnings, floor)` result with HBAR formatting via
`hbarFromTinybar()`.

---

## 9. Migration checklist (v2 → v3)

- [x] Currency switched from ETH/wei to Hedera tinybar (1 HBAR = 1e8 tinybar).
- [x] `share` parameter removed (splitter handles provider share).
- [x] `requiredStake` takes MAX of three floors.
- [x] `cumulativeSlashCap` added (cumulative strike cap).
- [x] `tinybarFromHbar` / `hbarFromTinybar` helpers added.
- [x] `TINYBAR_PER_HBAR = 100_000_000n` constant exported.
- [x] `resolveRollingEarnings()` reads from payment store.
- [x] `w6-stake-gate.mjs` reads `paymentStore + providerId` for dynamic floor.
- [x] `DEFAULT_MIN_STAKE_WEI` replaced with `DEFAULT_MIN_STAKE_TINYBAR` (2 HBAR).
- [x] `w6-verifier-profiles.json` v3: tinybar amounts, `auditProbability=0.15`,
      `slashingRatePerDay`, `lookbackDays`, `theoreticalFloorBaseUnits`.
- [x] 56/56 unit tests passing.

---

## 10. References

- `composition/w6-economics.mjs` — formula implementation
- `composition/w6-stake-gate.mjs` — gate factory + profile resolver
- `composition/w6-reward-splitter.mjs` — 95/0/5 split (handles provider share; L-REWARD-95-5: TEE/ensemble operated by protocol/treasury)
- `composition/w6-fanout-wiring.mjs` — receipt publisher (payment store)
- `composition/w6-receipt-publisher.mjs` — durable payment storage
- `composition/w6-verifier-profiles.json` — per-profile policy blocks
- `composition/test/w6-economics.test.mjs` — 42 formula tests
- `composition/test/w6-stake-gate.test.mjs` — 14 gate integration tests
- `docs/handoffs/w6-v3-economics-formula.md` — this document
