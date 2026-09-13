// Guarded Wave 6 ENSv2 Sepolia record update for two existing owned names.
// Only the six application text records may change. Exact signed bytes
// are durably journaled before broadcast and reused verbatim on every resume.
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Resolver } from "node:dns/promises";
import { createRequire } from "node:module";
import {
  createEnsV2Discovery,
  createEnsV2Resolver,
  RECORD_KEYS,
  safeGet,
  safeUrl,
} from "../packages/discovery/src/index.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import {
  assertPrivateDirectory,
  assertSafeParent,
  readPrivateFile,
  sameFileState,
  writePrivateExclusive,
} from "../operations/src/private-files.mjs";
import { boundedFee } from "./ens-register-second-node.mjs";

const {
  FetchRequest,
  JsonRpcProvider,
  Transaction,
  Wallet,
  isAddress,
  keccak256,
  namehash,
  Interface,
} = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
)("ethers");

const textInterface = new Interface([
  "function setText(bytes32 node, string key, string value)",
]);

function encodeSetText(name, key, value) {
  return textInterface.encodeFunctionData("setText", [
    namehash(name),
    key,
    value,
  ]);
}

export const WAVE6_ENS_OWNER = "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE";
export const WAVE6_ENS_NAMES = Object.freeze([
  "service.ethonline-node-a.eth",
  "service.ethonline-node-b.eth",
]);
export const WAVE6_RETIRED_ENDPOINT = "https://m4pro.tail53d0d3.ts.net";
export const WAVE6_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

const JOURNAL_VERSION = "ethonline.wave6.ens-repoint-journal.v1";
const PER_TRANSACTION_LIMIT_WEI = 5_000_000_000_000_000n;
const TOTAL_LIMIT_WEI = 10_000_000_000_000_000n;
const MAXIMUM_GAS_PRICE_WEI = 3_000_000_000n;
const CONFIRMATIONS = 12;
const ENDPOINT_KEY = "ethonline.endpoint";
const PROFILE_KEY = "ethonline.profiles";
const HISTORY_KEY = "ethonline.history";
const RECORD_KEY_SET = [...RECORD_KEYS].sort().join("\n");
const TARGET_NAME_SET = [...WAVE6_ENS_NAMES].sort().join("\n");
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

function safeCode(error, fallback) {
  return typeof error?.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    ? error.code
    : fallback;
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === expected
  );
}

function canonicalPublicUrl(value, code, { originOnly = false } = {}) {
  let url;
  try {
    url = safeUrl(value, { mode: "live" });
  } catch {
    fail(code);
  }
  if (
    url.hostname === "invalid" ||
    url.hostname.endsWith(".invalid") ||
    (originOnly && url.pathname !== "/")
  )
    fail(code);
  return originOnly ? url.origin : url.href.replace(/\/$/, "");
}

/**
 * Validate the complete expected record set for the two already-owned names.
 * All six records are exact requested values; preview is not write authority.
 */
export function validateWave6TargetRecords(input) {
  if (!exactKeys(input, TARGET_NAME_SET)) fail("EXACT_WAVE6_NAMES_REQUIRED");
  const target = structuredClone(input);
  const origins = new Set();
  for (const name of WAVE6_ENS_NAMES) {
    const records = target[name];
    if (!exactKeys(records, RECORD_KEY_SET))
      fail("EXACT_TARGET_RECORDS_REQUIRED");
    if (
      Object.values(records).some(
        (value) =>
          typeof value !== "string" || !value.length || value.length > 16384,
      )
    )
      fail("INVALID_TARGET_RECORDS");

    records[ENDPOINT_KEY] = canonicalPublicUrl(
      records[ENDPOINT_KEY],
      "PUBLIC_ORIGIN_REQUIRED",
      { originOnly: true },
    );
    // A hostname formerly routed over the tailnet may now use public Funnel.
    // Never infer reachability from its name: probeWave6PublicOrigin checks TLS.
    origins.add(records[ENDPOINT_KEY]);

    let profileIds;
    try {
      profileIds = JSON.parse(records[PROFILE_KEY]);
    } catch {
      fail("PROFILE_DIGEST_REQUIRED");
    }
    if (
      !Array.isArray(profileIds) ||
      !profileIds.length ||
      profileIds.length > 128 ||
      profileIds.some(
        (id) => typeof id !== "string" || !digestPattern.test(id),
      ) ||
      new Set(profileIds).size !== profileIds.length
    )
      fail("PROFILE_DIGEST_REQUIRED");
    records[PROFILE_KEY] = JSON.stringify(profileIds);

    for (const key of [
      "ethonline.payment.network",
      "ethonline.payment.asset",
      "ethonline.payment.receiver",
    ])
      if (records[key].length > 256) fail("INVALID_TARGET_RECORDS");
    records[HISTORY_KEY] = canonicalPublicUrl(
      records[HISTORY_KEY],
      "PUBLIC_HISTORY_REQUIRED",
    );
  }
  if (origins.size !== 1) fail("SHARED_ORIGIN_REQUIRED");
  return target;
}

function signalWithTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function captureResolution(resolver, signal) {
  const snapshots = [];
  for (const name of WAVE6_ENS_NAMES)
    snapshots.push(
      await resolver.resolve({
        name,
        signal: signalWithTimeout(signal, 30_000),
      }),
    );
  return snapshots;
}

function assertVerifiedSnapshot(snapshots, targetRecords, phase) {
  if (
    !Array.isArray(snapshots) ||
    snapshots.length !== WAVE6_ENS_NAMES.length ||
    new Set(snapshots.map((snapshot) => snapshot?.name)).size !==
      snapshots.length
  )
    fail("LIVE_ENS_READBACK_FAILED");
  for (const name of WAVE6_ENS_NAMES) {
    const snapshot = snapshots.find((entry) => entry.name === name),
      target = targetRecords[name],
      verification = snapshot?.verification;
    if (
      !snapshot ||
      snapshot.mode !== "live" ||
      snapshot.chainId !== "11155111" ||
      !hashPattern.test(snapshot.blockHash ?? "") ||
      !exactKeys(snapshot.records, RECORD_KEY_SET) ||
      !verification ||
      verification.alias !== "0x" ||
      verification.wildcardOffset !== "0" ||
      verification.postReadBlockHash !== snapshot.blockHash ||
      verification.canonicalRegistries?.length !== name.split(".").length ||
      !isAddress(verification.resolver) ||
      !isAddress(verification.resolverImplementation)
    )
      fail("LIVE_ENS_VERIFICATION_FAILED");
    if (
      phase === "after" &&
      RECORD_KEYS.some((key) => snapshot.records[key] !== target[key])
    )
      fail("LIVE_ENS_RECORD_MISMATCH");
    if (phase === "before") {
      if (
        snapshot.records[ENDPOINT_KEY] !== WAVE6_RETIRED_ENDPOINT &&
        snapshot.records[ENDPOINT_KEY] !== target[ENDPOINT_KEY]
      )
        fail("UNEXPECTED_CURRENT_ENDPOINT");
    } else if (snapshot.records[ENDPOINT_KEY] !== target[ENDPOINT_KEY])
      fail("ENS_ENDPOINT_MISMATCH");
  }
}

export async function probeWave6PublicOrigin(origin, { signal, lookup } = {}) {
  const canonical = canonicalPublicUrl(origin, "PUBLIC_ORIGIN_REQUIRED", {
      originOnly: true,
    }),
    healthUrl = canonical + "/healthz";
  let body;
  try {
    body = JSON.parse(
      (
        await safeGet(healthUrl, {
          mode: "live",
          lookup,
          signal: signalWithTimeout(signal, 15_000),
          timeoutMs: 15_000,
          maxBytes: 16_384,
        })
      ).toString("utf8"),
    );
  } catch {
    fail("PUBLIC_ORIGIN_UNREACHABLE");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.status !== "ok" ||
    body.mode !== "live"
  )
    fail("PUBLIC_ORIGIN_NOT_LIVE");
  return {
    observedAt: new Date().toISOString(),
    url: healthUrl,
    status: body.status,
    mode: body.mode,
    claim: "credential-free operator-network HTTPS observation",
  };
}

function atomicSave(path, state) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let file;
  let directory;
  try {
    file = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporary, path);
    directory = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(directory);
  } finally {
    if (file !== undefined) closeSync(file);
    if (directory !== undefined) closeSync(directory);
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

function loadJournal(path, planDigest, initialEvidence) {
  if (!existsSync(path))
    return {
      version: JOURNAL_VERSION,
      planDigest,
      createdAt: new Date().toISOString(),
      initialEvidence: structuredClone(initialEvidence ?? null),
      entries: {},
      unchanged: {},
      failures: [],
    };
  let state;
  try {
    state = JSON.parse(
      readPrivateFile(path, {
        maxBytes: 2 * 1024 * 1024,
        code: "PRIVATE_JOURNAL_REQUIRED",
      }).data.toString("utf8"),
    );
  } catch (error) {
    if (error?.code === "PRIVATE_JOURNAL_REQUIRED") throw error;
    fail("INVALID_JOURNAL");
  }
  if (
    state?.version !== JOURNAL_VERSION ||
    state.planDigest !== planDigest ||
    !state.entries ||
    typeof state.entries !== "object" ||
    Array.isArray(state.entries) ||
    !state.unchanged ||
    typeof state.unchanged !== "object" ||
    Array.isArray(state.unchanged) ||
    !Array.isArray(state.failures)
  )
    fail("JOURNAL_PLAN_MISMATCH");
  return state;
}

function verifyJournaledTransaction(entry, intent, walletAddress, chainId) {
  let rawHash;
  try {
    rawHash = typeof entry?.raw === "string" ? keccak256(entry.raw) : null;
  } catch {
    fail("INVALID_JOURNALED_TRANSACTION");
  }
  if (
    !entry ||
    entry.id !== intent.id ||
    typeof entry.to !== "string" ||
    entry.to.toLowerCase() !== intent.to.toLowerCase() ||
    entry.data !== intent.data ||
    entry.value !== "0" ||
    !hashPattern.test(entry.hash) ||
    typeof entry.raw !== "string" ||
    !/^[1-9][0-9]*$/.test(entry.gasLimit ?? "") ||
    !/^[1-9][0-9]*$/.test(entry.gasPrice ?? "") ||
    !/^[1-9][0-9]*$/.test(entry.maximumFeeWei ?? "") ||
    BigInt(entry.gasLimit) * BigInt(entry.gasPrice) !==
      BigInt(entry.maximumFeeWei) ||
    rawHash !== entry.hash
  )
    fail("JOURNAL_CALL_MISMATCH");
  let transaction;
  try {
    transaction = Transaction.from(entry.raw);
  } catch {
    fail("INVALID_JOURNALED_TRANSACTION");
  }
  if (
    transaction.chainId !== BigInt(chainId) ||
    transaction.type !== 0 ||
    transaction.to?.toLowerCase() !== intent.to.toLowerCase() ||
    transaction.data !== intent.data ||
    transaction.value !== 0n ||
    transaction.from?.toLowerCase() !== walletAddress.toLowerCase() ||
    transaction.nonce !== entry.nonce ||
    String(transaction.gasLimit) !== entry.gasLimit ||
    String(transaction.gasPrice) !== entry.gasPrice
  )
    fail("INVALID_JOURNALED_TRANSACTION");
  return transaction;
}

function publicTransaction(entry) {
  return {
    providerId: entry.id,
    transactionHash: entry.hash,
    status: entry.status,
    blockNumber: entry.blockNumber,
    blockHash: entry.blockHash,
    confirmations: entry.confirmations,
    maximumFeeWei: entry.maximumFeeWei,
    actualFeeWei: entry.actualFeeWei,
  };
}

/**
 * Generic journal executor used by the Sepolia wrapper and actual local-EVM
 * tests. Every entry is signed once, fsync+renamed before first broadcast, and
 * later invocations either reconcile or rebroadcast those identical raw bytes.
 */
export async function executeJournaledTransactions({
  provider,
  wallet,
  journalDirectory,
  planDigest,
  intents,
  chainId,
  confirmations,
  perTransactionLimitWei,
  totalLimitWei,
  maximumGasPriceWei,
  initialEvidence,
  walletStillValid = () => true,
  complete,
  onStatus = () => {},
}) {
  if (
    !provider ||
    typeof provider.getNetwork !== "function" ||
    !wallet ||
    !isAddress(wallet.address) ||
    typeof wallet.signTransaction !== "function" ||
    typeof journalDirectory !== "string" ||
    !journalDirectory.length ||
    !digestPattern.test(planDigest ?? "") ||
    !Array.isArray(intents) ||
    !intents.length ||
    intents.length > 64 ||
    !Number.isSafeInteger(chainId) ||
    !Number.isSafeInteger(confirmations) ||
    confirmations < 1 ||
    confirmations > 64 ||
    typeof perTransactionLimitWei !== "bigint" ||
    typeof totalLimitWei !== "bigint" ||
    typeof maximumGasPriceWei !== "bigint" ||
    perTransactionLimitWei <= 0n ||
    totalLimitWei < perTransactionLimitWei ||
    maximumGasPriceWei <= 0n ||
    typeof walletStillValid !== "function" ||
    typeof onStatus !== "function" ||
    (complete !== undefined && typeof complete !== "function")
  )
    fail("INVALID_JOURNAL_EXECUTION");
  if (
    new Set(intents.map((intent) => intent?.id)).size !== intents.length ||
    intents.some(
      (intent) =>
        !exactKeys(intent, ["data", "id", "skip", "to", "value"].join("\n")) ||
        typeof intent.id !== "string" ||
        !isAddress(intent.to) ||
        typeof intent.data !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(intent.data) ||
        intent.value !== "0" ||
        typeof intent.skip !== "boolean",
    )
  )
    fail("INVALID_TRANSACTION_INTENT");
  if ((await provider.getNetwork()).chainId !== BigInt(chainId))
    fail("CHAIN_MISMATCH");

  const directoryPath = resolve(journalDirectory),
    parent = dirname(directoryPath);
  assertPrivateDirectory(parent);
  if (!existsSync(directoryPath)) mkdirSync(directoryPath, { mode: 0o700 });
  assertPrivateDirectory(directoryPath);
  const lockPath = directoryPath + "/lock";
  let lockAcquired = false;
  let state;
  let save;
  let writable = false;
  try {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      lockAcquired = true;
    } catch (error) {
      if (error?.code === "EEXIST") fail("JOURNAL_LOCKED");
      throw error;
    }
    const journalPath = directoryPath + "/journal.json";
    state = loadJournal(journalPath, planDigest, initialEvidence);
    if (
      Object.keys(state.entries).some(
        (id) => !intents.some((intent) => intent.id === id),
      )
    )
      fail("JOURNAL_CALL_MISMATCH");
    writable = true;
    save = () => atomicSave(journalPath, state);
    save();

    const reserved = () =>
      Object.values(state.entries).reduce(
        (total, entry) => total + BigInt(entry.maximumFeeWei),
        0n,
      );

    for (const intent of intents) {
      let entry = state.entries[intent.id];
      if (entry) {
        verifyJournaledTransaction(entry, intent, wallet.address, chainId);
      } else if (intent.skip) {
        state.unchanged[intent.id] ??= {
          observedAt: new Date().toISOString(),
          status: "already-target",
        };
        save();
        continue;
      } else {
        delete state.unchanged[intent.id];
        if (!walletStillValid()) fail("PRIVATE_WALLET_CHANGED");
        const gasEstimate = await provider.estimateGas({
            from: wallet.address,
            to: intent.to,
            data: intent.data,
            value: 0n,
          }),
          gasLimit = (gasEstimate * 120n + 99n) / 100n,
          feeData = await provider.getFeeData();
        if (typeof feeData.gasPrice !== "bigint") fail("FEE_DATA_UNAVAILABLE");
        const gasPrice = (feeData.gasPrice * 120n + 99n) / 100n;
        if (gasPrice > maximumGasPriceWei) fail("GAS_PRICE_ABOVE_PHASE_LIMIT");
        const maximumFee = boundedFee({
          gas: gasLimit,
          gasPrice,
          used: reserved(),
          perTransaction: perTransactionLimitWei,
          total: totalLimitWei,
        });
        if ((await provider.getBalance(wallet.address)) < maximumFee)
          fail("WALLET_BELOW_UPDATE_THRESHOLD");
        const nonce = await provider.getTransactionCount(
            wallet.address,
            "pending",
          ),
          raw = await wallet.signTransaction({
            chainId,
            type: 0,
            nonce,
            to: intent.to,
            data: intent.data,
            value: 0n,
            gasLimit,
            gasPrice,
          }),
          hash = keccak256(raw);
        entry = {
          id: intent.id,
          to: intent.to,
          data: intent.data,
          value: "0",
          nonce,
          gasLimit: String(gasLimit),
          gasPrice: String(gasPrice),
          maximumFeeWei: String(maximumFee),
          raw,
          hash,
          status: "signed-journaled",
        };
        verifyJournaledTransaction(entry, intent, wallet.address, chainId);
        state.entries[intent.id] = entry;
        save();
        onStatus({
          providerId: intent.id,
          transactionHash: hash,
          status: "signed-journaled",
        });
      }

      let receipt = await provider.getTransactionReceipt(entry.hash);
      if (!receipt) {
        const known = await provider.getTransaction(entry.hash);
        if (!known) {
          const latestNonce = await provider.getTransactionCount(
              wallet.address,
              "latest",
            ),
            pendingNonce = await provider.getTransactionCount(
              wallet.address,
              "pending",
            );
          if (latestNonce > entry.nonce || pendingNonce > entry.nonce)
            fail("TRANSACTION_UNRESOLVED_OWNER_RECONCILIATION_REQUIRED");
          const sent = await provider.broadcastTransaction(entry.raw);
          if (sent.hash !== entry.hash) fail("BROADCAST_HASH_MISMATCH");
        }
        receipt = await provider.waitForTransaction(entry.hash, 1, 120_000);
      }
      if (!receipt || receipt.status !== 1) fail("TRANSACTION_NOT_CONFIRMED");
      const block = await provider.getBlock(receipt.blockNumber);
      if (!block || block.hash !== receipt.blockHash) fail("TRANSACTION_REORG");
      Object.assign(entry, {
        status: "confirmed",
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        confirmations: await receipt.confirmations(),
        actualFeeWei: String(receipt.fee),
      });
      save();
    }

    for (const intent of intents) {
      const entry = state.entries[intent.id];
      if (!entry) continue;
      const receipt = await provider.waitForTransaction(
        entry.hash,
        confirmations,
        300_000,
      );
      if (
        !receipt ||
        receipt.status !== 1 ||
        (await receipt.confirmations()) < confirmations
      )
        fail("CONFIRMATION_DEPTH_REQUIRED");
      const block = await provider.getBlock(receipt.blockNumber);
      if (!block || block.hash !== receipt.blockHash) fail("TRANSACTION_REORG");
      Object.assign(entry, {
        status: "confirmed",
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        confirmations: await receipt.confirmations(),
        actualFeeWei: String(receipt.fee),
      });
      save();
    }

    const transactions = intents.map((intent) =>
      state.entries[intent.id]
        ? publicTransaction(state.entries[intent.id])
        : {
            providerId: intent.id,
            status: "unchanged",
          },
    );
    const completion = complete
      ? await complete({ transactions: structuredClone(transactions) })
      : undefined;
    if (completion !== undefined) {
      state.completion = structuredClone(completion);
      state.completedAt = new Date().toISOString();
      save();
    }
    return {
      transactions,
      maximumReservedFeeWei: String(reserved()),
      initialEvidence: structuredClone(state.initialEvidence),
      ...(completion === undefined
        ? {}
        : { completion: structuredClone(completion) }),
    };
  } catch (error) {
    if (writable && state && save) {
      state.failures.push({
        observedAt: new Date().toISOString(),
        code: safeCode(error, "ENS_REPOINT_FAILED"),
      });
      if (state.failures.length > 64)
        state.failures.splice(0, state.failures.length - 64);
      try {
        save();
      } catch {}
    }
    throw error;
  } finally {
    if (lockAcquired) rmdirSync(lockPath);
  }
}

/** Pure exact record-to-calldata plan. No key loading, provisioning or delegation. */
export function buildWave6RecordUpdate(snapshot, target) {
  if (
    !exactKeys(target, RECORD_KEY_SET) ||
    !isAddress(snapshot?.verification?.resolver)
  )
    fail("INVALID_RECORD_UPDATE");
  const changes = Object.entries(target).filter(
    ([key, value]) => snapshot.records[key] !== value,
  );
  const intents = Object.entries(target).map(([key, value]) => ({
    id: `${snapshot.name}::${key}`,
    to: snapshot.verification.resolver,
    data: encodeSetText(snapshot.name, key, value),
    value: "0",
    skip: snapshot.records[key] === value,
  }));
  return {
    version: "1",
    mode: snapshot.mode,
    operation: "update",
    name: snapshot.name,
    chainId: Number(snapshot.chainId),
    from: WAVE6_ENS_OWNER,
    resolver: snapshot.verification.resolver,
    broadcast: false,
    approvalRequired: true,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    intents,
    transactions: intents
      .filter((intent) => !intent.skip)
      .map(({ to, data, value }) => ({ to, data, value })),
    changes: changes.map(([key, value]) => ({
      key,
      before: snapshot.records[key],
      after: value,
    })),
    skip: changes.length === 0,
  };
}

async function verifiedDiscovery(targetRecords, signal) {
  const discovery = createEnsV2Discovery({
      inputs: {
        mode: "live",
        rpcUrl: WAVE6_SEPOLIA_RPC,
        names: WAVE6_ENS_NAMES,
        ttlMs: 30_000,
        timeoutMs: 15_000,
        maxTtlMs: 60_000,
      },
    }),
    listed = await discovery.list({
      names: WAVE6_ENS_NAMES,
      signal: signalWithTimeout(signal, 30_000),
    });
  if (listed.providers.length !== 2 || listed.errors.length)
    fail("LIVE_ENS_READBACK_FAILED");
  for (const provider of listed.providers) {
    const target = targetRecords[provider.providerId];
    if (
      !target ||
      provider.endpoint !== target[ENDPOINT_KEY] ||
      JSON.stringify(provider.profileIds) !== target[PROFILE_KEY] ||
      provider.paymentNetwork !== target["ethonline.payment.network"] ||
      provider.paymentAsset !== target["ethonline.payment.asset"] ||
      provider.paymentReceiver !== target["ethonline.payment.receiver"] ||
      provider.historyEndpoint !== target[HISTORY_KEY]
    )
      fail("LIVE_ENS_RECORD_MISMATCH");
  }
  return listed;
}

/**
 * Exact parent-call API. `targetRecords` carries both names and all six expected
 * public records. `walletFile` is a mode-0600 JSON file path; raw key material
 * is never accepted as an argument or environment variable.
 */
export async function repointWave6Ens({
  targetRecords: input,
  walletFile,
  journalDirectory,
  execute = false,
  approved = false,
  approvedTargetDigest,
  signal,
  originLookup,
  onStatus,
}) {
  const targetRecords = validateWave6TargetRecords(input),
    planDigest = digestOf({
      version: "ethonline.wave6.ens-repoint.v1",
      chainId: 11155111,
      owner: WAVE6_ENS_OWNER,
      targetRecords,
    });
  if (execute && (approved !== true || !walletFile || !journalDirectory))
    fail("EXPLICIT_OWNER_APPROVAL_REQUIRED");
  if (execute && approvedTargetDigest !== planDigest)
    fail("APPROVED_TARGET_DIGEST_REQUIRED");

  const origin = targetRecords[WAVE6_ENS_NAMES[0]][ENDPOINT_KEY],
    reachabilityBefore = await probeWave6PublicOrigin(origin, {
      signal,
      lookup: originLookup,
    }),
    transport = new FetchRequest(WAVE6_SEPOLIA_RPC);
  transport.timeout = 15_000;
  const provider = new JsonRpcProvider(transport, undefined, {
    cacheTimeout: -1,
  });
  try {
    if ((await provider.getNetwork()).chainId !== 11155111n)
      fail("SEPOLIA_ONLY");
    const resolver = createEnsV2Resolver({
        mode: "live",
        rpcUrl: WAVE6_SEPOLIA_RPC,
        ttlMs: 30_000,
        timeoutMs: 15_000,
      }),
      before = await captureResolution(resolver, signal);
    assertVerifiedSnapshot(before, targetRecords, "before");

    const previews = before.map((snapshot) =>
      buildWave6RecordUpdate(snapshot, targetRecords[snapshot.name]),
    );
    // Simulate exactly the owner calls at the independently verified proxy.
    // This is existing-name text authority, NOT the provision/new-name path.
    for (const preview of previews) {
      for (const tx of preview.transactions) {
        await provider.call({ ...tx, from: WAVE6_ENS_OWNER });
        tx.estimatedGas = String(
          await provider.estimateGas({ ...tx, from: WAVE6_ENS_OWNER }),
        );
      }
    }

    if (!execute)
      return {
        status: "preflight",
        broadcast: false,
        walletLoaded: false,
        chainId: 11155111,
        owner: WAVE6_ENS_OWNER,
        targetDigest: planDigest,
        reachability: reachabilityBefore,
        before,
        previews,
      };

    const walletPath = resolve(walletFile);
    assertPrivateDirectory(dirname(walletPath));
    const privateWallet = readPrivateFile(walletPath, {
      maxBytes: 8192,
      code: "PRIVATE_WALLET_REQUIRED",
    });
    let walletConfig;
    try {
      walletConfig = JSON.parse(privateWallet.data.toString("utf8"));
    } catch {
      fail("PRIVATE_WALLET_REQUIRED");
    }
    let wallet;
    try {
      wallet = new Wallet(walletConfig.privateKey, provider);
    } catch {
      fail("PRIVATE_WALLET_REQUIRED");
    }
    if (
      wallet.address.toLowerCase() !== WAVE6_ENS_OWNER.toLowerCase() ||
      typeof walletConfig.address !== "string" ||
      walletConfig.address.toLowerCase() !== WAVE6_ENS_OWNER.toLowerCase()
    )
      fail("DEDICATED_WALLET_REQUIRED");

    // Keep all record identities in the journal on every resume, even when a
    // prior transaction has already changed its record. Never drop an accepted
    // transaction merely because fresh on-chain readback now matches its target.
    const intents = previews.flatMap((preview) => preview.intents);
    const journal = await executeJournaledTransactions({
        provider,
        wallet,
        journalDirectory,
        planDigest,
        intents,
        chainId: 11155111,
        confirmations: CONFIRMATIONS,
        perTransactionLimitWei: PER_TRANSACTION_LIMIT_WEI,
        totalLimitWei: TOTAL_LIMIT_WEI,
        maximumGasPriceWei: MAXIMUM_GAS_PRICE_WEI,
        initialEvidence: {
          targetRecords,
          reachability: reachabilityBefore,
          before,
        },
        walletStillValid: () => sameFileState(walletPath, privateWallet.stat),
        onStatus,
        complete: async ({ transactions }) => {
          const reachabilityAfter = await probeWave6PublicOrigin(origin, {
              signal,
              lookup: originLookup,
            }),
            after = await captureResolution(resolver, signal);
          assertVerifiedSnapshot(after, targetRecords, "after");
          const discovery = await verifiedDiscovery(targetRecords, signal);
          return { transactions, reachabilityAfter, after, discovery };
        },
      }),
      initial = journal.initialEvidence,
      completion = journal.completion;
    return {
      status: "passed",
      observedAt: new Date().toISOString(),
      chainId: 11155111,
      owner: WAVE6_ENS_OWNER,
      targetDigest: planDigest,
      broadcast: journal.transactions.some(
        (transaction) => transaction.status === "confirmed",
      ),
      confirmedAtLeast: CONFIRMATIONS,
      before: initial.before,
      latestPreExecutionRead: before,
      after: completion.after,
      discovery: completion.discovery,
      reachability: {
        before: initial.reachability,
        after: completion.reachabilityAfter,
        externalNetworkVerified: false,
      },
      transactions: journal.transactions,
      maximumReservedFeeWei: journal.maximumReservedFeeWei,
      applicationJourneyVerified: false,
      inferenceVerified: false,
    };
  } finally {
    provider.destroy();
  }
}

function privateJson(path, code) {
  try {
    return JSON.parse(
      readPrivateFile(resolve(path), {
        maxBytes: 1024 * 1024,
        code,
      }).data.toString("utf8"),
    );
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        target: { type: "string" },
        wallet: { type: "string" },
        journal: { type: "string" },
        output: { type: "string" },
        execute: { type: "boolean" },
        approved: { type: "boolean" },
        "approved-target": { type: "string" },
        "public-dns": { type: "boolean" },
      },
    });
    if (!values.target) fail("PRIVATE_TARGET_REQUIRED");
    const dns = new Resolver({ timeout: 5000, tries: 2 });
    dns.setServers(["1.1.1.1"]);
    const targetRecords = privateJson(values.target, "PRIVATE_TARGET_REQUIRED"),
      result = await repointWave6Ens({
        targetRecords,
        originLookup: values["public-dns"]
          ? async (host) =>
              (await dns.resolve4(host)).map((address) => ({
                address,
                family: 4,
              }))
          : undefined,
        walletFile: values.wallet,
        journalDirectory: values.journal,
        execute: values.execute,
        approved: values.approved,
        approvedTargetDigest: values["approved-target"],
        onStatus: (status) => console.log(JSON.stringify(status)),
      });
    if (values.output) {
      const output = resolve(values.output);
      assertSafeParent(output);
      writePrivateExclusive(output, JSON.stringify(result, null, 2) + "\n");
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(safeCode(error, "ENS_REPOINT_FAILED"));
    process.exitCode = 1;
  }
}
