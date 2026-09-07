import {
  createClient,
  createRequest,
  developmentAuthorizer,
  AccessError,
} from "../src/index.mjs";
const $ = (id) => document.getElementById(id),
  text = (id, v) => ($(id).textContent = v);
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
for (const id of ["provider", "profile", "prompt", "tokens"])
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
const need = () => {
  if (!client?.capability) throw new AccessError("Connect explicitly first");
};
$("connect").onclick = () =>
  action(async () => {
    status("Connecting…");
    if (!config) config = await fetch("/config.json").then((r) => r.json());
    client = createClient({
      baseUrl: config.apiUrl,
      pins: config.pins,
      paymentAuthorizer: config.fixture
        ? developmentAuthorizer
        : async (context) => {
            if (!userPaymentAuthorizer)
              throw new AccessError("WALLET_AUTHORIZER_UNAVAILABLE");
            return userPaymentAuthorizer(context);
          },
    });
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
    status("Finding provider…");
    provider = undefined;
    const list = await client.listProviders([$("provider").value]);
    if (!list.providers.length) throw new AccessError("Provider unavailable");
    const p = list.providers[0];
    if (!p.profileIds.includes($("profile").value))
      throw new AccessError("Profile unavailable");
    const profile = await client.getProfile($("profile").value);
    provider = p;
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
    status("Loading quote…");
    request = await createRequest({
      providerId: provider.providerId,
      profileId: $("profile").value,
      prompt: $("prompt").value,
      maxOutputTokens: Number($("tokens").value),
      seed: 0,
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
      const r = await client.submitJob({
        request,
        quoteId: quote.quoteId,
        idempotencyKey: crypto.randomUUID(),
        authorization: {
          maxAmountBaseUnits: "10",
          asset: quote.asset,
          network: quote.network,
        },
      });
      job = r.job;
      renderJob(job);
      text("answer", "");
      streamController = new AbortController();
      for await (const e of client.streamJob(job.jobId, {
        signal: streamController.signal,
      })) {
        if (e.event === "delta")
          $("answer").append(document.createTextNode(e.data.text));
        if (e.event === "job") {
          job = e.data;
          renderJob(job);
        }
      }
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
  text("payment-state", (j.payment?.status || "unknown") + " · " + j.mode);
}
$("cancel").onclick = () =>
  action(async () => {
    if (!job) {
      text("job-state", "Nothing to cancel");
      return;
    }
    job = await client.cancelJob(job.jobId);
    renderJob(job);
    streamController?.abort();
    status("Cancellation requested explicitly");
  });
$("assess").onclick = () =>
  action(async () => {
    need();
    if (!job) throw new AccessError("No job");
    const a = await client.createAssessment(
      job.jobId,
      "independent-replay",
      crypto.randomUUID(),
    );
    text("assessment-state", "Separate — " + a.outcome + " (" + a.method + ")");
  });
$("download").onclick = () =>
  action(async () => {
    need();
    if (!job) throw new AccessError("No job");
    status("Validating private evidence…");
    const evidence = await client.getEvidence(job.jobId);
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
fetch("/config.json")
  .then((r) => r.json())
  .then((c) => {
    config = c;
    if (c.fixture) text("mode", "DEVELOPMENT — synthetic conformance fixture");
  })
  .catch(() => text("error", "Viewer configuration unavailable"));
