// composition/w6-stake-gate.mjs
//
// Provider swarm stake gate.
//
// Owner requirement (L-STAKE-GATE): before the verifier-bridge accepts a
// provider for inference (i.e. before signing an observation receipt), the
// operator's on-chain stake must meet a configured minimum. If the stake is
// below the threshold the gate returns { ok: false, reason: "INSUFFICIENT_STAKE" }
// and the bridge surfaces this as PROVIDER_NOT_STAKED.
//
// v3 (L-ECONOMICS-DYNAMIC-STAKE): the gate now reads the provider's profile
// (inferencePriceBaseUnits, inferenceCostBaseUnits, auditProbability,
// slashRatio, pBeat, lookbackDays, slashingRatePerDay) and the rolling
// earnings from the receipt publisher's payment store. The combined stake
// requirement is:
//
//     requiredStake = max(
//         requiredStakeTheory(price, cost, auditProb, slashRatio, pBeat),
//         rollingEarnings * slashingRatePerDay,
//         theoreticalFloorBaseUnits (default 2 HBAR)
//     )
//
// Currency is Hedera tinybar (1 HBAR = 1e8 tinybar). The gate's threshold
// is in tinybar; legacy wei callers can still pass an explicit override
// via `minStakeOverrideWei` / `minStakeOverrideTinybar`.
//
// This module is dependency-injection friendly: callers supply either:
//   - a ready `stakeGate` function (preferred for testing) — async (providerId) => gateResult
//   - or { rpcUrl, escrowAddress, abi } for live chain reads
//
// No server, no key reads, no broadcasts. The only on-chain call is a view
// (eth_call) reading stakeBalance(id).
//
// Intentionally does NOT import from ./w6-verifier-bridge.mjs to avoid a
// circular dependency (the bridge imports this gate via the DI seam). We raise
// plain Errors with `code` attached; the bridge catches and re-wraps into its
// own VerifierBridgeError where appropriate.

/**
 * Minimal ABI for the stake-balance read on MyceliumStakeEscrow.
 *
 * stakeBalance(bytes32) is a public mapping auto-getter on the contract:
 *   mapping(bytes32 id => uint256) public stakeBalance;
 * It returns the current staked amount (in wei) for the provider/profile id,
 * where id = keccak256(abi.encode(providerKey, profile)) (i.e. providerId()).
 *
 * The optional requiredStake getter is included so the same ABI can also be
 * used to fetch the on-chain threshold (e.g. for diagnostics or for profiles
 * that opt to use the chain-set value instead of a local override).
 */
export const STAKE_ESCROW_MIN_ABI = [
  {
    type: "function",
    name: "stakeBalance",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "requiredStake",
    stateMutability: "view",
    inputs: [{ name: "profile", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "providerId",
    stateMutability: "pure",
    inputs: [
      { name: "providerKey", type: "bytes32" },
      { name: "profile", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
];

/**
 * Default minimum stake in tinybar: 2 HBAR (2 * 1e8 = 2e8 tinybar). This is
 * the canonical theoretical floor used when no profile-derived floor is
 * available. Owners can override per profile via the
 * `stakeRequirementPolicy.theoreticalFloorBaseUnits` field in
 * w6-verifier-profiles.json or via the explicit `minStakeOverrideTinybar`
 * argument when building a gate.
 */
export const DEFAULT_MIN_STAKE_TINYBAR = "200000000"; // 2 HBAR

// Function selector for stakeBalance(bytes32):
//   keccak256("stakeBalance(bytes32)")[0..4]
// Computed once with node:crypto: 0xe3fe5b14.
const STAKE_BALANCE_SELECTOR = "0xe3fe5b14";

/**
 * Result shape returned by every gate function.
 *
 *   ok: true                                 — stake meets or exceeds minStakeWei
 *   ok: false, reason: "INSUFFICIENT_STAKE"  — current stake < minStakeWei
 *   ok: false, reason: "PROVIDER_NOT_FOUND"  — provider not registered on-chain
 *   ok: false, reason: "STAKE_GATE_DISABLED" — no minStakeWei configured
 *
 * `required` and `actual` are decimal strings (tinybar / wei), so callers
 * never lose precision on uint256 values.
 */
export function insufficientStake({ required, actual, providerId }) {
  return Object.freeze({
    ok: false,
    reason: "INSUFFICIENT_STAKE",
    required,
    actual,
    providerId,
  });
}

export function providerNotFound({ providerId }) {
  return Object.freeze({
    ok: false,
    reason: "PROVIDER_NOT_FOUND",
    providerId,
  });
}

export function stakeGateDisabled() {
  return Object.freeze({ ok: true, reason: "STAKE_GATE_DISABLED" });
}

export function stakeSufficient({ required, actual, providerId }) {
  return Object.freeze({ ok: true, required, actual, providerId });
}

/**
 * Convert a base-unit value (BigInt, decimal/hex string, number, or
 * ethers-like object with toString) to a BigInt for safe comparison.
 * Empty/undefined -> 0n. Used for both tinybar and wei thresholds — the
 * caller chooses the magnitude.
 */
export function toBigInt(value) {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cannot interpret non-finite number as base-unit value`);
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return BigInt(trimmed);
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new TypeError(`invalid decimal base-unit string: ${trimmed}`);
    }
    return BigInt(trimmed);
  }
  if (typeof value === "object") {
    if (typeof value.toString === "function") {
      const repr = value.toString();
      if (repr && repr !== "[object Object]") return toBigInt(repr);
    }
    if (typeof value.hex === "string") return BigInt(value.hex);
  }
  throw new TypeError(`cannot interpret ${typeof value} as base-unit value`);
}

function gateInputError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Build the gate function used inside observeNow(). The gate is async so it can
 * perform a real eth_call; the bridge awaits the result before signing.
 *
 * Options:
 *   - stakeGate(providerId): async ({ ok, reason?, required?, actual? }) — pre-built
 *   - escrow: ethers-like contract instance exposing stakeBalance(bytes32) -> BigInt
 *   - rpcUrl + escrowAddress + abi: live mode (resolved lazily via fetch)
 *   - minStakeWei / minStakeTinybar: decimal string or BigInt, threshold in
 *     base units (required for live). minStakeTinybar is preferred in v3;
 *     minStakeWei is kept as a backward-compat alias.
 *
 * Returns an async function: (providerId) -> gateResult
 */
export function createStakeGate(options = {}) {
  if (typeof options.stakeGate === "function") {
    const supplied = options.stakeGate;
    return async function gate(providerId) {
      if (providerId === undefined || providerId === null) {
        throw gateInputError(
          "INVALID_STAKE_GATE_INPUT",
          "stake gate called with undefined providerId",
        );
      }
      const result = await supplied(providerId);
      if (!result || typeof result.ok !== "boolean") {
        throw gateInputError(
          "STAKE_GATE_INVALID_RESULT",
          "stake gate did not return { ok: boolean }",
        );
      }
      return result;
    };
  }

  const minStakeRaw =
    options.minStakeTinybar ?? options.minStakeWei ?? DEFAULT_MIN_STAKE_TINYBAR;
  const minStakeBaseUnits = toBigInt(minStakeRaw);

  const escrow = options.escrow;
  const useHttp =
    typeof options.rpcUrl === "string" &&
    typeof options.escrowAddress === "string" &&
    options.abi;

  if (!escrow && !useHttp) {
    throw new Error(
      "createStakeGate requires either {stakeGate}, {escrow}, or " +
        "{rpcUrl, escrowAddress, abi}",
    );
  }

  async function readStake(providerId) {
    if (escrow && typeof escrow.stakeBalance === "function") {
      return toBigInt(await escrow.stakeBalance(providerId));
    }
    const data = encodeStakeBalanceCall(providerId);
    const response = await fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "stake-gate",
        method: "eth_call",
        params: [
          { to: options.escrowAddress, data },
          "latest",
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`stake-gate rpc http ${response.status}`);
    }
    const json = await response.json();
    if (json.error) {
      throw new Error(
        `stake-gate rpc error: ${json.error.message || JSON.stringify(json.error)}`,
      );
    }
    return toBigInt(json.result);
  }

  return async function gate(providerId) {
    if (providerId === undefined || providerId === null) {
      throw gateInputError(
        "INVALID_STAKE_GATE_INPUT",
        "stake gate called with undefined providerId",
      );
    }
    let actual;
    try {
      actual = await readStake(providerId);
    } catch (error) {
      return Object.freeze({
        ok: false,
        reason: "STAKE_GATE_RPC_UNAVAILABLE",
        providerId,
        cause: error?.message ?? String(error),
      });
    }
    if (actual < minStakeBaseUnits) {
      return insufficientStake({
        required: minStakeBaseUnits.toString(),
        actual: actual.toString(),
        providerId,
      });
    }
    return stakeSufficient({
      required: minStakeBaseUnits.toString(),
      actual: actual.toString(),
      providerId,
    });
  };
}

/**
 * ABI-encode an eth_call to stakeBalance(bytes32) without an ethers dep.
 * Pads the providerId (bytes32) into a single 32-byte word.
 */
function encodeStakeBalanceCall(providerIdBytes32) {
  if (typeof providerIdBytes32 !== "string") {
    throw new TypeError("providerId must be a 0x-prefixed bytes32 hex string");
  }
  const id = providerIdBytes32.startsWith("0x")
    ? providerIdBytes32.slice(2)
    : providerIdBytes32;
  if (id.length !== 64 || !/^[0-9a-fA-F]+$/.test(id)) {
    throw new TypeError("providerId must be a 64-char hex string (bytes32)");
  }
  return STAKE_BALANCE_SELECTOR + id;
}

/**
 * Resolve the active gate for a verifier profile. Profile shape:
 *   { id, stakeRequirement?: string (wei/tinybar) | null, ... }
 *
 * Behavior:
 *   - profile.stakeRequirement === null          → STAKE_GATE_DISABLED
 *   - profile.stakeRequirement === "0" | "0x0"   → STAKE_GATE_DISABLED
 *   - profile.stakeRequirement === undefined     → use supplied default
 *   - otherwise                                  → use the supplied threshold
 */
export function resolveGateForProfile({
  profile,
  defaultMinStakeTinybar = DEFAULT_MIN_STAKE_TINYBAR,
  buildGate = createStakeGate,
}) {
  if (!profile || typeof profile !== "object") {
    throw new Error("resolveGateForProfile: profile required");
  }
  if (typeof buildGate !== "function") {
    throw new Error("resolveGateForProfile: buildGate factory required");
  }
  const raw = profile.stakeRequirement;
  if (raw === null) {
    return async () => stakeGateDisabled();
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^0+$/.test(trimmed) || /^0x0+$/.test(trimmed)) {
      return async () => stakeGateDisabled();
    }
  }
  const minStake =
    raw === undefined ? defaultMinStakeTinybar : toBigInt(raw).toString();
  return buildGate({ minStakeTinybar: minStake });
}


// ============================================================================
// L-ECONOMICS-FORMULA v3 integration: stake policy via composition/w6-economics.mjs
// ============================================================================
//
// The v3 policy block looks like:
//
//   {
//     share,                              // legacy (ignored in v3)
//     inferencePriceBaseUnits,            // provider-set price (tinybar)
//     inferenceCostBaseUnits,             // provider-set cost (tinybar)
//     auditProbability,                   // P(any audit catches bad output)
//     slashRatio,                         // fraction slashed on 3-negative
//     pBeat,                              // P(cheater beats ensemble)
//     // v3 additions:
//     maxTotalSlashRatio,                 // default 1.0 (cumulative cap)
//     lookbackDays,                       // default 30
//     slashingRatePerDay,                 // default 0.10
//     theoreticalFloorBaseUnits,          // default 2 HBAR in tinybar
//   }
//
// The combined required stake is:
//
//     required = max(theoreticalFloor,
//                    rollingEarnings * slashingRatePerDay,
//                    requiredStakeTheory(price, cost, audit, slash, pBeat))
//
// Providers can set ANY price; the gate scales with both the price and
// their recent earnings. New providers (no earnings) get the theoretical
// floor only.

/**
 * Normalize a profile's `stakeRequirementPolicy` block into the canonical
 * BigInt / Number shape required by requiredStake() and friends.
 *
 * Returns null if the profile has no stakeRequirementPolicy — caller falls
 * back to the legacy flat-stake path.
 */
export function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object") return null;
  const required = [
    "inferencePriceBaseUnits",
    "inferenceCostBaseUnits",
    "auditProbability",
    "slashRatio",
    "pBeat",
  ];
  for (const k of required) {
    if (!(k in policy)) {
      throw new Error(
        `stakeRequirementPolicy missing required field: ${k}`,
      );
    }
  }
  return {
    // v3 — no more `share` parameter at the formula level.
    priceBaseUnits: toBigInt(policy.inferencePriceBaseUnits),
    inferenceCostBaseUnits: toBigInt(policy.inferenceCostBaseUnits),
    auditProbability: Number(policy.auditProbability),
    slashRatio: Number(policy.slashRatio),
    pBeat: Number(policy.pBeat),
    // v3 dynamic floor knobs:
    rollingEarningsBaseUnits: 0n, // filled in by buildStakeGateFromPolicy
    slashingRatePerDay:
      typeof policy.slashingRatePerDay === "number"
        ? Number(policy.slashingRatePerDay)
        : 0.10,
    lookbackDays:
      typeof policy.lookbackDays === "number" ? Number(policy.lookbackDays) : 30,
    theoreticalFloorBaseUnits:
      "theoreticalFloorBaseUnits" in policy
        ? toBigInt(policy.theoreticalFloorBaseUnits)
        : 200_000_000n, // 2 HBAR default
    maxTotalSlashRatio:
      typeof policy.maxTotalSlashRatio === "number"
        ? Number(policy.maxTotalSlashRatio)
        : 1.0,
  };
}

/**
 * Build a stake gate function from a profile's stakeRequirementPolicy.
 *
 * Dynamic-imports the economics module to keep this file side-effect-free
 * until invoked. Reads rolling earnings from the supplied payment-store
 * adapter (or a zero default if absent).
 *
 * Returns an async gate: (providerId) -> { ok, reason, required, actual }.
 *
 * Env-var style explicit overrides (`minStakeOverrideTinybar` /
 * `minStakeOverrideWei`) win over the formula — useful for sponsor-driven
 * DEMO flows and emergency tuning.
 */
export async function buildStakeGateFromPolicy({
  profile,
  providerId,
  minStakeOverrideTinybar,
  minStakeOverrideWei, // legacy alias
  paymentStore,
  buildGate = createStakeGate,
  economicsModuleSpecifier = "./w6-economics.mjs",
} = {}) {
  if (!profile || typeof profile !== "object") {
    throw new Error("buildStakeGateFromPolicy: profile required");
  }
  if (typeof buildGate !== "function") {
    throw new Error("buildStakeGateFromPolicy: buildGate factory required");
  }

  // Explicit override path (env-var style). Wins over the formula.
  const explicit = minStakeOverrideTinybar ?? minStakeOverrideWei;
  if (explicit !== undefined && explicit !== null) {
    return buildGate({ minStakeTinybar: toBigInt(explicit).toString() });
  }

  const policy = normalizePolicy(profile.stakeRequirementPolicy);
  if (!policy) {
    // No policy → fall back to profile.stakeRequirement (legacy path).
    if (profile.stakeRequirement === null || profile.stakeRequirement === undefined) {
      return async () => stakeGateDisabled();
    }
    const raw = String(profile.stakeRequirement).trim();
    if (/^0+$/.test(raw) || /^0x0+$/.test(raw)) {
      return async () => stakeGateDisabled();
    }
    return buildGate({ minStakeTinybar: toBigInt(raw).toString() });
  }

  // Resolve rolling earnings via the economics module's seam (reads from
  // the receipt publisher's stored payments to this provider).
  const economics = await import(economicsModuleSpecifier);
  const rollingEarningsBaseUnits = await economics.resolveRollingEarnings({
    providerId:
      typeof providerId === "string" ? providerId : profile.id ?? "unknown",
    lookbackDays: policy.lookbackDays,
    store: paymentStore,
  });

  // Compute the formula-derived threshold once. Dynamic import keeps the
  // module side-effect-free until actually invoked.
  const required = economics.requiredStake({
    priceBaseUnits: policy.priceBaseUnits,
    inferenceCostBaseUnits: policy.inferenceCostBaseUnits,
    auditProbability: policy.auditProbability,
    slashRatio: policy.slashRatio,
    pBeat: policy.pBeat,
    rollingEarningsBaseUnits,
    slashingRatePerDay: policy.slashingRatePerDay,
    theoreticalFloorBaseUnits: policy.theoreticalFloorBaseUnits,
  });

  if (required === 0n) {
    // Trivially-satisfied (e.g. sponsor-covered cost, no price). Don't gate.
    return async () => stakeGateDisabled();
  }

  return buildGate({ minStakeTinybar: required.toString() });
}

/**
 * Synchronous equivalent: caller must have pre-loaded the economics module.
 * Used by owner-console / CLI hot paths where we already hold a reference.
 * Rolling earnings is taken as 0n (new provider) since the sync path
 * cannot await the store; callers that need the dynamic floor should use
 * the async buildStakeGateFromPolicy().
 */
export function requiredStakeFromPolicySync({ profile, economics }) {
  if (!profile || typeof profile !== "object") {
    throw new Error("requiredStakeFromPolicySync: profile required");
  }
  if (!economics || typeof economics.requiredStake !== "function") {
    throw new Error("requiredStakeFromPolicySync: economics module required");
  }
  const policy = normalizePolicy(profile.stakeRequirementPolicy);
  if (!policy) {
    return toBigInt(profile.stakeRequirement ?? "0").toString();
  }
  return economics
    .requiredStake({
      priceBaseUnits: policy.priceBaseUnits,
      inferenceCostBaseUnits: policy.inferenceCostBaseUnits,
      auditProbability: policy.auditProbability,
      slashRatio: policy.slashRatio,
      pBeat: policy.pBeat,
      rollingEarningsBaseUnits: 0n,
      slashingRatePerDay: policy.slashingRatePerDay,
      theoreticalFloorBaseUnits: policy.theoreticalFloorBaseUnits,
    })
    .toString();
}
