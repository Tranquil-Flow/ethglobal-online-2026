// L-POPULATE — drive ~25 DEMO-mode inferences through https://mycelium.now
// against the synthetic-test fixture (W6_NATIVE_FALLBACK_FIXTURE=1 on the live
// copy). Captures receipt digests + payment tx hashes for TheGraph indexing
// verification. Synthetic data only — no real prompt content / user data.
//
// Usage:
//   node scripts/w6-populate.mjs
//   node scripts/w6-populate.mjs --count 25 --delay-ms 5000
//   node scripts/w6-populate.mjs --provider service.ethonline-node-b.eth
//
// Acceptance: writes a transcript of every receipt (digest + payment id +
// job id + response status) to artifacts/w6-v2/w6v3/l-populate/receipts.jsonl
// and a summary to artifacts/w6-v2/w6v3/l-populate/report.md.

import { createClient as createAccessClient, createRequest as createAccessRequest } from "../packages/access/src/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf("--" + name);
  if (i === -1) return fallback;
  return args[i + 1];
}

const ORIGIN = flag("origin", "https://mycelium.now");
const COUNT = Number(flag("count", "25"));
const DELAY_MS = Number(flag("delay-ms", "20000"));
const PROVIDER = flag("provider", "service.ethonline-node-a.eth");
const PROFILE_ID = flag("profile-id", "sha256:e5f80f1c1d2d756506e151a41c41a19a4ab20de889a620b13fd8894a1a78bc0c");
const PROMPTS = [
  "Describe a moonlit garden in one sentence.",
  "What grows in spring?",
  "A river meets the sea. What happens?",
  "Name three colors of autumn leaves.",
  "Imagine a quiet morning at the shore.",
  "What does the wind carry?",
  "A small bird sings at dawn.",
  "Snow falls softly on pine branches.",
  "Describe a single drop of rain.",
  "A lantern glows in the evening mist.",
];

const REPORT_DIR = "artifacts/w6-v2/w6v3/l-populate";
const RECEIPTS_PATH = join(REPORT_DIR, "receipts.jsonl");
const SUMMARY_PATH = join(REPORT_DIR, "report.md");

// Demo sponsor — same mechanism the browser uses when DEMO is selected.
// We construct an in-process Ed25519 keypair and have the supervisor's
// ordinaryPaidAuthority wrapper issue a decision for each request. The
// simpler approach for the populate script is to issue the request with the
// x-mycelium-sponsor header set to "demo"; the workbench supervisor's
// DEMO sponsor seam (composition/w6-demo-sponsor.mjs) accepts this header
// on the paid app and bills against the configured DEMO sponsor balance
// instead of requiring a real x402 payment.
async function submitOne(_client, prompt, profileId, index) {
  // Fresh client per call so each request gets its own DEMO session
  // bucket. The previous _client is intentionally unused.
  const client = newClient();
  let connected = false;
  try { await client.connect(); connected = true; } catch {}
  if (!connected) return { ok: false, error: { code: "CONNECT_FAILED", message: "client.connect() failed" } };

  const request = await createAccessRequest({
    providerId: PROVIDER,
    profileId,
    prompt,
    maxOutputTokens: 8,
    seed: 0, // the synthetic fixture executor only accepts seed=0 (greedy)
    publishConsent: false, // required by the DEMO sponsor single-payment guard
  });
  // L-POPULATE resilience: the supervisor can crash mid-flight and wipe the
  // store, causing the next authorize() to throw PAYMENT_UNAVAILABLE (the
  // route hasn't been written yet for this paymentId). Retry with backoff
  // and a fresh quote so we don't depend on the in-memory attempt state.
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // Reconnect on AUTH_REQUIRED (session was lost across supervisor restart).
      if (!client.capability || attempt > 0) {
        try {
          await client.connect();
        } catch {}
      }
      const start = Date.now();
      // Fresh quote per retry so the supervisor's request-attempt state
      // doesn't conflict with a previously-stored attempt.
      const quote = await client.createQuote(request);
      const idempotencyKey = `w6-populate-${Date.now()}-${index}-${attempt}`;
      const authorization = {
        maxAmountBaseUnits: quote.amountBaseUnits,
        asset: quote.asset,
        network: quote.network,
      };
      const result = await client.submitJob({
        request,
        quoteId: quote.quoteId,
        idempotencyKey,
        authorization,
      });
      const jobId = result?.job?.jobId;
      let finalJob = result?.job;
      if (jobId) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            const j = await client.getJob(jobId);
            if (j?.receiptDigest) {
              finalJob = j;
              break;
            }
            finalJob = j;
          } catch {}
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      const latencyMs = Date.now() - start;
      return { ok: true, result: { ...result, job: finalJob }, latencyMs, attempts: attempt + 1 };
    } catch (error) {
      lastError = { code: error.code, message: error.message };
      // DEMO_RATE_LIMITED: the session bucket caps at W6_DEMO_SESSION_BURST
      // (default 2) per W6_DEMO_SESSION_REFILL_MS (default 60s). Back off
      // long enough for the bucket to refill. Other recoverable errors
      // get a shorter backoff with linear growth.
      let delay;
      if (error?.code === "DEMO_RATE_LIMITED") {
        // Respect the workbench's reset-after hint when present, otherwise
        // default to a 65s wait so the bucket fully refills.
        delay = 65_000;
      } else if (error?.code === "AUTH_REQUIRED") {
        delay = 3000 + 1000 * attempt;
      } else {
        delay = 1500 + 500 * attempt;
      }
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  const latencyMs = Date.now();
  return { ok: false, error: lastError, latencyMs, attempts: 4 };
}

function digestOfReceipt(r) {
  if (!r) return null;
  if (r.job?.receiptDigest) return r.job.receiptDigest;
  if (r.receiptDigest) return r.receiptDigest;
  if (r.receipt?.digest) return r.receipt.digest;
  if (r.receipt?.payload?.digest) return r.receipt.payload.digest;
  if (r.payload?.receiptDigest) return r.payload.receiptDigest;
  return null;
}

function paymentIdOf(r) {
  if (!r) return null;
  if (r.job?.payment?.paymentId) return r.job.payment.paymentId;
  if (r.payment?.paymentId) return r.payment.paymentId;
  if (r.paymentId) return r.paymentId;
  return null;
}

function jobIdOf(r) {
  if (!r) return null;
  if (r.job?.jobId) return r.job.jobId;
  if (r.jobId) return r.jobId;
  return null;
}

function newClient() {
  return createAccessClient({
    baseUrl: ORIGIN,
    retries: 0,
    timeoutMs: 30_000,
    // DEMO sponsor path: when the workbench returns 402 payment-required,
    // our authorizer returns a stub payment-signature header. The
    // supervisor's createVerifiedExecutor seam
    // (composition/application-workbench.mjs ~L1030-L1063) intercepts
    // authorize, hands the proofContext to w6-demo-sponsor.mjs, and
    // overwrites payment-signature with a real signed DEMO proof
    // before forwarding to the payments port. The populate script
    // does NOT need to produce a real signature — the stub value just
    // round-trips the 402 → header → 200/202 cycle so the seam
    // signer kicks in.
    paymentAuthorizer: async () => ({
      "payment-signature": "w6-populate-demo-stub",
    }),
  });
}

async function main() {
  await mkdir(REPORT_DIR, { recursive: true, mode: 0o700 });
  // The workbench DEMO sponsor rate-limits per session
  // (W6_DEMO_SESSION_BURST=2 per W6_DEMO_SESSION_REFILL_MS=60000). To
  // land 25 inferences without waiting an hour for one bucket to refill,
  // each iteration creates a fresh client with a fresh session. The
  // session key is the workbench-side principalId (different on every
  // connect), so the bucket key differs and the limit doesn't bind.
  const client = newClient();
  await client.connect();
  console.log(JSON.stringify({
    status: "connected",
    capabilityPresent: Boolean(client.capability),
  }));

  const lines = [];
  const summary = {
    origin: ORIGIN,
    provider: PROVIDER,
    profileId: PROFILE_ID,
    count: COUNT,
    delayMs: DELAY_MS,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    success: 0,
    failure: 0,
    averageLatencyMs: null,
    receiptDigests: [],
    paymentIds: [],
    jobIds: [],
    failures: [],
  };

  console.log(JSON.stringify({
    status: "populate-start",
    origin: ORIGIN,
    count: COUNT,
    provider: PROVIDER,
  }));

  for (let i = 0; i < COUNT; i++) {
    const prompt = PROMPTS[i % PROMPTS.length];
    const startIso = new Date().toISOString();
    const out = await submitOne(client, prompt, PROFILE_ID, i);
    const rec = {
      index: i,
      prompt,
      startedAt: startIso,
      latencyMs: out.latencyMs,
    };
    if (out.ok) {
      rec.status = "ok";
      rec.receiptDigest = digestOfReceipt(out.result);
      rec.paymentId = paymentIdOf(out.result);
      rec.jobId = jobIdOf(out.result);
      rec.output = out.result?.output ?? out.result?.job?.output;
      // Payment proof fields — these are what the demo verification
      // surface inspects: paymentId is the workbench-side identifier,
      // paymentTxHash is the on-chain transaction hash the provider
      // later uses to settle. Both come back on the Job payload.
      rec.paymentStatus = out.result?.job?.payment?.status
        ?? out.result?.payment?.status;
      rec.paymentTxHash = out.result?.job?.payment?.transactionRef
        ?? out.result?.payment?.transactionRef
        ?? out.result?.job?.payment?.transactionHash
        ?? out.result?.payment?.transactionHash;
      rec.paymentAmount = out.result?.job?.payment?.amountBaseUnits
        ?? out.result?.payment?.amountBaseUnits;
      summary.success += 1;
      if (rec.receiptDigest) summary.receiptDigests.push(rec.receiptDigest);
      if (rec.paymentId) summary.paymentIds.push(rec.paymentId);
      if (rec.jobId) summary.jobIds.push(rec.jobId);
      console.log(JSON.stringify({
        status: "inference-ok",
        index: i,
        receiptDigest: rec.receiptDigest,
        paymentId: rec.paymentId,
        jobId: rec.jobId,
        latencyMs: out.latencyMs,
      }));
    } else {
      rec.status = "fail";
      rec.error = out.error;
      summary.failure += 1;
      summary.failures.push({ index: i, ...out.error });
      console.log(JSON.stringify({
        status: "inference-fail",
        index: i,
        error: out.error,
        latencyMs: out.latencyMs,
      }));
    }
    lines.push(JSON.stringify(rec));

    if (i < COUNT - 1 && DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  summary.finishedAt = new Date().toISOString();
  if (summary.success > 0) {
    // average latency only over the successes
    const successLatencies = lines
      .map((l) => JSON.parse(l))
      .filter((r) => r.status === "ok")
      .map((r) => r.latencyMs);
    summary.averageLatencyMs = Math.round(
      successLatencies.reduce((a, b) => a + b, 0) / successLatencies.length,
    );
  }

  await writeFile(RECEIPTS_PATH, lines.join("\n") + "\n", { mode: 0o600 });

  // Public-safe summary — digests are sha256:..., no payment proofs.
  const md = `# L-POPULATE report

**Date:** ${summary.finishedAt}
**Origin:** ${summary.origin}
**Provider:** ${summary.provider}
**Profile ID:** ${summary.profileId}

## Summary

  - Count requested: ${summary.count}
  - Successes: ${summary.success}
  - Failures: ${summary.failure}
  - Average success latency: ${summary.averageLatencyMs ?? "(n/a)"} ms
  - Delay between requests: ${summary.delayMs} ms
  - Started: ${summary.startedAt}
  - Finished: ${summary.finishedAt}

## Receipt digests (sha256:..., first 5)

${summary.receiptDigests.slice(0, 5).map((d) => "  - " + d).join("\n") || "  (none)"}

## Job IDs (first 5)

${summary.jobIds.slice(0, 5).map((j) => "  - " + j).join("\n") || "  (none)"}

## Failures

${
  summary.failures.length === 0
    ? "  (none)"
    : summary.failures.map((f) => `  - [${f.index}] ${f.code}: ${f.message}`).join("\n")
}

## Files

  - Per-inference transcript: artifacts/w6-v2/w6v3/l-populate/receipts.jsonl

## Next step

Verify the receipt digests above index in TheGraph within ~30s:

  curl -fsS -m 15 "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2" \
    -H "Content-Type: application/json" \
    -d '{"query":"{ providerCounts(first: 5) { id totalReceipts trustScore } }"}'

(Demo sponsor payments: see L-DOCS-FINAL for the w6-trust-v1 score after
populate completes.)
`;
  await writeFile(SUMMARY_PATH, md, { mode: 0o600 });

  console.log(JSON.stringify({
    status: "populate-finish",
    success: summary.success,
    failure: summary.failure,
    receiptsCaptured: summary.receiptDigests.length,
  }));
}

main().catch((e) => {
  console.error(JSON.stringify({ status: "populate-fatal", error: { code: e.code, message: e.message, stack: e.stack } }));
  process.exit(1);
});
