#!/usr/bin/env node
// W6 demo-sponsor end-to-end driver.
// Runs against http://127.0.0.1:4352 (the local paid app).
//
// Flow:
//   1. POST /v1/sessions                         -> capability
//   2. POST /v1/quotes                          -> quote
//   3. POST /v1/jobs (no payment-signature)     -> 402 challenge
//   4. POST /v2/demo-sponsor/authorize           -> real Hedera-signed
//      payment-signature from the OT1 demo sponsor key
//   5. POST /v1/jobs + payment-signature         -> 202 settled
//
// Prints each step to stdout and exits non-zero on failure.

const BASE_URL = process.env.W6_DEMO_BASE_URL ?? "http://127.0.0.1:4352";
const PROVIDER_ID = "service.ethonline-node-a.eth";
const PROFILE_ID =
  "sha256:c4cedd8619a8f59ce4aa6f40ee42ff21c6fabe19afa19af28e6349c0819e53fc";

function log(step, value) {
  console.log(`[${step}]`, JSON.stringify(value, null, 2).slice(0, 1200));
}

async function http(method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { accept: "application/json", ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!init.headers["content-type"]) init.headers["content-type"] = "application/json";
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return {
    status: res.status,
    headers: Object.fromEntries([...res.headers.entries()]),
    json,
    text,
  };
}

function nonceHex() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function uuid() {
  return crypto.randomUUID();
}

function die(step, response) {
  console.error(`✗ ${step} failed: status=${response.status}`);
  console.error(response.text);
  process.exit(1);
}

async function main() {
  const cap = (await http("POST", "/v1/sessions", { body: {} })).json.capability;
  log("01_session", { capability: cap.slice(0, 12) + "..." });
  const auth = { authorization: `Bearer ${cap}` };

  const request = {
    version: "1",
    nonce: nonceHex(),
    providerId: PROVIDER_ID,
    profileId: PROFILE_ID,
    prompt: "hello mycelium",
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const quote = (await http("POST", "/v1/quotes", { headers: auth, body: { request } })).json;
  log("02_quote", { quoteId: quote.quoteId.slice(0, 8), amount: quote.amountBaseUnits, network: quote.network, receiver: quote.receiver });

  const idem = uuid();
  const first = await http("POST", "/v1/jobs", {
    headers: { ...auth, "idempotency-key": idem },
    body: { request, quoteId: quote.quoteId },
  });
  if (first.status !== 402) die("03_first_jobs (expected 402)", first);
  log("03_first_jobs", {
    status: first.status,
    challenge_keys: Object.keys(first.json).slice(0, 8),
    payment_required_header_present: Boolean(first.headers["payment-required"]),
  });

  // The createSinglePaymentGuard requires:
  //   baseUrl === "https://mycelium.now"
  //   c.request.publishConsent === false
  //   c.request.maxOutputTokens === 8
  //   c.budget.maxAmountBaseUnits === "1"
  //   q.network === "hedera:testnet", q.asset === "0.0.0",
  //   q.receiver === "0.0.10419316", q.amountBaseUnits === "1"
  const context = {
    status: 402,
    body: first.json,
    headers: { "payment-required": first.headers["payment-required"] ?? "" },
    quote,
    request,
    budget: { maxAmountBaseUnits: "1", asset: quote.asset, network: quote.network },
    baseUrl: "https://mycelium.now",
    idempotencyKey: idem,
  };

  const authz = await http("POST", "/v2/demo-sponsor/authorize", {
    headers: auth,
    body: { context },
  });
  if (authz.status !== 200) die("04_authorize (expected 200)", authz);
  const sig = authz.json.headers["payment-signature"];
  log("04_authorize", {
    status: authz.status,
    payer: authz.json.payer,
    display: authz.json.display,
    binding: authz.json.binding,
    sig_len: sig.length,
  });

  const submit = await http("POST", "/v1/jobs", {
    headers: { ...auth, "idempotency-key": idem, "payment-signature": sig },
    body: { request, quoteId: quote.quoteId },
  });
  if (submit.status !== 202) die("05_submit (expected 202)", submit);
  const submitJob = submit.json.job ?? submit.json;
  log("05_submit", {
    status: submit.status,
    jobId: submitJob.jobId,
    paymentId: submitJob.payment?.paymentId,
    paymentStatus: submitJob.payment?.status,
    paymentTx: submitJob.payment?.transactionRef,
  });

  console.log(
    `\n✓ W6 demo-sponsor end-to-end settled: ${submitJob.payment?.transactionRef}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});