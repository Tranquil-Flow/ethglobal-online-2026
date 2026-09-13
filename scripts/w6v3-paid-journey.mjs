// W6 v3 ENSv2 frontend discovery — paid inference journey against the live
// public origin (https://mycelium.now). Uses the demo sponsor payment path
// so no wallet is required. Records the full journey for the handover.

import { createClient, createRequest, selectOfferedProfile } from "../packages/access/src/index.mjs";
import { authorizeDemoPayment, bindPaymentClient, configurePayments } from "../packages/access/viewer/payments.mjs";

const BASE = "https://mycelium.now";
const PINS = {
  providerId: "service.ethonline-node-a.eth",
  keyId: "receipt-75a861f53853102f",
  algorithm: "Ed25519",
  publicKeyJwk: {
    crv: "Ed25519",
    x: "6gtryaax5xcfXyb3f45XGX8IHTQDTuY3UW7T6W7v6vw",
    kty: "OKP",
  },
};

const log = (label, payload) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload).slice(0, 600);
  console.log(`${label}\n  ${text}`);
};

const ensInfo = await fetch(`${BASE}/v2/ens-discovery?name=service.ethonline-node-a.eth`, {
  headers: { accept: "application/json" },
}).then((r) => r.json());
const ensProvider = ensInfo.providers?.[0];

async function main() {
  const config = await fetch(`${BASE}/config.json`, { headers: { accept: "application/json" } }).then((r) => r.json());
  configurePayments({ config });
  const client = createClient({
    baseUrl: BASE,
    pins: PINS,
    paymentAuthorizer: (ctx) => authorizeDemoPayment({ ...ctx, baseUrl: BASE }),
  });
  log("1. CONNECT", await client.connect());

  log("2. LIST OFFERS", (await client.listOffers()).offers.length + " offers");

  log("3. ENSv2 LOOKUP via /v2/ens-discovery", {
    route: ensInfo.route,
    rpcHost: ensInfo.rpcHost,
    provider: ensProvider?.providerId,
    endpoint: ensProvider?.endpoint,
    block: ensProvider?.source?.blockNumber,
    provenance_state: ensInfo.provenance?.[0]?.state,
  });

  const profileId = await selectOfferedProfile(client, "service.ethonline-node-a.eth", 0);
  log("4. SELECT PROFILE", profileId);

  const request = await createRequest({
    providerId: "service.ethonline-node-a.eth",
    profileId,
    prompt: "W6 v3 ENSv2 smoke: confirm 2+2.",
    maxOutputTokens: 32,
    seed: 0,
  });

  log("5. CREATE QUOTE", await client.createQuote(request));

  const quote = await client.createQuote(request);
  log("6. SUBMIT JOB (DEMO sponsor payment should apply)", {
    quoteId: quote.quoteId,
    amount: quote.amountBaseUnits,
    asset: quote.asset,
    network: quote.network,
  });

  const accepted = await client.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey: "w6v3-ensv2-" + Date.now(),
    authorization: {
      maxAmountBaseUnits: quote.amountBaseUnits,
      asset: quote.asset,
      network: quote.network,
    },
  });
  log("7. JOB RECEIVED", {
    jobId: accepted?.job?.jobId ?? accepted?.jobId,
    state: accepted?.job?.state ?? accepted?.state,
    executionStatus: accepted?.job?.executionStatus,
    paymentStatus: accepted?.job?.payment?.status,
    paymentRef: accepted?.job?.payment?.transactionRef,
  });

  let answer = "";
  for await (const event of client.streamJob(accepted.job?.jobId ?? accepted.jobId, {
    lastEventId: 0,
  })) {
    if (event.event === "delta") {
      answer += event.data?.text ?? "";
    } else if (event.event === "job") {
      const j = event.data;
      console.log(`  [event ${event.id}] job=${j?.executionStatus} payment=${j?.payment?.status}`);
    }
  }
  log("8. STREAMED ANSWER", answer);

  const jobId = accepted.job?.jobId ?? accepted.jobId;
  const receipt = await client.getReceipt(jobId);
  log("9. RECEIPT", {
    jobId: receipt?.jobId,
    receiptDigest: receipt?.receiptDigest,
    providerId: receipt?.providerId,
    signed: Boolean(receipt?.signature ?? receipt?.receipt?.signature),
    executionVerified: receipt?.executionVerified ?? receipt?.receipt?.executionVerified,
  });

  console.log("\nJOURNEY COMPLETE");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("FATAL:", error?.code ?? error?.message ?? error);
    if (error?.body) console.error("BODY:", JSON.stringify(error.body).slice(0, 800));
    if (error?.stack) console.error(error.stack.slice(0, 1500));
    process.exit(1);
  });