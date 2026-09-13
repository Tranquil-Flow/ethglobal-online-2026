import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requestHash } from "../../packages/contracts/index.mjs";

const moduleUrl = new URL("../w6-demo-sponsor.mjs", import.meta.url);
const origin = "https://example.org";
const providerId = "worker.example.eth";
const recipient = "0.0.10419316";
const sponsorAccount = "0.0.10500001";
const secret = "302e020100300506032b657004220420" + "7a".repeat(32);

async function loadSponsor(suffix = "") {
  return import(moduleUrl.href + suffix);
}

function createFixture({ now = Date.now(), suffix = "one" } = {}) {
  const request = {
    version: "1",
    nonce: createHash("sha256").update(suffix).digest("hex"),
    sampling: "greedy",
    providerId,
    profileId: "sha256:" + "a".repeat(64),
    prompt: "Synthetic garden " + suffix,
    maxOutputTokens: 8,
    seed: 0,
    publishConsent: false,
  };
  const quote = {
    quoteId: "quote-" + suffix,
    providerId,
    profileId: request.profileId,
    requestHash: requestHash(request),
    mode: "live",
    network: "hedera:testnet",
    asset: "0.0.0",
    receiver: recipient,
    amountBaseUnits: "1",
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const body = {
    x402Version: 2,
    resource: { url: `${origin}/v1/jobs/quotes/${quote.quoteId}` },
    accepts: [
      {
        scheme: "exact",
        network: quote.network,
        asset: quote.asset,
        amount: quote.amountBaseUnits,
        payTo: quote.receiver,
        maxTimeoutSeconds: 120,
        extra: {
          feePayer: "0.0.7162784",
          memo: "ethonline:" + "b".repeat(64),
        },
      },
    ],
  };
  const context = {
    status: 402,
    body,
    headers: {
      "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
    },
    quote,
    request,
    baseUrl: origin,
    idempotencyKey: "job-" + suffix,
    budget: {
      maxAmountBaseUnits: quote.amountBaseUnits,
      asset: quote.asset,
      network: quote.network,
    },
  };
  const session = {
    sessionId: "session-" + suffix,
    ip: "192.0.2.10",
    jobId: context.idempotencyKey,
    paymentContext: context,
  };
  const outstanding = {
    sessionId: session.sessionId,
    jobId: session.jobId,
    quote: structuredClone(quote),
    request: structuredClone(request),
  };
  return { request, quote, context, session, outstanding };
}

function harness(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "w6-demo-sponsor-"));
  const stateDir = join(root, "app-state");
  const keyRoot = join(root, "keys");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(keyRoot, { mode: 0o700 });
  const keyFile = join(keyRoot, "demo-sponsor.key");
  writeFileSync(keyFile, secret + "\n", { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const env = {
    W6_DEMO_SPONSOR_ENABLED: "1",
    W6_DEMO_SPONSOR_ACCOUNT: sponsorAccount,
    W6_DEMO_SPONSOR_KEY_FILE: keyFile,
    W6_DEMO_RECIPIENT: recipient,
    W6_PUBLIC_ORIGIN: origin,
    W6_APP_STATE_DIR: stateDir,
    W6_DEMO_SESSION_BURST: "3",
    W6_DEMO_SESSION_REFILL_MS: "60000",
    W6_DEMO_IP_BURST: "6",
    W6_DEMO_IP_REFILL_MS: "60000",
    W6_DEMO_MAX_CONCURRENCY: "1",
    W6_DEMO_QUEUE_CAP: "2",
    W6_DEMO_JOURNAL_MAX_ENTRIES: "8",
    ...overrides.env,
  };
  const records = new Map();
  let guardCalls = 0;
  let signatures = 0;
  let keyReads = 0;
  const deps = {
    allowedKeyRoot: keyRoot,
    getOutstandingQuote: async ({ quoteId }) => records.get(quoteId) ?? null,
    createSinglePaymentGuard(options) {
      return async (context) => {
        guardCalls += 1;
        await options.reserve({
          quoteId: context.quote.quoteId,
          requestHash: context.quote.requestHash,
          amountBaseUnits: context.quote.amountBaseUnits,
        });
        return options.authorize({
          challenge: context.body,
          quote: context.quote,
          signal: context.signal,
        });
      };
    },
    readKeyFile(path) {
      keyReads += 1;
      return readFileSync(path);
    },
    async createPaymentHeaders({ keyBytes }) {
      signatures += 1;
      assert.equal(keyBytes.toString("utf8").trim(), secret);
      return { "payment-signature": "synthetic-proof" };
    },
    ...overrides.deps,
  };
  return {
    root,
    stateDir,
    keyFile,
    env,
    deps,
    records,
    counts: () => ({ guardCalls, signatures, keyReads }),
  };
}

function register(h, fixture) {
  h.records.set(fixture.quote.quoteId, fixture.outstanding);
}

async function rejectsCode(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.equal(String(error.message), code);
    return true;
  });
}

test("module import performs no network or key read", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("NETWORK_AT_IMPORT");
  };
  try {
    const imported = await loadSponsor("?no-side-effects=" + Date.now());
    assert.equal(typeof imported.createDemoSponsor, "function");
    assert.equal(typeof imported.getBalanceIfNeeded, "function");
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("missing account, missing or non-private key, and disabled switch fail closed", async () => {
  const { createDemoSponsor } = await loadSponsor();
  for (const mutate of [
    (h) => delete h.env.W6_DEMO_SPONSOR_ACCOUNT,
    (h) => (h.env.W6_DEMO_SPONSOR_KEY_FILE = join(h.root, "missing.key")),
    (h) => chmodSync(h.keyFile, 0o644),
    (h) => (h.env.W6_DEMO_SPONSOR_ENABLED = "0"),
  ]) {
    const h = harness();
    const f = createFixture();
    register(h, f);
    mutate(h);
    const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
    assert.equal(sponsor.status().status, "demo-unavailable");
    await rejectsCode(
      sponsor.authorizeForQuote(f.quote, f.session),
      "DEMO_UNAVAILABLE",
      503,
    );
    assert.deepEqual(h.counts(), { guardCalls: 0, signatures: 0, keyReads: 0 });
  }
});

test("wrong recipient, unknown quote, job, or profile refuses before guard or key read", async () => {
  const { createDemoSponsor } = await loadSponsor();
  for (const mutate of [
    (_h, f) => (f.context.quote.receiver = "0.0.999"),
    (_h, f) => (f.context.quote.quoteId = "quote-not-issued-here"),
    (_h, f) => (f.session.jobId = "job-other"),
    (_h, f) => (f.context.quote.profileId = "sha256:" + "d".repeat(64)),
  ]) {
    const h = harness();
    const f = createFixture();
    register(h, f);
    mutate(h, f);
    const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
    await rejectsCode(
      sponsor.authorizeForQuote(f.context, f.session),
      "DEMO_SCOPE_MISMATCH",
      403,
    );
    assert.deepEqual(h.counts(), { guardCalls: 0, signatures: 0, keyReads: 0 });
  }
});

test("an app-issued quote is consumed exactly once through the injected single-payment guard", async () => {
  const { createDemoSponsor } = await loadSponsor();
  const h = harness();
  const f = createFixture();
  register(h, f);
  const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
  const result = await sponsor.authorizeForQuote(f.quote, f.session);
  assert.deepEqual(result.headers, { "payment-signature": "synthetic-proof" });
  assert.deepEqual(result.payer, {
    accountId: sponsorAccount,
    network: "hedera:testnet",
    role: "demo-sponsor",
  });
  assert.equal(result.display.label, "DEMO — sponsored testnet payment");
  assert.equal(result.binding.jobId, f.session.jobId);
  assert.equal(result.binding.quoteId, f.quote.quoteId);
  assert.equal(result.binding.profileId, f.quote.profileId);
  await rejectsCode(
    sponsor.authorizeForQuote(f.quote, f.session),
    "DEMO_QUOTE_CONSUMED",
    409,
  );
  const restarted = createDemoSponsor({ env: h.env, deps: h.deps });
  await rejectsCode(
    restarted.authorizeForQuote(f.quote, f.session),
    "DEMO_QUOTE_CONSUMED",
    409,
  );
  assert.deepEqual(h.counts(), { guardCalls: 1, signatures: 1, keyReads: 1 });
});

test("the production composition routes the signer through the maintained single-payment guard", async () => {
  const { createDemoSponsor } = await loadSponsor();
  const h = harness();
  delete h.deps.createSinglePaymentGuard;
  const f = createFixture({ suffix: "real-guard" });
  register(h, f);
  const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
  const result = await sponsor.authorizeForQuote(f.quote, f.session);
  assert.deepEqual(result.headers, { "payment-signature": "synthetic-proof" });
  assert.deepEqual(h.counts(), { guardCalls: 0, signatures: 1, keyReads: 1 });
  await rejectsCode(
    sponsor.authorizeForQuote(f.quote, f.session),
    "DEMO_QUOTE_CONSUMED",
    409,
  );
});

test("a malformed injected guard cannot reach the key before reservation", async () => {
  const { createDemoSponsor } = await loadSponsor();
  const h = harness({
    deps: {
      createSinglePaymentGuard(options) {
        return (context) =>
          options.authorize({
            challenge: context.body,
            quote: context.quote,
            signal: context.signal,
          });
      },
    },
  });
  const f = createFixture({ suffix: "guard-order" });
  register(h, f);
  const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
  await rejectsCode(
    sponsor.authorizeForQuote(f.quote, f.session),
    "DEMO_SCOPE_MISMATCH",
    403,
  );
  assert.deepEqual(h.counts(), { guardCalls: 0, signatures: 0, keyReads: 0 });
});

test("per-session and per-IP rate limits reject before guard and signing", async () => {
  const { createDemoSponsor } = await loadSponsor();
  for (const { env, alter } of [
    {
      env: { W6_DEMO_SESSION_BURST: "1", W6_DEMO_IP_BURST: "5" },
      alter: (f) => (f.session.ip = "192.0.2.11"),
    },
    {
      env: { W6_DEMO_SESSION_BURST: "5", W6_DEMO_IP_BURST: "1" },
      alter: (f) => (f.session.sessionId = "session-other"),
    },
  ]) {
    const h = harness({ env });
    const first = createFixture({ suffix: "rate-a" });
    const second = createFixture({ suffix: "rate-b" });
    second.session.sessionId = first.session.sessionId;
    second.outstanding.sessionId = first.session.sessionId;
    second.session.ip = first.session.ip;
    alter(second);
    second.outstanding.sessionId = second.session.sessionId;
    register(h, first);
    register(h, second);
    const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
    await sponsor.authorizeForQuote(first.quote, first.session);
    await rejectsCode(
      sponsor.authorizeForQuote(second.quote, second.session),
      "DEMO_RATE_LIMITED",
      429,
    );
    assert.deepEqual(h.counts(), { guardCalls: 1, signatures: 1, keyReads: 1 });
  }
});

test("global concurrency queue cap rejects excess work before signing", async () => {
  const { createDemoSponsor } = await loadSponsor();
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => (releaseFirst = resolve));
  let first = true;
  const h = harness({
    env: { W6_DEMO_QUEUE_CAP: "1" },
    deps: {
      async createPaymentHeaders() {
        if (first) {
          first = false;
          await firstBlocked;
        }
        return { "payment-signature": "synthetic-proof" };
      },
    },
  });
  const a = createFixture({ suffix: "queue-a" });
  const b = createFixture({ suffix: "queue-b" });
  const c = createFixture({ suffix: "queue-c" });
  for (const f of [a, b, c]) register(h, f);
  const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
  const pendingA = sponsor.authorizeForQuote(a.quote, a.session);
  await new Promise((resolve) => setImmediate(resolve));
  const pendingB = sponsor.authorizeForQuote(b.quote, b.session);
  await new Promise((resolve) => setImmediate(resolve));
  await rejectsCode(
    sponsor.authorizeForQuote(c.quote, c.session),
    "DEMO_QUEUE_FULL",
    429,
  );
  assert.equal(h.counts().guardCalls, 1);
  releaseFirst();
  await pendingA;
  await pendingB;
  assert.equal(h.counts().guardCalls, 2);
});

test("kill switch is checked again immediately before queue admission", async () => {
  const { createDemoSponsor } = await loadSponsor();
  const h = harness();
  const f = createFixture({ suffix: "kill" });
  register(h, f);
  const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
  assert.equal(sponsor.status().status, "available");
  h.env.W6_DEMO_SPONSOR_ENABLED = "0";
  await rejectsCode(
    sponsor.authorizeForQuote(f.quote, f.session),
    "DEMO_UNAVAILABLE",
    503,
  );
  assert.equal(sponsor.status().reason, "kill-switch");
  assert.deepEqual(h.counts(), { guardCalls: 0, signatures: 0, keyReads: 0 });
});

test("bounded journal retains cumulative sponsored amount without retaining secrets", async () => {
  const { createDemoSponsor } = await loadSponsor();
  let now = Date.now();
  const h = harness({
    env: { W6_DEMO_JOURNAL_MAX_ENTRIES: "2" },
    deps: { now: () => now },
  });
  const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
  for (const suffix of ["journal-a", "journal-b"]) {
    const f = createFixture({ now, suffix });
    register(h, f);
    await sponsor.authorizeForQuote(f.quote, f.session);
  }
  now += 61_000;
  const third = createFixture({ now, suffix: "journal-c" });
  register(h, third);
  await sponsor.authorizeForQuote(third.quote, third.session);
  const status = sponsor.status();
  assert.equal(status.cumulativeSponsoredAmountBaseUnits, "3");
  assert(status.recent.length <= 2);
  const journal = readFileSync(
    join(h.stateDir, "demo-sponsor-journal.json"),
    "utf8",
  );
  assert.doesNotMatch(journal, new RegExp(secret));
  assert.doesNotMatch(journal, /payment-signature|synthetic-proof/);
});

test("key bytes cannot escape signer failures into errors or the journal", async () => {
  const { createDemoSponsor } = await loadSponsor();
  const h = harness({
    deps: {
      async createPaymentHeaders({ keyBytes }) {
        throw new Error("native failure " + keyBytes.toString("utf8"));
      },
    },
  });
  const f = createFixture({ suffix: "secret-failure" });
  register(h, f);
  const sponsor = createDemoSponsor({ env: h.env, deps: h.deps });
  await assert.rejects(
    sponsor.authorizeForQuote(f.quote, f.session),
    (error) => {
      assert.equal(error.code, "DEMO_SIGNING_FAILED");
      assert.doesNotMatch(String(error.message), new RegExp(secret));
      return true;
    },
  );
  const journal = readFileSync(
    join(h.stateDir, "demo-sponsor-journal.json"),
    "utf8",
  );
  assert.doesNotMatch(journal, new RegExp(secret));
});

test("balance helper uses only mirror REST and reports the owner top-up threshold", async () => {
  const { getBalanceIfNeeded } = await loadSponsor();
  let requested;
  const result = await getBalanceIfNeeded({
    env: {
      W6_DEMO_SPONSOR_ACCOUNT: sponsorAccount,
      W6_DEMO_TOPUP_THRESHOLD: "1000",
      W6_DEMO_MIRROR_URL: "https://mirror.example",
    },
    deps: {
      now: () => 1_700_000_000_000,
      fetch: async (url) => {
        requested = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            account: sponsorAccount,
            deleted: false,
            balance: { balance: 999 },
          }),
        };
      },
    },
  });
  assert.equal(
    requested,
    `https://mirror.example/api/v1/accounts/${sponsorAccount}`,
  );
  assert.deepEqual(result, {
    status: "ok",
    accountId: sponsorAccount,
    balanceBaseUnits: "999",
    thresholdBaseUnits: "1000",
    topUpNeeded: true,
    observedAt: "2023-11-14T22:13:20.000Z",
  });
});
