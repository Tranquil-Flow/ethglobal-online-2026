// Native x402 wallet boundary. Private keys are injected only by the approved
// live connector; ordinary imports/tests do not inspect any operator wallet.
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmdirSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalBytes,
  digestOf,
  validate,
} from "../packages/contracts/index.mjs";
import {
  createBoundHederaSigner,
  createHederaPaymentAuthorizer,
} from "../packages/payments/src/client.mjs";
import { inspectProof } from "../packages/payments/src/protocol.mjs";
import {
  assertPrivateDirectory,
  readPrivateFile,
} from "../operations/src/private-files.mjs";

export const HEDERA_PAYER = "0.0.10419268",
  HEDERA_RECEIVER = "0.0.10419316";

const HEDERA_NETWORK = "hedera:testnet";
const HEDERA_ASSET = "0.0.0";
const ONE_TINYBAR = "1";
const NODE_ACCOUNT_IDS = Object.freeze(["0.0.3"]);
const SCOPED_JOURNAL_VERSION = "wave6-scoped-tinybar-v1";

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function accountId(value) {
  return (
    typeof value === "string" && /^0\.0\.(0|[1-9][0-9]{0,18})$/.test(value)
  );
}

function scopedId(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
  );
}

function sameJson(left, right) {
  try {
    return canonicalBytes(left).equals(canonicalBytes(right));
  } catch {
    return false;
  }
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function clockDate(clock, code = "SCOPED_TINYBAR_SCOPE_REQUIRED") {
  let value;
  try {
    value = clock();
  } catch {
    fail(code);
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(code);
  return value;
}

function validResourceUrl(value, mode) {
  try {
    const url = new URL(value);
    const loopback =
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return (
      typeof value === "string" &&
      value.length <= 2048 &&
      !value.endsWith("/") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value &&
      (mode === "live"
        ? url.protocol === "https:"
        : url.protocol === "https:" || loopback)
    );
  } catch {
    return false;
  }
}

function savePrivateJournal(file, value) {
  const temporary = `${file}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const directoryFd = openSync(dirname(file), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function readJournal(file) {
  try {
    return JSON.parse(
      readPrivateFile(file, {
        maxBytes: 65536,
        code: "PRIVATE_WALLET_JOURNAL_REQUIRED",
      }).data.toString("utf8"),
    );
  } catch (error) {
    if (error?.code === "PRIVATE_WALLET_JOURNAL_REQUIRED") throw error;
    fail("PRIVATE_WALLET_JOURNAL_REQUIRED");
  }
}

/**
 * Shared one-attempt implementation. Scope validation completes before the
 * durable reservation; the reservation is fsync'd before the native signer is
 * called. An ambiguous reservation is never automatically released.
 */
function createJournaledTinybarWallet({
  journalFile,
  payer,
  signTransaction,
  normalizeContext,
  makeReservedState,
  canReuseJournal,
  clock = () => new Date(),
  lockConflictCode,
  preflightChallenge = false,
}) {
  const file = resolve(journalFile);
  const signer = createBoundHederaSigner({
    accountId: payer,
    nodeAccountIds: NODE_ACCOUNT_IDS,
    signTransaction,
  });
  const authorize = createHederaPaymentAuthorizer({
    signer,
    approve: () => true,
  });
  const validateChallenge = preflightChallenge
    ? createHederaPaymentAuthorizer({
        signer,
        approve: () => false,
      })
    : null;

  return async (input) => {
    const normalized = normalizeContext(input);
    const { quote, challenge, signal } = normalized;
    if (signal?.aborted) fail("ABORTED");
    if (validateChallenge) {
      try {
        await validateChallenge({ quote, challenge, signal });
      } catch (error) {
        if (signal?.aborted || error?.code === "ABORTED") fail("ABORTED");
        fail("SCOPED_TINYBAR_SCOPE_REQUIRED");
      }
    }
    const requirements = challenge.accepts[0];
    const binding = digestOf(normalized.binding);
    assertPrivateDirectory(dirname(file));
    const lock = `${file}.lock`;
    let acquired = false;
    try {
      try {
        mkdirSync(lock, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if (error?.code === "EEXIST" && lockConflictCode)
          fail(lockConflictCode);
        throw error;
      }
      if (existsSync(file)) {
        const saved = readJournal(file);
        if (
          saved.binding !== binding ||
          !saved.headers ||
          (canReuseJournal && !canReuseJournal(saved, normalized))
        )
          fail("WALLET_BUDGET_RESERVED");
        const proof = inspectProof(
          saved.headers["payment-signature"],
          requirements,
          challenge.resource,
          { clock },
        );
        if (
          proof.payer !== payer ||
          saved.transactionId !== proof.transactionId
        )
          fail("PAYER_MISMATCH");
        return structuredClone(saved.headers);
      }

      normalized.assertFresh?.();
      const state = makeReservedState({ normalized, binding });
      savePrivateJournal(file, state);
      if (signal?.aborted) fail("ABORTED");
      normalized.assertFresh?.();
      const headers = await authorize({ quote, challenge, signal });
      if (signal?.aborted) fail("ABORTED");
      const proof = inspectProof(
        headers["payment-signature"],
        requirements,
        challenge.resource,
        { clock },
      );
      if (proof.payer !== payer) fail("PAYER_MISMATCH");
      Object.assign(state, {
        headers,
        transactionId: proof.transactionId,
        status: "signed-not-broadcast-by-wallet",
      });
      savePrivateJournal(file, state);
      return structuredClone(headers);
    } finally {
      if (acquired) rmdirSync(lock);
    }
  };
}

/**
 * Constructs a host-authorized, one-attempt Hedera wallet callback.
 *
 * The caller must pass the exact operator-approved group, provider, profile,
 * Request, payer, recipient, facilitator fee payer, resource URL, one-tinybar
 * budget and quote expiry. Construction performs no signing or broadcast.
 * The returned function accepts the paymentAuthorizer context emitted by the
 * access client: {request, quote, body/challenge, budget, idempotencyKey, signal}.
 */
export function createScopedTinybarWallet(options = {}) {
  const allowed = [
    "journalFile",
    "groupId",
    "providerId",
    "profileId",
    "request",
    "mode",
    "payer",
    "receiver",
    "feePayer",
    "resourceUrl",
    "network",
    "asset",
    "maxAmountBaseUnits",
    "expiresAt",
    "signTransaction",
    "clock",
  ];
  if (
    !exactKeys(
      options,
      allowed.filter((key) => key !== "clock"),
    ) &&
    !exactKeys(options, allowed)
  )
    fail("SCOPED_TINYBAR_SCOPE_REQUIRED");
  const {
    journalFile,
    groupId,
    providerId,
    profileId,
    request,
    mode,
    payer,
    receiver,
    feePayer,
    resourceUrl,
    network,
    asset,
    maxAmountBaseUnits,
    expiresAt,
    signTransaction,
    clock = () => new Date(),
  } = options;

  let approvedRequest;
  try {
    validate("Request", request);
    approvedRequest = structuredClone(request);
  } catch {
    fail("SCOPED_TINYBAR_SCOPE_REQUIRED");
  }
  const expiry = Date.parse(expiresAt);
  if (
    typeof journalFile !== "string" ||
    !journalFile ||
    journalFile.length > 4096 ||
    journalFile.includes("\0") ||
    !scopedId(groupId) ||
    providerId !== approvedRequest.providerId ||
    profileId !== approvedRequest.profileId ||
    approvedRequest.publishConsent !== false ||
    !["development", "live"].includes(mode) ||
    !accountId(payer) ||
    !accountId(receiver) ||
    !accountId(feePayer) ||
    payer === receiver ||
    payer === feePayer ||
    !validResourceUrl(resourceUrl, mode) ||
    network !== HEDERA_NETWORK ||
    asset !== HEDERA_ASSET ||
    maxAmountBaseUnits !== ONE_TINYBAR ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(expiry) ||
    typeof signTransaction !== "function" ||
    typeof clock !== "function"
  )
    fail("SCOPED_TINYBAR_SCOPE_REQUIRED");

  const requestHash = digestOf(approvedRequest);
  const scope = freezeDeep({
    version: SCOPED_JOURNAL_VERSION,
    groupId,
    providerId,
    profileId,
    request: approvedRequest,
    requestHash,
    mode,
    payer,
    receiver,
    feePayer,
    resourceUrl,
    network,
    asset,
    maxAmountBaseUnits,
    expiresAt,
  });
  const scopeHash = digestOf({
    version: scope.version,
    groupId: scope.groupId,
    providerId: scope.providerId,
    profileId: scope.profileId,
    requestHash: scope.requestHash,
    mode: scope.mode,
    payer: scope.payer,
    receiver: scope.receiver,
    feePayer: scope.feePayer,
    resourceUrl: scope.resourceUrl,
    network: scope.network,
    asset: scope.asset,
    maxAmountBaseUnits: scope.maxAmountBaseUnits,
    expiresAt: scope.expiresAt,
  });

  return createJournaledTinybarWallet({
    journalFile,
    payer,
    signTransaction,
    clock,
    lockConflictCode: "WALLET_BUDGET_RESERVED",
    preflightChallenge: true,
    normalizeContext(input) {
      let suppliedRequest, quote, challenge, budget;
      try {
        suppliedRequest = structuredClone(input?.request);
        quote = structuredClone(input?.quote);
        const suppliedChallenge = input?.challenge ?? input?.body;
        if (
          input?.challenge !== undefined &&
          input?.body !== undefined &&
          !sameJson(input.challenge, input.body)
        )
          fail("SCOPED_TINYBAR_SCOPE_REQUIRED");
        challenge = structuredClone(suppliedChallenge);
        budget = structuredClone(input?.budget);
        validate("Request", suppliedRequest);
        validate("Quote", quote);
      } catch (error) {
        if (error?.code === "SCOPED_TINYBAR_SCOPE_REQUIRED") throw error;
        fail("SCOPED_TINYBAR_SCOPE_REQUIRED");
      }
      if (
        !isRecord(challenge) ||
        !Array.isArray(challenge.accepts) ||
        challenge.accepts.length !== 1 ||
        !isRecord(challenge.accepts[0])
      )
        fail("SCOPED_TINYBAR_SCOPE_REQUIRED");
      const requirements = challenge.accepts[0];
      const idempotencyKey = input?.idempotencyKey;
      if (
        !sameJson(suppliedRequest, scope.request) ||
        quote.requestHash !== scope.requestHash ||
        quote.providerId !== scope.providerId ||
        quote.profileId !== scope.profileId ||
        quote.mode !== scope.mode ||
        quote.amountBaseUnits !== scope.maxAmountBaseUnits ||
        quote.receiver !== scope.receiver ||
        quote.network !== scope.network ||
        quote.asset !== scope.asset ||
        quote.expiresAt !== scope.expiresAt ||
        challenge.accepts.length !== 1 ||
        requirements.scheme !== "exact" ||
        requirements.amount !== scope.maxAmountBaseUnits ||
        requirements.payTo !== scope.receiver ||
        requirements.network !== scope.network ||
        requirements.asset !== scope.asset ||
        requirements.maxTimeoutSeconds !== 120 ||
        !exactKeys(requirements.extra, ["feePayer", "memo"]) ||
        requirements.extra.feePayer !== scope.feePayer ||
        !/^ethonline:[0-9a-f]{64}$/.test(requirements.extra.memo) ||
        challenge.resource?.url !==
          `${scope.resourceUrl}/quotes/${quote.quoteId}` ||
        !exactKeys(budget, ["maxAmountBaseUnits", "asset", "network"]) ||
        budget.maxAmountBaseUnits !== scope.maxAmountBaseUnits ||
        budget.asset !== scope.asset ||
        budget.network !== scope.network ||
        typeof idempotencyKey !== "string" ||
        !/^[A-Za-z0-9:._@-]{1,256}$/.test(idempotencyKey)
      )
        fail("SCOPED_TINYBAR_SCOPE_REQUIRED");
      const now = clockDate(clock);
      if (expiry <= now.getTime()) fail("QUOTE_EXPIRED");
      const frozen = freezeDeep({
        request: suppliedRequest,
        quote,
        challenge,
        budget,
        idempotencyKey,
      });
      return {
        ...frozen,
        signal: input?.signal,
        reservedAt: now.toISOString(),
        assertFresh() {
          if (expiry <= clockDate(clock).getTime()) fail("QUOTE_EXPIRED");
        },
        binding: {
          version: "wave6-scoped-payment-binding-v1",
          scopeHash,
          requestHash: scope.requestHash,
          quote: frozen.quote,
          challenge: frozen.challenge,
          budget: frozen.budget,
          idempotencyKey: frozen.idempotencyKey,
        },
      };
    },
    makeReservedState({ normalized, binding }) {
      return {
        version: SCOPED_JOURNAL_VERSION,
        binding,
        scopeHash,
        requestHash: scope.requestHash,
        quoteId: normalized.quote.quoteId,
        idempotencyKeyHash: digestOf(normalized.idempotencyKey),
        maximumPayerDebitTinybars: ONE_TINYBAR,
        expiresAt: scope.expiresAt,
        status: "reserved-before-signing",
        reservedAt: normalized.reservedAt,
      };
    },
    canReuseJournal(saved) {
      return (
        saved.version === SCOPED_JOURNAL_VERSION &&
        saved.scopeHash === scopeHash &&
        saved.requestHash === scope.requestHash &&
        saved.maximumPayerDebitTinybars === ONE_TINYBAR &&
        saved.expiresAt === scope.expiresAt &&
        exactKeys(saved.headers, ["payment-signature"])
      );
    },
  });
}

// Wave 5 compatibility boundary. Its synthetic prefix, account exports, journal
// version/binding and callback shape stay unchanged; new W3 callers must use the
// scoped factory above rather than wrapping or weakening this legacy factory.
export function createSingleTinybarWallet({
  journalFile,
  request,
  mode,
  feePayer,
  resourceUrl,
  signTransaction,
}) {
  validate("Request", request);
  if (
    request.publishConsent !== false ||
    !request.prompt.startsWith("SYNTHETIC_LIVE_SMOKE:") ||
    !["development", "live"].includes(mode) ||
    typeof signTransaction !== "function"
  )
    fail("ONE_TINYBAR_SCOPE_REQUIRED");
  const original = structuredClone(request);
  const requestHash = digestOf(original);

  return createJournaledTinybarWallet({
    journalFile,
    payer: HEDERA_PAYER,
    signTransaction,
    normalizeContext(input) {
      const { quote, challenge, signal } = input;
      const requirements = challenge?.accepts?.[0];
      if (signal?.aborted) fail("ABORTED");
      if (
        challenge?.accepts?.length !== 1 ||
        quote?.requestHash !== requestHash ||
        quote.providerId !== original.providerId ||
        quote.profileId !== original.profileId ||
        quote.mode !== mode ||
        quote.amountBaseUnits !== ONE_TINYBAR ||
        quote.receiver !== HEDERA_RECEIVER ||
        quote.network !== HEDERA_NETWORK ||
        quote.asset !== HEDERA_ASSET ||
        requirements.amount !== ONE_TINYBAR ||
        requirements.payTo !== HEDERA_RECEIVER ||
        requirements.network !== HEDERA_NETWORK ||
        requirements.asset !== HEDERA_ASSET ||
        requirements.extra?.feePayer !== feePayer ||
        challenge.resource?.url !== `${resourceUrl}/quotes/${quote.quoteId}`
      )
        fail("ONE_TINYBAR_SCOPE_REQUIRED");
      return {
        quote,
        challenge,
        signal,
        binding: { quote, challenge, requestHash },
      };
    },
    makeReservedState({ normalized, binding }) {
      return {
        version: "wave5-one-tinybar-v1",
        binding,
        requestHash,
        quoteId: normalized.quote.quoteId,
        maximumPayerDebitTinybars: ONE_TINYBAR,
        status: "reserved-before-signing",
        reservedAt: new Date().toISOString(),
      };
    },
  });
}

export async function connect(options) {
  const entry = fileURLToPath(
    new URL("../packages/payments/scripts/live-smoke.mjs", import.meta.url),
  );
  if (
    resolve(process.argv[1] ?? "") !== entry ||
    !process.argv.includes("--execute") ||
    !process.argv.includes("--approved") ||
    process.env.EDITOR_LIVE_BUDGET_TINYBARS !== "1" ||
    options.network !== HEDERA_NETWORK ||
    options.maxAmountBaseUnits !== ONE_TINYBAR
  )
    fail("APPROVED_LIVE_SMOKE_FLOW_REQUIRED");
  if (options.reconcileOnly === true) {
    const { connectReconciliation } = await import(
      "./hedera-reconciliation-connection.mjs"
    );
    return connectReconciliation(options);
  }
  const { createLivePaidConnection } = await import(
    "./hedera-live-connection.mjs"
  );
  return createLivePaidConnection(options);
}
