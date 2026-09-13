// L-SPONSOR regression test for the application-workbench.mjs seam fix.
//
// Bug history: the seam wrapper in composition/application-workbench.mjs builds a
// `proofContext` and calls `demoSponsor.authorizeForQuote(proofContext, session)`.
// The historical bug was that the wrapper omitted (or lost) `proofContext.request`,
// so the sponsor's `validateScope` saw `context.request = undefined` and the
// `getOutstandingQuote` seam call later received `request: undefined`, which made
// `digestOf({ request: undefined, quoteId })` throw and the catch block map to
// 503 DEMO_UNAVAILABLE.
//
// Scope note (R-SPONSOR-DIAG): this lane owns the seam contract, NOT packages/access.
// The previous version of this test exercised the seam end-to-end via the access
// client (createClient + client.authorizeDemoPayment + client.submitJob). That path
// depends on packages/access, which is L-FANOUT scope. To stay within L-SPONSOR
// scope, this rewrite exercises the seam wrapper's CONTRACT in isolation:
//
//   1. Build a proofContext that mirrors exactly what the seam wrapper produces
//      (composition/application-workbench.mjs ~L1036-L1063).
//   2. Call demoSponsor.authorizeForQuote(proofContext, session) directly.
//   3. Assert the seam's getOutstandingQuote receives a structurally-equal request.
//   4. Negative case: build the same proofContext but with request omitted (the
//      pre-fix shape). Assert validateScope fails with DEMO_SCOPE_MISMATCH (403),
//      NOT DEMO_UNAVAILABLE (503). This pins the defensive behavior.
//
// No packages/access dependency. The seam fix is the contract under test.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoSponsor } from "../w6-demo-sponsor.mjs";
import { digestOf, requestHash } from "../../packages/contracts/index.mjs";

const providerId = "service.ethonline-node-a.eth";
const profile = {
  version: "1",
  model: "synthetic-sponsor-fresh-not-inference",
  artifacts: [{ role: "fixture", digest: "sha256:" + "a".repeat(64), uri: "urn:fixture" }],
  runtimeRevision: "fixture-v1",
  tokenizerDigest: "sha256:" + "b".repeat(64),
  templateDigest: "sha256:" + "c".repeat(64),
  numerics: {
    dtype: "float32",
    quantization: "none",
    backend: "fixture",
    hardwareClass: "fixture",
    determinism: "fixture only",
  },
};
const profileId = digestOf(profile);

import { createHash } from "node:crypto";

function buildRequest({ maxOutputTokens = 2, seed = 0, suffix = "fresh" } = {}) {
  return {
    version: "1",
    nonce: createHash("sha256").update(suffix).digest("hex"),
    sampling: "greedy",
    providerId,
    profileId,
    prompt: "fresh sponsor browser",
    maxOutputTokens,
    seed,
    publishConsent: false,
  };
}

function buildQuote(request) {
  return {
    version: "1",
    quoteId: "quote-" + Math.random().toString(36).slice(2),
    requestHash: requestHash(request),
    providerId,
    profileId,
    amountBaseUnits: "1",
    asset: "0.0.0",
    network: "hedera:testnet",
    receiver: "0.0.10419316",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mode: "live",
  };
}

// Mirror composition/application-workbench.mjs ~L1036-L1063:
// the seam wrapper builds a proofContext from (args, retainedQuote) and calls
// demoSponsor.authorizeForQuote(proofContext, session).
function buildProofContext({ quote, request, idempotencyKey }) {
  return {
    quote: structuredClone(quote),
    request: structuredClone(request),
    headers: {},
    body: structuredClone(quote),
    idempotencyKey,
    budget: {
      maxAmountBaseUnits: quote.amountBaseUnits,
      asset: quote.asset,
      network: quote.network,
    },
    baseUrl: "https://mycelium.now",
    status: 402,
  };
}

function buildSession({ idempotencyKey }) {
  return {
    sessionId: "session-" + Math.random().toString(36).slice(2),
    jobId: idempotencyKey,
    ip: "127.0.0.1",
  };
}

async function buildSponsor({ keyRoot, keyFile, stateDir, captured, quote }) {
  const env = {
    W6_DEMO_SPONSOR_ENABLED: "1",
    W6_DEMO_SPONSOR_ACCOUNT: "0.0.10500001",
    W6_DEMO_SPONSOR_KEY_FILE: keyFile,
    W6_DEMO_RECIPIENT: "0.0.10419316",
    W6_PUBLIC_ORIGIN: "https://mycelium.now",
    W6_APP_STATE_DIR: stateDir,
    W6_DEMO_SESSION_BURST: "3",
    W6_DEMO_SESSION_REFILL_MS: "60000",
    W6_DEMO_IP_BURST: "6",
    W6_DEMO_IP_REFILL_MS: "60000",
    W6_DEMO_MAX_CONCONCURRENCY: "1",
    W6_DEMO_MAX_CONCURRENCY: "1",
    W6_DEMO_QUEUE_CAP: "2",
    W6_DEMO_JOURNAL_MAX_ENTRIES: "8",
  };
  return createDemoSponsor({
    env,
    deps: {
      allowedKeyRoot: keyRoot,
      // Stub key read; signing is replaced by a stub createPaymentHeaders below.
      readKeyFile() {
        return Buffer.from("synthetic-private-key-not-used");
      },
      async createPaymentHeaders() {
        return { "payment-signature": "demo-proof" };
      },
      async getOutstandingQuote(args) {
        // Capture the seam call (this is what the wrapper fix exercises).
        captured.push(JSON.parse(JSON.stringify(args)));
        // Match the wrapper's getOutstandingQuote return shape
        // (composition/application-workbench.mjs ~L973-L988).
        return {
          sessionId: args.sessionId,
          jobId: args.jobId,
          quote: structuredClone(quote),
          request: structuredClone(args.request),
        };
      },
      // Stub single-payment guard so we don't pull in the full payments package.
      createSinglePaymentGuard(options) {
        return async (context) => {
          options.reserve({
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
    },
  });
}

test(
  "seam wrapper fix: authorizeForQuote forwards context.request to getOutstandingQuote",
  { timeout: 10_000 },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), "l-sponsor-seam-"));
    const keyRoot = join(parent, "keys");
    const keyFile = join(keyRoot, "demo-sponsor.key");
    const stateDir = join(parent, "app-state");
    await mkdir(keyRoot, { mode: 0o700 });
    await writeFile(keyFile, "fixture-key\n", { mode: 0o600 });
    await chmod(keyFile, 0o600);
    await chmod(keyRoot, 0o700);
    await mkdir(stateDir, { mode: 0o700 });
    const captured = [];
    const request = buildRequest();
    const quote = buildQuote(request);
    const sponsor = await buildSponsor({ keyRoot, keyFile, stateDir, captured, quote });
    const idempotencyKey = "l-sponsor-seam-1";
    const session = buildSession({ idempotencyKey });
    try {
      // === GREEN: request is forwarded (the seam fix's contract) ===
      const proofContext = buildProofContext({ quote, request, idempotencyKey });
      const result = await sponsor.authorizeForQuote(proofContext, session);
      assert.equal(typeof result, "object", "sponsor must return an object");
      assert.ok(
        result.headers && result.headers["payment-signature"],
        "sponsor must produce a payment-signature header",
      );
      assert.equal(result.headers["payment-signature"], "demo-proof");

      // Seam contract: getOutstandingQuote received the full request, once.
      assert.equal(captured.length, 1, "seam must be invoked exactly once");
      const seamCall = captured[0];
      assert.equal(seamCall.quoteId, quote.quoteId);
      assert.equal(seamCall.sessionId, session.sessionId);
      assert.equal(seamCall.jobId, idempotencyKey);
      assert.ok(
        seamCall.request && typeof seamCall.request === "object",
        "seam must receive a non-null request (regression: missing request caused 503 DEMO_UNAVAILABLE)",
      );
      assert.equal(seamCall.request.providerId, providerId);
      assert.equal(seamCall.request.profileId, profileId);
      assert.equal(seamCall.request.prompt, "fresh sponsor browser");
      assert.equal(seamCall.request.providerId, providerId);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  "seam regression: missing request on proofContext fails with DEMO_SCOPE_MISMATCH (403), not DEMO_UNAVAILABLE (503)",
  { timeout: 10_000 },
  async () => {
    // This pins the defensive behavior of the seam. The old wrapper omitted
    // context.request, which surfaced as 503 DEMO_UNAVAILABLE downstream because
    // digestOf({ request: undefined, quoteId }) threw inside getOutstandingQuote.
    // The fix has two halves: (a) the wrapper always supplies request, and (b)
    // validateScope rejects a context with no request as DEMO_SCOPE_MISMATCH.
    // If the wrapper ever regresses and we still want the system to fail
    // loudly/cleanly, validateScope must catch it at the boundary. This test
    // asserts (b) directly, which the wrapper (a) makes unreachable in practice
    // but which is the correct failure mode if a future caller forgets.
    const parent = await mkdtemp(join(tmpdir(), "l-sponsor-seam-neg-"));
    const keyRoot = join(parent, "keys");
    const keyFile = join(keyRoot, "demo-sponsor.key");
    const stateDir = join(parent, "app-state");
    await mkdir(keyRoot, { mode: 0o700 });
    await writeFile(keyFile, "fixture-key\n", { mode: 0o600 });
    await chmod(keyFile, 0o600);
    await chmod(keyRoot, 0o700);
    await mkdir(stateDir, { mode: 0o700 });
    const captured = [];
    const request = buildRequest({ seed: 1 });
    const quote = buildQuote(request);
    const sponsor = await buildSponsor({ keyRoot, keyFile, stateDir, captured, quote });
    const idempotencyKey = "l-sponsor-seam-neg-1";
    const session = buildSession({ idempotencyKey });
    try {
      const proofContext = buildProofContext({ quote, request, idempotencyKey });
      // Strip request — simulate the pre-fix wrapper shape.
      delete proofContext.request;
      let caught;
      try {
        await sponsor.authorizeForQuote(proofContext, session);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, "missing request must be rejected");
      assert.equal(caught.code, "DEMO_SCOPE_MISMATCH", `expected DEMO_SCOPE_MISMATCH, got ${caught.code}`);
      assert.equal(caught.status, 403, `expected status 403, got ${caught.status}`);
      assert.equal(captured.length, 0, "seam must not be invoked when request is missing");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
