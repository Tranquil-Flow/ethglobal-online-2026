#!/usr/bin/env node
// W6 HCS receipt-trail E2E driver — one real, settled, paid inference request
// through the public origin (or an explicit base), then prints the job's
// publication state. Used to prove the HCS fanout broadcasts for real jobs.
//
// Usage:
//   node scripts/w6-hcs-e2e-driver.mjs [--base <url>] [--provider <ens>]
//        [--prompt <text>] [--tokens <n>] [--seed <n>] [--publish-consent]
//
// Never prints secrets: the payment-signature flows inside the SDK and is
// never logged.

import {
  createClient,
  createRequest,
  selectOfferedProfile,
} from "../packages/access/src/index.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const baseUrl = opt("--base", process.env.W6_DEMO_BASE_URL ?? "https://mycelium.now");
const providerId = opt("--provider", "service.ethonline-node-a.eth");
const prompt = opt("--prompt", "hello mycelium");
const maxOutputTokens = Number(opt("--tokens", "128"));
const seed = Number(opt("--seed", "0"));
const publishConsent = args.includes("--publish-consent");

// Receipt pins are public per-provider data served in /config.json; the SDK
// requires them to pin the receipt key before it will list offers.
const configResponse = await fetch(`${baseUrl}/config.json`);
if (!configResponse.ok) {
  console.error(JSON.stringify({ status: "failed", code: "CONFIG_FETCH_FAILED", http: configResponse.status }));
  process.exit(1);
}
const config = await configResponse.json();
const pins =
  config?.providers?.find((p) => p.providerId === providerId)?.pins ??
  config?.pins ??
  null;
if (!pins?.providerId || !pins?.keyId || !pins?.publicKeyJwk) {
  console.error(JSON.stringify({ status: "failed", code: "PINS_UNAVAILABLE", providerId }));
  process.exit(1);
}

const client = createClient({
  baseUrl,
  timeoutMs: 600000,
  pins,
  paymentAuthorizer: async (ctx) => {
    const result = await client.authorizeDemoPayment(ctx);
    return result?.headers ?? result;
  },
});

try {
  const session = await client.connect();
  const profileId = await selectOfferedProfile(client, providerId, 0);
  const request = await createRequest({
    providerId,
    profileId,
    prompt,
    maxOutputTokens,
    seed,
    sampling: "greedy",
    publishConsent,
  });
  const quote = await client.createQuote(request);
  const idempotencyKey = crypto.randomUUID();
  const { job } = await client.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey,
    authorization: {
      maxAmountBaseUnits: "1",
      asset: quote.asset,
      network: quote.network,
    },
  });

  let events = 0;
  let outputText = null;
  for await (const event of client.streamJob(job.jobId)) {
    events += 1;
    if (event?.type === "completed" && event?.output?.text) {
      outputText = event.output.text;
    }
  }

  // Give the receipt-completion fanout time to finish its HCS submit
  // (testnet consensus currently lands 7-11 s after validStart).
  await new Promise((resolve) => setTimeout(resolve, 15000));

  const publication = await client
    .getPublication(job.jobId)
    .catch((error) => ({ error: error?.code ?? error?.message ?? String(error) }));

  console.log(
    JSON.stringify(
      {
        status: "settled",
        providerId,
        jobId: job.jobId,
        paymentTxId: job.payment?.transactionRef ?? null,
        events,
        outputChars: outputText ? outputText.length : 0,
        outputPreview: outputText ? outputText.slice(0, 80) : null,
        publication,
      },
      null,
      2,
    ),
  );
  await client.revoke();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: error?.code ?? error?.message ?? String(error),
    }),
  );
  process.exit(1);
}
