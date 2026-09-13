import { createClient, createRequest, selectOfferedProfile } from "../packages/access/src/index.mjs";

const BASE = "http://127.0.0.1:4352";
const PINS = {"providerId": "service.ethonline-node-a.eth", "keyId": "receipt-75a861f53853102f", "algorithm": "Ed25519", "publicKeyJwk": {"crv": "Ed25519", "x": "6gtryaax5xcfXyb3f45XGX8IHTQDTuY3UW7T6W7v6vw", "kty": "OKP"}};

async function main() {
  const client = createClient({ baseUrl: BASE, pins: PINS });

  console.log("1. CONNECT");
  const session = await client.connect();
  console.log("   session:", JSON.stringify(session).slice(0, 200));

  console.log("2. LIST OFFERS");
  const offersResp = await client.listOffers();
  const offers = offersResp?.offers || offersResp;
  console.log("   count:", offers?.length);
  const offer = offers[0];
  const providerId = offer.payload.providerId;
  console.log("   providerId:", providerId);

  console.log("3. SELECT PROFILE");
  const profile = await client.selectOfferedProfile(providerId, 0);
  console.log("   profileId:", profile?.profileId);

  console.log("4. CREATE REQUEST");
  const request = createRequest({
    providerId,
    profileId: profile.profileId,
    prompt: "What is 2+2?",
    maxOutputTokens: 32,
  });
  console.log("   prompt:", request.prompt);

  console.log("5. CREATE QUOTE");
  let quote;
  try {
    quote = await client.createQuote({ providerId, profileId: profile.profileId, prompt: request.prompt, maxOutputTokens: 32 });
    console.log("   quoteId:", quote.quoteId);
    console.log("   amount:", quote.amountBaseUnits, "asset:", quote.asset);
  } catch (e) {
    console.log("   QUOTE error:", e?.code, e?.message);
    return;
  }

  console.log("6. SUBMIT JOB (DEMO sponsor payment should apply)");
  let job;
  try {
    job = await client.submitJob({
      request: { providerId, profileId: profile.profileId, prompt: request.prompt, maxOutputTokens: 32 },
      quoteId: quote.quoteId,
      idempotencyKey: "test-" + Date.now(),
      authorization: { maxAmountBaseUnits: quote.amountBaseUnits, asset: quote.asset, network: quote.network },
    });
    console.log("   jobId:", job?.jobId);
    console.log("   state:", job?.state);
    console.log("   payment.status:", job?.payment?.status);
    console.log("   payment.transactionRef:", job?.payment?.transactionRef);
    console.log("   payment.paymentId:", job?.payment?.paymentId);
    console.log("   output preview:", JSON.stringify(job?.output).slice(0, 200));
  } catch (e) {
    console.log("   SUBMIT error:", e?.code, e?.message);
    console.log("   body:", JSON.stringify(e?.body || {}).slice(0, 500));
    return;
  }

  console.log("JOB SUMMARY:", JSON.stringify(job, null, 2).slice(0, 2500));
}

main().catch(e => { console.error("FATAL:", e?.code, e?.message); console.error((e?.stack || "").slice(0, 1500)); process.exit(1); });
