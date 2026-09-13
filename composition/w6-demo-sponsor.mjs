import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalBytes, requestHash } from "../packages/contracts/index.mjs";
import { createSinglePaymentGuard as maintainedSinglePaymentGuard } from "../scripts/w6-single-payment-guard.mjs";

const JOURNAL_VERSION = "w6-demo-sponsor-journal-v1";
const RESULT_VERSION = "w6-demo-sponsor-authorization-v1";
const DISPLAY_LABEL = "DEMO — sponsored testnet payment";
const UNAVAILABLE_LABEL = "DEMO sponsored payment unavailable";
const NETWORK = "hedera:testnet";
const ASSET = "0.0.0";
const GUARDED_RECIPIENT = "0.0.10419316";
const GUARDED_FEE_PAYER = "0.0.7162784";
const AMOUNT_BASE_UNITS = "1";
const NODE_ACCOUNT_IDS = Object.freeze(["0.0.3"]);
const PAYMENT_MODES = Object.freeze(["demo", "wallet"]);
const DEFAULT_PAYMENT_MODE = "demo";

/**
 * Resolve the active W6 payment mode. The mode is selected by the
 * `W6_PAYMENT_MODE` environment variable and selects between two
 * user-facing flows:
 *
 *   - `demo`   — server-side DEMO sponsor funds the user's inference
 *                requests. No client wallet, key material, or x402
 *                `payment-signature` header is required.
 *   - `wallet` — the client must supply its own x402
 *                `payment-signature` header (signed by the user's real
 *                Hedera account / HashPack / WalletConnect).
 *
 * The function is deliberately side-effect free and accepts an injected
 * `env` so it can be exercised directly from tests. Unknown values fall
 * back to the default and emit a single, well-formed warning so an
 * operator typo never disables the demo path.
 */
export function getPaymentMode({ env = process.env, warn = console.warn } = {}) {
  const raw = env?.W6_PAYMENT_MODE;
  if (raw === undefined || raw === "") return DEFAULT_PAYMENT_MODE;
  const value = String(raw).trim().toLowerCase();
  if (PAYMENT_MODES.includes(value)) return value;
  warn(
    `[w6-demo-sponsor] unknown W6_PAYMENT_MODE=${JSON.stringify(raw)}; falling back to ${DEFAULT_PAYMENT_MODE}`,
  );
  return DEFAULT_PAYMENT_MODE;
}

const paymentRequire = createRequire(
  new URL("../packages/payments/package.json", import.meta.url),
);

function fail(code, status, extra = {}) {
  throw Object.assign(new Error(code), {
    code,
    status,
    retryable: false,
    ...extra,
  });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAccountId(value) {
  return (
    typeof value === "string" && /^0\.0\.(0|[1-9][0-9]{0,18})$/.test(value)
  );
}

function safeId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    !/[\r\n\0]/.test(value)
  );
}

function decimal(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function integerSetting(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error("invalid setting");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error("invalid setting");
  return value;
}

function sameJson(left, right) {
  try {
    return canonicalBytes(left).equals(canonicalBytes(right));
  } catch {
    return false;
  }
}

function identityHash(kind, value) {
  return createHash("sha256")
    .update(`w6-demo:${kind}:v1\n${value}`)
    .digest("hex");
}

function validHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function inside(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function privateRegularFile(path, allowedRoot) {
  try {
    if (!inside(allowedRoot, path)) return false;
    const stat = lstatSync(path);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 &&
      stat.size >= 1 &&
      stat.size <= 16_384 &&
      (typeof process.getuid !== "function" || stat.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

function privateDirectory(path) {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || stat.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

function defaultReadKeyFile(path) {
  let fd;
  try {
    const before = lstatSync(path);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size < 1 ||
      opened.size > 16_384
    )
      fail("DEMO_UNAVAILABLE", 503);
    return readFileSync(fd);
  } catch (error) {
    if (error?.code === "DEMO_UNAVAILABLE") throw error;
    fail("DEMO_UNAVAILABLE", 503);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPrivateJournal(path) {
  let fd;
  try {
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > 1_048_576
    )
      throw new Error("invalid journal");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("journal changed");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let temporaryCounter = 0;
function writePrivateJournal(path, journal) {
  const temporary = `${path}.tmp-${process.pid}-${++temporaryCounter}`;
  let fd;
  let created = false;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    created = false;
    const directoryFd = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    fail("DEMO_UNAVAILABLE", 503);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
}

function validateJournal(value, maximumEntries) {
  if (
    !isRecord(value) ||
    value.version !== JOURNAL_VERSION ||
    !decimal(value.cumulativeSponsoredAmountBaseUnits) ||
    !Array.isArray(value.entries) ||
    value.entries.length > maximumEntries
  )
    throw new Error("invalid journal");
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !safeId(entry.quoteId) ||
      !safeId(entry.jobId) ||
      !safeId(entry.profileId) ||
      !safeId(entry.requestHash) ||
      !isAccountId(entry.recipient) ||
      !decimal(entry.amountBaseUnits) ||
      !["reserved-before-signing", "signed", "signing-failed"].includes(
        entry.status,
      ) ||
      !Number.isFinite(Date.parse(entry.expiresAt)) ||
      !Number.isFinite(Date.parse(entry.reservedAt)) ||
      !/^[0-9a-f]{64}$/.test(entry.sessionHash) ||
      !/^[0-9a-f]{64}$/.test(entry.ipHash)
    )
      throw new Error("invalid journal");
  }
}

function configuration(env, deps) {
  try {
    const accountId = env.W6_DEMO_SPONSOR_ACCOUNT;
    const recipient = env.W6_DEMO_RECIPIENT;
    const keyFile = resolve(env.W6_DEMO_SPONSOR_KEY_FILE ?? "");
    const origin = env.W6_PUBLIC_ORIGIN;
    const stateDir = resolve(env.W6_APP_STATE_DIR ?? "");
    const allowedKeyRoot = resolve(
      deps.allowedKeyRoot ?? join(homedir(), ".ethonline-testnet"),
    );
    if (
      !isAccountId(accountId) ||
      !isAccountId(recipient) ||
      recipient !== GUARDED_RECIPIENT ||
      accountId === recipient ||
      accountId === GUARDED_FEE_PAYER ||
      !validHttpsOrigin(origin) ||
      !privateDirectory(stateDir) ||
      !privateDirectory(allowedKeyRoot) ||
      !inside(allowedKeyRoot, keyFile)
    )
      throw new Error("invalid configuration");
    return {
      accountId,
      recipient,
      keyFile,
      origin,
      stateDir,
      allowedKeyRoot,
      journalFile: join(stateDir, "demo-sponsor-journal.json"),
      sessionBurst: integerSetting(env, "W6_DEMO_SESSION_BURST", 2, 1, 1000),
      sessionRefillMs: integerSetting(
        env,
        "W6_DEMO_SESSION_REFILL_MS",
        60_000,
        1000,
        86_400_000,
      ),
      ipBurst: integerSetting(env, "W6_DEMO_IP_BURST", 6, 1, 1000),
      ipRefillMs: integerSetting(
        env,
        "W6_DEMO_IP_REFILL_MS",
        60_000,
        1000,
        86_400_000,
      ),
      maxConcurrency: integerSetting(env, "W6_DEMO_MAX_CONCURRENCY", 1, 1, 32),
      queueCap: integerSetting(env, "W6_DEMO_QUEUE_CAP", 8, 0, 1024),
      bucketCap: integerSetting(
        env,
        "W6_DEMO_BUCKET_MAX_ENTRIES",
        4096,
        16,
        100_000,
      ),
      journalMaxEntries: integerSetting(
        env,
        "W6_DEMO_JOURNAL_MAX_ENTRIES",
        512,
        1,
        10_000,
      ),
    };
  } catch {
    return null;
  }
}

function createBuckets({ capacity, refillMs, maximumEntries, now }) {
  const buckets = new Map();
  function current(key, time) {
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maximumEntries) {
        for (const [candidate, existing] of buckets) {
          if (time - existing.updatedAt >= refillMs * 2)
            buckets.delete(candidate);
        }
      }
      if (buckets.size >= maximumEntries)
        fail("DEMO_RATE_LIMITED", 429, { retryAfterMs: refillMs });
      bucket = { tokens: capacity, updatedAt: time };
      buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, time - bucket.updatedAt);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed / refillMs);
    bucket.updatedAt = time;
    return bucket;
  }
  return { current };
}

function createQueue(maxConcurrency, queueCap) {
  let active = 0;
  const waiting = [];
  function dispatch() {
    while (active < maxConcurrency && waiting.length) {
      active += 1;
      waiting.shift()();
    }
  }
  return {
    async run(task) {
      if (active >= maxConcurrency && waiting.length >= queueCap)
        fail("DEMO_QUEUE_FULL", 429, { retryAfterMs: 1000 });
      if (active >= maxConcurrency) {
        await new Promise((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await task();
      } finally {
        active -= 1;
        dispatch();
      }
    },
    status() {
      return { active, queued: waiting.length, maxConcurrency, queueCap };
    },
  };
}

async function defaultCreatePaymentHeaders({
  accountId,
  keyBytes,
  challenge,
  quote,
  signal,
}) {
  let encoded;
  try {
    encoded = keyBytes.toString("utf8").trim();
    if (encoded.startsWith("{")) {
      const parsed = JSON.parse(encoded);
      if (!isRecord(parsed) || typeof parsed.privateKey !== "string")
        fail("DEMO_SIGNING_FAILED", 503);
      if (parsed.accountId !== undefined && parsed.accountId !== accountId)
        fail("DEMO_SIGNING_FAILED", 503);
      encoded = parsed.privateKey.trim();
    }
    const { PrivateKey } = paymentRequire("@x402/hedera");
    const key = PrivateKey.fromString(encoded.replace(/^0x/, ""));
    const { createBoundHederaSigner, createHederaPaymentAuthorizer } =
      await import("../packages/payments/src/client.mjs");
    const signer = createBoundHederaSigner({
      accountId,
      nodeAccountIds: NODE_ACCOUNT_IDS,
      signTransaction: (transaction) => transaction.sign(key),
    });
    const authorize = createHederaPaymentAuthorizer({
      signer,
      approve: () => true,
    });
    return await authorize({ challenge, quote, signal });
  } catch {
    fail("DEMO_SIGNING_FAILED", 503);
  } finally {
    encoded = undefined;
  }
}

function normalizeCall(input, session) {
  const context = isRecord(input?.quote) ? input : session?.paymentContext;
  const suppliedQuote = isRecord(input?.quote) ? input.quote : input;
  return { context, suppliedQuote };
}

/**
 * Server-side W6 DEMO sponsor. Construction and module import do not read the key
 * or access the network. `deps.getOutstandingQuote` is the trusted app-state seam;
 * without it no payment can be authorized.
 *
 * Viewer integration response (metadata remains server-authenticated; only
 * `headers` is returned from the viewer's paymentAuthorizer callback):
 * {
 *   "version":"w6-demo-sponsor-authorization-v1",
 *   "headers":{"payment-signature":"<x402 base64>"},
 *   "payer":{"accountId":"0.0.x","network":"hedera:testnet","role":"demo-sponsor"},
 *   "display":{"label":"DEMO — sponsored testnet payment"},
 *   "binding":{"jobId":"...","quoteId":"...","profileId":"sha256:...","requestHash":"sha256:...","recipient":"0.0.x","amountBaseUnits":"1"},
 *   "journal":{"status":"signed","sponsoredAt":"<ISO-8601>","cumulativeSponsoredAmountBaseUnits":"..."}
 * }
 */
export function createDemoSponsor({ env = process.env, deps = {} } = {}) {
  const config = configuration(env, deps);
  const now = deps.now ?? (() => Date.now());
  const getOutstandingQuote =
    deps.getOutstandingQuote ?? deps.lookupOutstandingQuote;
  const createGuard =
    deps.createSinglePaymentGuard ?? maintainedSinglePaymentGuard;
  const readKeyFile = deps.readKeyFile ?? defaultReadKeyFile;
  const createPaymentHeaders =
    deps.createPaymentHeaders ?? defaultCreatePaymentHeaders;
  let journal = {
    version: JOURNAL_VERSION,
    cumulativeSponsoredAmountBaseUnits: "0",
    entries: [],
  };
  let journalUnavailable = false;
  let runtimeUnavailableReason = null;

  if (config) {
    try {
      try {
        journal = readPrivateJournal(config.journalFile);
        validateJournal(journal, config.journalMaxEntries);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } catch {
      journalUnavailable = true;
    }
  }

  const sessionBuckets = config
    ? createBuckets({
        capacity: config.sessionBurst,
        refillMs: config.sessionRefillMs,
        maximumEntries: config.bucketCap,
        now,
      })
    : null;
  const ipBuckets = config
    ? createBuckets({
        capacity: config.ipBurst,
        refillMs: config.ipRefillMs,
        maximumEntries: config.bucketCap,
        now,
      })
    : null;
  const queue = config
    ? createQueue(config.maxConcurrency, config.queueCap)
    : null;

  function availability() {
    if (env.W6_DEMO_SPONSOR_ENABLED !== "1") return "kill-switch";
    if (!config) return "configuration";
    if (runtimeUnavailableReason) return runtimeUnavailableReason;
    if (journalUnavailable) return "journal-unavailable";
    if (!privateRegularFile(config.keyFile, config.allowedKeyRoot))
      return "key-unavailable";
    if (typeof getOutstandingQuote !== "function")
      return "quote-store-unavailable";
    if (typeof createGuard !== "function") return "guard-unavailable";
    return null;
  }

  function assertAvailable() {
    if (availability() !== null) fail("DEMO_UNAVAILABLE", 503);
  }

  function saveJournal() {
    try {
      validateJournal(journal, config.journalMaxEntries);
      writePrivateJournal(config.journalFile, journal);
    } catch {
      journalUnavailable = true;
      fail("DEMO_UNAVAILABLE", 503);
    }
  }

  function findEntry(quoteId) {
    return journal.entries.find((entry) => entry.quoteId === quoteId);
  }

  function reserve(metadata) {
    if (findEntry(metadata.quote.quoteId)) fail("DEMO_QUOTE_CONSUMED", 409);
    const observed = now();
    journal.entries = journal.entries.filter(
      (entry) => Date.parse(entry.expiresAt) > observed,
    );
    if (journal.entries.length >= config.journalMaxEntries)
      fail("DEMO_JOURNAL_FULL", 503);
    const entry = {
      quoteId: metadata.quote.quoteId,
      jobId: metadata.jobId,
      profileId: metadata.quote.profileId,
      requestHash: metadata.quote.requestHash,
      recipient: metadata.quote.receiver,
      amountBaseUnits: metadata.quote.amountBaseUnits,
      sessionHash: identityHash("session", metadata.sessionId),
      ipHash: identityHash("ip", metadata.ip),
      status: "reserved-before-signing",
      reservedAt: new Date(observed).toISOString(),
      expiresAt: metadata.quote.expiresAt,
    };
    journal.entries.push(entry);
    saveJournal();
    return entry;
  }

  function updateEntry(quoteId, status) {
    const entry = findEntry(quoteId);
    if (!entry) fail("DEMO_UNAVAILABLE", 503);
    if (status === "signed" && entry.status !== "signed") {
      journal.cumulativeSponsoredAmountBaseUnits = String(
        BigInt(journal.cumulativeSponsoredAmountBaseUnits) +
          BigInt(entry.amountBaseUnits),
      );
      entry.sponsoredAt = new Date(now()).toISOString();
    }
    entry.status = status;
    saveJournal();
    return entry;
  }

  function consumeRate(sessionId, ip) {
    const observed = now();
    const sessionBucket = sessionBuckets.current(sessionId, observed);
    const ipBucket = ipBuckets.current(ip, observed);
    if (sessionBucket.tokens < 1 || ipBucket.tokens < 1) {
      const retryAfterMs = Math.max(
        sessionBucket.tokens < 1 ? config.sessionRefillMs : 0,
        ipBucket.tokens < 1 ? config.ipRefillMs : 0,
      );
      fail("DEMO_RATE_LIMITED", 429, { retryAfterMs });
    }
    sessionBucket.tokens -= 1;
    ipBucket.tokens -= 1;
  }

  async function validateScope(input, session) {
    const { context, suppliedQuote } = normalizeCall(input, session);
    const sessionId = session?.sessionId ?? session?.id;
    const ip = session?.ip ?? session?.ipAddress;
    const jobId = session?.jobId;
    if (
      !isRecord(context) ||
      !isRecord(suppliedQuote) ||
      !isRecord(context.quote) ||
      !isRecord(context.request) ||
      !safeId(sessionId) ||
      !safeId(ip) ||
      !safeId(jobId) ||
      context.idempotencyKey !== jobId ||
      !sameJson(context.quote, suppliedQuote) ||
      suppliedQuote.receiver !== config.recipient ||
      suppliedQuote.network !== NETWORK ||
      suppliedQuote.asset !== ASSET ||
      suppliedQuote.amountBaseUnits !== AMOUNT_BASE_UNITS ||
      suppliedQuote.mode !== "live" ||
      suppliedQuote.providerId !== context.request.providerId ||
      suppliedQuote.profileId !== context.request.profileId ||
      suppliedQuote.requestHash !== requestHash(context.request) ||
      Date.parse(suppliedQuote.expiresAt) <= now()
    )
      fail("DEMO_SCOPE_MISMATCH", 403);

    let outstanding;
    try {
      outstanding = await getOutstandingQuote({
        quoteId: suppliedQuote.quoteId,
        sessionId,
        jobId,
        request: structuredClone(context.request),
      });
    } catch {
      fail("DEMO_UNAVAILABLE", 503);
    }
    if (
      !isRecord(outstanding) ||
      outstanding.sessionId !== sessionId ||
      outstanding.jobId !== jobId ||
      !sameJson(outstanding.quote, suppliedQuote) ||
      !sameJson(outstanding.request, context.request)
    )
      fail("DEMO_SCOPE_MISMATCH", 403);

    return {
      context,
      quote: suppliedQuote,
      sessionId,
      ip,
      jobId,
    };
  }

  return Object.freeze({
    async authorizeForQuote(input, session) {
      assertAvailable();
      const metadata = await validateScope(input, session);
      if (findEntry(metadata.quote.quoteId)) fail("DEMO_QUOTE_CONSUMED", 409);
      consumeRate(metadata.sessionId, metadata.ip);
      assertAvailable();
      return queue.run(async () => {
        assertAvailable();
        if (metadata.context.signal?.aborted) fail("DEMO_UNAVAILABLE", 503);
        if (findEntry(metadata.quote.quoteId)) fail("DEMO_QUOTE_CONSUMED", 409);
        let reserved = false;
        const guard = createGuard({
          origin: config.origin,
          providerId: metadata.quote.providerId,
          expectedRequestHash: metadata.quote.requestHash,
          reserve(state) {
            if (
              state?.quoteId !== metadata.quote.quoteId ||
              state?.requestHash !== metadata.quote.requestHash ||
              state?.amountBaseUnits !== metadata.quote.amountBaseUnits
            )
              fail("DEMO_SCOPE_MISMATCH", 403);
            reserve(metadata);
            reserved = true;
          },
          async authorize({ challenge, quote, signal }) {
            if (!reserved) fail("DEMO_SCOPE_MISMATCH", 403);
            assertAvailable();
            const activeSignal = signal ?? metadata.context.signal;
            if (activeSignal?.aborted) fail("DEMO_UNAVAILABLE", 503);
            let keyBytes;
            try {
              keyBytes = readKeyFile(config.keyFile);
              if (!Buffer.isBuffer(keyBytes)) keyBytes = Buffer.from(keyBytes);
              if (keyBytes.length < 1 || keyBytes.length > 16_384)
                fail("DEMO_UNAVAILABLE", 503);
              return await createPaymentHeaders({
                accountId: config.accountId,
                keyBytes,
                challenge,
                quote,
                signal: activeSignal,
              });
            } catch (error) {
              if (error?.code === "DEMO_UNAVAILABLE") {
                runtimeUnavailableReason = "key-unavailable";
                throw error;
              }
              fail("DEMO_SIGNING_FAILED", 503);
            } finally {
              keyBytes?.fill(0);
            }
          },
        });
        let headers;
        try {
          headers = await guard(metadata.context);
        } catch (error) {
          if (
            reserved &&
            findEntry(metadata.quote.quoteId)?.status ===
              "reserved-before-signing"
          ) {
            try {
              updateEntry(metadata.quote.quoteId, "signing-failed");
            } catch {}
          }
          if (error?.code?.startsWith("DEMO_")) throw error;
          if (error?.message === "ATTEMPT_CONSUMED")
            fail("DEMO_QUOTE_CONSUMED", 409);
          if (error?.message === "PAYMENT_SCOPE_MISMATCH")
            fail("DEMO_SCOPE_MISMATCH", 403);
          fail("DEMO_SIGNING_FAILED", 503);
        }
        if (
          !reserved ||
          !isRecord(headers) ||
          Object.keys(headers).sort().join(",") !== "payment-signature" ||
          typeof headers["payment-signature"] !== "string" ||
          headers["payment-signature"].length < 1 ||
          headers["payment-signature"].length > 16_384 ||
          /[\r\n]/.test(headers["payment-signature"])
        )
          fail("DEMO_SIGNING_FAILED", 503);
        const entry = updateEntry(metadata.quote.quoteId, "signed");
        return {
          version: RESULT_VERSION,
          headers: structuredClone(headers),
          payer: {
            accountId: config.accountId,
            network: NETWORK,
            role: "demo-sponsor",
          },
          display: { label: DISPLAY_LABEL },
          binding: {
            jobId: metadata.jobId,
            quoteId: metadata.quote.quoteId,
            profileId: metadata.quote.profileId,
            requestHash: metadata.quote.requestHash,
            recipient: metadata.quote.receiver,
            amountBaseUnits: metadata.quote.amountBaseUnits,
          },
          journal: {
            status: entry.status,
            sponsoredAt: entry.sponsoredAt,
            cumulativeSponsoredAmountBaseUnits:
              journal.cumulativeSponsoredAmountBaseUnits,
          },
        };
      });
    },
    status() {
      const reason = availability();
      return {
        status: reason ? "demo-unavailable" : "available",
        label: reason ? UNAVAILABLE_LABEL : DISPLAY_LABEL,
        ...(reason ? { reason } : {}),
        payerAccountId: config?.accountId,
        recipient: config?.recipient,
        cumulativeSponsoredAmountBaseUnits:
          journal.cumulativeSponsoredAmountBaseUnits,
        recent: structuredClone(journal.entries),
        queue: queue?.status() ?? {
          active: 0,
          queued: 0,
          maxConcurrency: 0,
          queueCap: 0,
        },
      };
    },
  });
}

/** Mirror-only balance check for w6-monitor. It never reads the sponsor key and
 * never initiates a top-up; `topUpNeeded: true` is an owner-action alert. */
export async function getBalanceIfNeeded({
  env = process.env,
  deps = {},
} = {}) {
  const accountId = env.W6_DEMO_SPONSOR_ACCOUNT;
  const threshold = env.W6_DEMO_TOPUP_THRESHOLD ?? "1000000";
  const mirror =
    env.W6_DEMO_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com";
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const observedAt = new Date(now()).toISOString();
  try {
    const mirrorUrl = new URL(mirror);
    if (
      !isAccountId(accountId) ||
      !decimal(threshold) ||
      mirrorUrl.protocol !== "https:" ||
      mirrorUrl.username ||
      mirrorUrl.password ||
      mirrorUrl.search ||
      mirrorUrl.hash ||
      !["", "/"].includes(mirrorUrl.pathname) ||
      typeof fetchImpl !== "function"
    )
      throw new Error("invalid balance configuration");
    const base = mirror.replace(/\/$/, "");
    const response = await fetchImpl(`${base}/api/v1/accounts/${accountId}`, {
      method: "GET",
      redirect: "error",
      signal: deps.signal ?? AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("mirror unavailable");
    const body = await response.json();
    const raw = body?.balance?.balance;
    const balance =
      typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
        ? String(raw)
        : raw;
    if (
      body?.account !== accountId ||
      body?.deleted === true ||
      !decimal(balance)
    )
      throw new Error("invalid mirror response");
    return {
      status: "ok",
      accountId,
      balanceBaseUnits: balance,
      thresholdBaseUnits: threshold,
      topUpNeeded: BigInt(balance) < BigInt(threshold),
      observedAt,
    };
  } catch {
    return {
      status: "demo-unavailable",
      reason: "balance-unavailable",
      ...(isAccountId(accountId) ? { accountId } : {}),
      observedAt,
    };
  }
}
