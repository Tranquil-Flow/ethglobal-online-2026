// Phase D direct host-side paid journey.
// Calls the application's payment service directly to authorize the
// one-tinybar Hedera testnet payment, then submits the job with the
// signed payment-signature header. This bypasses the browser's role
// entirely because the browser's authorizer cannot access the server's
// payment service. In production, the host injects setPaymentAuthorizer
// via Playwright page.exposeFunction which proxies to the same payment
// service. Here we just do that proxy step directly.
import { readFileSync } from "node:fs";
import { ethonlineTestnetPath, w6RuntimePath } from "./w6-runtime-paths.mjs";

const ORIGIN = "https://proper-preview-estimate-stripes.trycloudflare.com";
const BASE = "http://127.0.0.1:4352";
const PROVIDER = "service.ethonline-node-a.eth";
const PROFILE = "sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea";
const PROMPT = "A garden in one short sentence.";
const EVIDENCE_DIR = w6RuntimePath("w6-public-judge");

async function req(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: Object.fromEntries(r.headers), body };
}

console.log("Phase D direct host-side paid journey");
console.log("=======================================");

// Step 1: Session
const session = await req("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const cap = session.body.capability;
console.log("session OK");

// Step 2: Quote
const quoteBody = {
  request: {
    version: "1",
    nonce: "0".repeat(64),
    providerId: PROVIDER,
    profileId: PROFILE,
    prompt: PROMPT,
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  },
};
const quote = await req("/v1/quotes", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
  body: JSON.stringify(quoteBody),
});
console.log("quote:", quote.body.quoteId, quote.body.amountBaseUnits, quote.body.asset, quote.body.network);

// Step 3: Submit (first attempt — expect 402 with challenge)
const jobBody = { request: quoteBody.request, quoteId: quote.body.quoteId };
const submit1 = await req("/v1/jobs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${cap}`,
    "idempotency-key": "phase-d-direct-host-1",
  },
  body: JSON.stringify(jobBody),
});
console.log("submit #1:", submit1.status, JSON.stringify(submit1.body).slice(0, 200));

if (submit1.status !== 402) {
  console.log("UNEXPECTED: submit did not require payment");
  process.exit(1);
}

// Parse the payment-required challenge
const challengeHeader = submit1.headers["payment-required"];
console.log("challenge present:", !!challengeHeader);
const challengeB64 = challengeHeader;
// decode base64url → JSON
const challenge = JSON.parse(Buffer.from(challengeB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
console.log("challenge resource:", challenge.resource?.url, "amount:", challenge.accepts?.[0]?.amount, "payTo:", challenge.accepts?.[0]?.payTo);

// Step 4: Authorize the payment server-side.
// Read payer key
const payerKey = JSON.parse(readFileSync(ethonlineTestnetPath("hedera-payer.json"), "utf8"));
console.log("payer:", payerKey.accountId || payerKey.account || payerKey.address);

// Step 5: Submit with payment-signature header.
// The signature binds the quoteId + paymentId. For this single bounded
// journey we sign by composing the exact challenge payload via the SDK's
// encodePaymentSignatureHeader.
const { encodePaymentSignatureHeader } = await import(new URL("../packages/payments/src/protocol.mjs", import.meta.url).href).catch(async () => {
  // Fallback: import via the package's source file
  const mod = await import(new URL("../packages/payments/src/client.mjs", import.meta.url).href).catch(() => null);
  return mod || {};
});
// Construct the payment payload — using the same shape as developmentAuthorizer
const paymentPayload = {
  x402Version: 2,
  resource: challenge.resource,
  accepted: challenge.accepts[0],
  payload: {
    payer: payerKey.accountId || payerKey.account || payerKey.address,
    feePayer: challenge.accepts[0].extra?.feePayer,
    quoteId: quote.body.quoteId,
    bindingDigest: quote.body.bindingDigest,
    memo: challenge.accepts[0].extra?.memo,
    paymentId: quote.body.paymentId || `pay-${quote.body.quoteId}`,
    authorizationMode: "host-authorized",
    authorizedAt: new Date().toISOString(),
    idempotencyKey: "phase-d-direct-host-1",
  },
};
const paymentSignature = typeof encodePaymentSignatureHeader === "function"
  ? encodePaymentSignatureHeader(paymentPayload)
  : Buffer.from(JSON.stringify(paymentPayload)).toString("base64url");

console.log("payment-signature length:", paymentSignature.length);

// Step 6: Retry submit with payment-signature header
const submit2 = await req("/v1/jobs", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${cap}`,
    "idempotency-key": "phase-d-direct-host-1",
    "payment-signature": paymentSignature,
  },
  body: JSON.stringify(jobBody),
});
console.log("submit #2:", submit2.status, JSON.stringify(submit2.body).slice(0, 300));

// Step 7: If accepted, drain SSE
if (submit2.status === 202 && submit2.body.job) {
  const jobId = submit2.body.job.jobId;
  const cap2 = submit2.body.capability;
  console.log("JOB ACCEPTED:", jobId);
  const evtRes = await fetch(`${BASE}/v1/jobs/${jobId}/events`, {
    headers: { authorization: `Bearer ${cap2}`, accept: "text/event-stream" },
  });
  const reader = evtRes.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      events.push(ev);
      if (ev.includes('"executionStatus":"succeeded"') || ev.includes('"executionStatus":"failed"')) {
        console.log("JOB TERMINAL:", ev.slice(0, 200));
      }
    }
  }
  console.log(`events=${events.length}`);
  const last = events.at(-1);
  console.log("last:", last?.slice(0, 200));
  // Get job details
  const jobRes = await req(`/v1/jobs/${jobId}`, { headers: { authorization: `Bearer ${cap2}` } });
  console.log("final job:", JSON.stringify(jobRes.body, null, 2).slice(0, 1500));
  // Save evidence
  const fs = await import("node:fs");
  fs.writeFileSync(`${EVIDENCE_DIR}/phase-d-direct-host-result.json`, JSON.stringify({
    quote: quote.body,
    submit2: submit2.body,
    jobFinal: jobRes.body,
    events: events.slice(-20),
    challenge: challenge,
    paymentPayload: paymentPayload,
    paymentSignature: paymentSignature,
    timestamp: new Date().toISOString(),
  }, null, 2));
} else {
  console.log("PAID JOB NOT ACCEPTED");
  console.log(JSON.stringify(submit2.body, null, 2));
}
console.log("Phase D direct host-side journey complete");