import {
  createClient,
  createRequest,
  developmentAuthorizer,
  AccessError,
  verifyReceiptIntegrity,
  checkBuyerEvidenceJson,
} from "../src/index.mjs";
const $ = (id) => document.getElementById(id),
  text = (id, v) => ($(id).textContent = v);
let jobClient, jobPins;
let client,
  config,
  provider,
  request,
  quote,
  job,
  streamController,
  busy = false,
  submissionAttempted = false;
let userPaymentAuthorizer;
// Trusted host code may inject a wallet UI callback; no DOM/data-controlled module loading.
export function setPaymentAuthorizer(callback) {
  if (typeof callback !== "function") throw new TypeError("Expected callback");
  userPaymentAuthorizer = callback;
}
const status = (v) => (document.querySelector("[role=status]").textContent = v);
function invalidate() {
  quote = undefined;
  request = undefined;
  $("consent").checked = false;
  text("quote", "Quote invalidated — obtain a fresh quote");
}
for (const id of [
  "provider",
  "profile",
  "prompt",
  "tokens",
  "publish-consent",
  "budget",
])
  $(id).addEventListener("input", invalidate);
async function action(fn) {
  text("error", "");
  try {
    await fn();
  } catch (e) {
    text(
      "error",
      e instanceof AccessError
        ? e.code
        : "Operation unavailable; no automatic repayment",
    );
    status("Error — explicit retry required");
  }
}
const pinFor = (id) =>
  config.providers?.find((p) => p.providerId === id)?.pins ?? config.pins;
function clientFor(id, capability) {
  return createClient({
    baseUrl: config.apiUrl,
    capability,
    pins: pinFor(id),
    paymentAuthorizer: config.fixture
      ? developmentAuthorizer
      : async (context) => {
          if (!userPaymentAuthorizer)
            throw new AccessError("WALLET_AUTHORIZER_UNAVAILABLE");
          return userPaymentAuthorizer(context);
        },
  });
}
async function publication() {
  if (!job || config.fixture) return;
  const p = await (jobClient ?? client).getPublication(job.jobId);
  text(
    "publication-state",
    p.consent
      ? p.events.length
        ? p.events.map((e) => e.kind + ": " + e.status).join(" · ")
        : "Consent given; no publishable result yet"
      : "Not published — consent off",
  );
}
const need = () => {
  if (!client?.capability) throw new AccessError("Connect explicitly first");
};
$("connect").onclick = () =>
  action(async () => {
    status("Connecting…");
    if (!config) config = await fetch("/config.json").then((r) => r.json());
    client = clientFor($("provider").value);
    const health = await client.health();
    text(
      "mode",
      config.fixture
        ? "DEVELOPMENT — synthetic conformance fixture"
        : health.mode === "development"
          ? "DEVELOPMENT — no live inference qualification"
          : "LIVE route — execution and assessment remain separate, unqualified",
    );
    await client.connect();
    status("Connected — no payment authorized");
  });
$("revoke").onclick = () =>
  action(async () => {
    need();
    await client.revoke();
    streamController?.abort();
    invalidate();
    status("Session revoked");
  });
$("find").onclick = () =>
  action(async () => {
    need();
    if (busy) throw new AccessError("JOB_IN_PROGRESS");
    status("Finding provider…");
    provider = undefined;
    const list = await client.listProviders([$("provider").value]);
    if (!list.providers.length) throw new AccessError("Provider unavailable");
    const p = list.providers[0];
    if (!p.profileIds.includes($("profile").value))
      throw new AccessError("Profile unavailable");
    const profile = await client.getProfile($("profile").value);
    provider = p;
    client = clientFor(p.providerId, client.capability);
    text("provider-state", p.name);
    text("profile-info", profile.model + " · " + p.mode);
    const h = await client.getHistory(p.providerId);
    text(
      "history",
      "History: " +
        h.freshness +
        "; " +
        (h.observations.length
          ? "observations are claims"
          : "no samples — unknown"),
    );
    status("Provider selected — no prompt fan-out");
  });
$("quote-button").onclick = () =>
  action(async () => {
    need();
    if (!provider || provider.providerId !== $("provider").value)
      throw new AccessError("Find provider first");
    if (busy) throw new AccessError("JOB_IN_PROGRESS");
    status("Loading quote…");
    request = await createRequest({
      providerId: provider.providerId,
      profileId: $("profile").value,
      prompt: $("prompt").value,
      maxOutputTokens: Number($("tokens").value),
      seed: 0,
      publishConsent: $("publish-consent")?.checked === true,
    });
    quote = await client.createQuote(request);
    if (quote.mode !== provider.mode) throw new AccessError("MODE_MISMATCH");
    submissionAttempted = false;
    $("consent").checked = false;
    text(
      "quote",
      quote.amountBaseUnits +
        " base units " +
        quote.asset +
        " on " +
        quote.network +
        " · expires " +
        quote.expiresAt,
    );
    status("Quote ready — payment requires consent");
  });
$("submit").onclick = () =>
  action(async () => {
    need();
    if (busy || submissionAttempted)
      throw new AccessError(
        "Existing attempt: inspect before new authorization",
      );
    if (!$("consent").checked)
      throw new AccessError("Explicit payment consent required");
    if (!quote || !request) throw new AccessError("Get quote first");
    busy = true;
    submissionAttempted = true;
    $("submit").disabled = true;
    try {
      status("Submitting…");
      const submittingClient = client,
        submittedRequest = request;
      const budget = $("budget")?.value ?? "10";
      if (
        !(config.accessPolicy === "sponsored-local"
          ? budget === "0"
          : /^[1-9][0-9]{0,4}$/.test(budget)) ||
        BigInt(budget) > 10000n
      )
        throw new AccessError("BUDGET_LIMIT");
      const r = await submittingClient.submitJob({
        request,
        quoteId: quote.quoteId,
        idempotencyKey: crypto.randomUUID(),
        authorization: {
          maxAmountBaseUnits: budget,
          asset: quote.asset,
          network: quote.network,
        },
      });
      job = r.job;
      jobClient = submittingClient;
      jobPins = pinFor(submittedRequest.providerId);
      text("receipt-state", "Not checked");
      text("assessment-state", "Separate — not requested");
      renderJob(job);
      text("answer", "");
      streamController = new AbortController();
      for await (const e of jobClient.streamJob(job.jobId, {
        signal: streamController.signal,
      })) {
        if (e.event === "delta")
          $("answer").append(document.createTextNode(e.data.text));
        if (e.event === "job") {
          job = e.data;
          renderJob(job);
        }
      }
      await publication();
      status("Stream finished");
    } finally {
      busy = false;
      $("submit").disabled = false;
      $("consent").checked = false;
    }
  });
function renderJob(j) {
  text(
    "job-state",
    j.executionStatus === "succeeded" ? "Completed" : j.executionStatus,
  );
  text(
    "payment-state",
    config.accessPolicy === "sponsored-local"
      ? "Non-monetary — no settlement or refund claim"
      : (j.payment?.status || "unknown") + " · " + j.mode,
  );
}
$("cancel").onclick = () =>
  action(async () => {
    if (!job) {
      text("job-state", "Nothing to cancel");
      return;
    }
    job = await (jobClient ?? client).cancelJob(job.jobId);
    renderJob(job);
    streamController?.abort();
    status("Cancellation requested explicitly");
  });
$("assess").onclick = () =>
  action(async () => {
    need();
    if (!job) throw new AccessError("No job");
    const a = await (jobClient ?? client).createAssessment(
      job.jobId,
      config.replayMethod || "independent-replay",
      crypto.randomUUID(),
    );
    text("assessment-state", "Separate — " + a.outcome + " (" + a.method + ")");
    await publication();
  });
$("download").onclick = () =>
  action(async () => {
    need();
    if (!job) throw new AccessError("No job");
    status("Validating private evidence…");
    const evidence = await (jobClient ?? client).getEvidence(job.jobId, {
      expected: buyerContext().expected,
    });
    text(
      "receipt-state",
      "Integrity verified against configured pin — not inference verification",
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(evidence, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "private-evidence.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status(
      "Private evidence downloaded — integrity only, not provider trust or execution proof",
    );
  });
function buyerContext() {
  if (!job) throw new AccessError("BUYER_EXPECTATION_UNAVAILABLE");
  const expected = (jobClient ?? client).getBuyerExpectation(job.jobId);
  if (job.output) expected.output = structuredClone(job.output);
  return { expected, pins: structuredClone(jobPins) };
}
$("download-context").onclick = () =>
  action(async () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(buyerContext(), null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "private-buyer-context.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status(
      "Private buyer context retained — keep independently of provider exports",
    );
  });
$("offline-check").onclick = () =>
  action(async () => {
    text("offline-result", "Not checked");
    const file = (id) => {
      const f = $(id).files?.[0];
      if (!f || f.size > 2097152) throw new AccessError("EVIDENCE_SIZE_LIMIT");
      return f;
    };
    const context = JSON.parse(await file("offline-context").text());
    const result = await checkBuyerEvidenceJson(
      await file("offline-evidence").text(),
      context.pins,
      context.expected,
    );
    text(
      "offline-result",
      "Original request and receipt integrity checked; " +
        (result.completeOutputBound
          ? "complete retained output bound"
          : "no separately retained output") +
        " — not computation proof or financial protection",
    );
  });
$("delete-evidence").onclick = () =>
  action(async () => {
    need();
    if (!job) throw new AccessError("No job");
    await (jobClient ?? client).deleteEvidence(job.jobId);
    text("answer", "");
    status(
      "Private evidence deleted from server; receipts and downloaded copies remain",
    );
  });
$("refresh-publication").onclick = () =>
  action(async () => {
    need();
    await publication();
  });
$("check-receipt").onclick = () =>
  action(async () => {
    need();
    if (!job) throw new AccessError("No job");
    const receipt = await (jobClient ?? client).getReceipt(job.jobId);
    if (
      !jobPins?.publicKeyJwk ||
      receipt.keyId !== jobPins.keyId ||
      receipt.payload.providerId !== jobPins.providerId
    )
      throw new AccessError("KEY_PIN_REQUIRED");
    const result = await verifyReceiptIntegrity(receipt, jobPins.publicKeyJwk);
    if (!result.integrity) throw new AccessError("INVALID_SIGNATURE");
    text(
      "receipt-state",
      "Integrity verified against configured pin — not inference verification",
    );
  });
$("resume").onclick = () =>
  action(async () => {
    need();
    if (!job) throw new AccessError("No job");
    if (busy) throw new AccessError("JOB_IN_PROGRESS");
    busy = true;
    try {
      streamController = new AbortController();
      text("answer", "");
      for await (const e of (jobClient ?? client).streamJob(job.jobId, {
        signal: streamController.signal,
      })) {
        if (e.event === "delta")
          $("answer").append(document.createTextNode(e.data.text));
        if (e.event === "job") {
          job = e.data;
          renderJob(job);
        }
      }
      job = await (jobClient ?? client).getJob(job.jobId);
      renderJob(job);
      if (job.executionStatus === "succeeded") {
        const evidence = await (jobClient ?? client).getEvidence(job.jobId, {
          expected: buyerContext().expected,
        });
        text("answer", evidence.output.text);
        text(
          "receipt-state",
          "Integrity verified against configured pin — not inference verification",
        );
      }
      await publication();
      status("Retained job refreshed — no new payment");
    } finally {
      busy = false;
    }
  });
fetch("/config.json")
  .then((r) => r.json())
  .then((c) => {
    config = c;
    if (c.fixture) text("mode", "DEVELOPMENT — synthetic conformance fixture");
  })
  .catch(() => text("error", "Viewer configuration unavailable"));
