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
let formRevision = 0;
let jobCursor = 0,
  connecting = false,
  pendingSubmission = false,
  attemptContext;
const terminalJob = (j) =>
  ["succeeded", "failed", "cancelled"].includes(j.executionStatus);
function guardNewWork() {
  if (pendingSubmission) throw new AccessError("SUBMISSION_UNCERTAIN");
}
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
  formRevision++;
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
  config.providers?.find((p) => p.providerId === id)?.pins ??
  (config.applicationVersion === "2" ? undefined : config.pins);
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
    guardNewWork();
    if (busy || connecting) throw new AccessError("JOB_IN_PROGRESS");
    if (client?.capability) {
      status("Connected — already connected; existing session retained");
      return;
    }
    connecting = true;
    try {
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
    } finally {
      connecting = false;
    }
  });
$("revoke").onclick = () =>
  action(async () => {
    need();
    if (connecting) throw new AccessError("SESSION_OPERATION_IN_PROGRESS");
    connecting = true;
    streamController?.abort();
    try {
      await client.revoke();
      invalidate();
      status(
        "Session revoked — browser-only context is not a recovery credential",
      );
    } catch (error) {
      if (!(error instanceof AccessError) || error.status !== 401) throw error;
      // Server already rejects this credential. Forget locally only on the
      // user's explicit revoke; do not manufacture a new session or payment.
      client = undefined;
      invalidate();
      status(
        "Session unavailable — local connection forgotten; reconnect explicitly",
      );
    } finally {
      connecting = false;
    }
  });
$("find").onclick = () =>
  action(async () => {
    guardNewWork();
    need();
    if (busy) throw new AccessError("JOB_IN_PROGRESS");
    status("Finding provider…");
    provider = undefined;
    const revision = formRevision,
      name = $("provider").value,
      profileId = $("profile").value;
    const selectedClient = clientFor(name, client.capability);
    let p;
    if (config.applicationVersion === "2") {
      const { offers } = await selectedClient.listOffers();
      const o = offers[0];
      p = { ...o.payload, name: o.payload.providerId, signedOffer: o };
    } else {
      const list = await selectedClient.listProviders([name]);
      p = list.providers.find((p) => p.providerId === name);
    }
    if (!p) throw new AccessError("Provider unavailable");
    if (!p.profileIds.includes(profileId))
      throw new AccessError("Profile unavailable");
    const profile = await selectedClient.getProfile(profileId);
    if (formRevision !== revision) throw new AccessError("FORM_CHANGED_RETRY");
    provider = p;
    client = selectedClient;
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
    guardNewWork();
    need();
    if (!provider || provider.providerId !== $("provider").value)
      throw new AccessError("Find provider first");
    if (busy) throw new AccessError("JOB_IN_PROGRESS");
    status("Loading quote…");
    const revision = formRevision,
      selectedProvider = provider;
    const pendingRequest = await createRequest({
      providerId: provider.providerId,
      profileId: $("profile").value,
      prompt: $("prompt").value,
      maxOutputTokens: Number($("tokens").value),
      seed: 0,
      publishConsent: $("publish-consent")?.checked === true,
    });
    const pendingQuote = await client.createQuote(pendingRequest);
    if (formRevision !== revision || provider !== selectedProvider)
      throw new AccessError("FORM_CHANGED_RETRY");
    if (pendingQuote.mode !== provider.mode)
      throw new AccessError("MODE_MISMATCH");
    request = pendingRequest;
    quote = pendingQuote;
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
    guardNewWork();
    need();
    if (busy || submissionAttempted)
      throw new AccessError(
        "Existing attempt: inspect before new authorization",
      );
    if (!$("consent").checked)
      throw new AccessError("Explicit payment consent required");
    if (!quote || !request) throw new AccessError("Get quote first");
    const budget = $("budget")?.value ?? "10";
    if (
      !(["sponsored-local", "non-economic"].includes(config.accessPolicy)
        ? budget === "0"
        : /^[1-9][0-9]{0,4}$/.test(budget)) ||
      BigInt(budget) > 10000n
    )
      throw new AccessError("BUDGET_LIMIT");
    const submittingClient = client;
    // Private buyer metadata only: retain the exact attempt BEFORE the network call.
    // Never serialize the client/session capability or a wallet callback/proof.
    attemptContext = structuredClone({
      version: "viewer-attempt-v1",
      apiUrl: config.apiUrl,
      request,
      quote,
      pins: pinFor(request.providerId),
      idempotencyKey: crypto.randomUUID(),
      budget: {
        maxAmountBaseUnits: budget,
        asset: quote.asset,
        network: quote.network,
      },
    });
    busy = true;
    submissionAttempted = true;
    pendingSubmission = true;
    $("submit").disabled = true;
    text(
      "attempt-state",
      "Submitting the retained request — no new authorization on retry",
    );
    try {
      status("Submitting…");
      const r = await submittingClient.submitJob({
        request: attemptContext.request,
        quoteId: attemptContext.quote.quoteId,
        idempotencyKey: attemptContext.idempotencyKey,
        authorization: attemptContext.budget,
      });
      pendingSubmission = false;
      job = r.job;
      jobClient = submittingClient;
      jobPins = structuredClone(attemptContext.pins);
      jobCursor = 0;
      text("attempt-state", "Accepted — retained job " + job.jobId);
      text("receipt-state", "Not checked");
      text("assessment-state", "Separate — not requested");
      text(
        "publication-state",
        attemptContext.request.publishConsent
          ? "Not refreshed for this job"
          : "Not published — consent off",
      );
      text("answer", "");
      renderJob(job);
      if (!terminalJob(job) && !(await streamRetainedJob())) return;
      await publication();
      status("Stream finished");
    } finally {
      if (pendingSubmission)
        text(
          "attempt-state",
          "Submission outcome unknown — do not authorize again. Keep this page open and download private attempt context for provider reconciliation.",
        );
      busy = false;
      $("submit").disabled = false;
      $("consent").checked = false;
    }
  });
async function streamRetainedJob() {
  const activeClient = jobClient ?? client;
  streamController = new AbortController();
  const controller = streamController;
  try {
    for await (const e of activeClient.streamJob(job.jobId, {
      signal: controller.signal,
      lastEventId: jobCursor,
    })) {
      jobCursor = e.id;
      if (e.event === "delta")
        $("answer").append(document.createTextNode(e.data.text));
      if (e.event === "job") {
        job = e.data;
        renderJob(job);
      }
    }
    return true;
  } catch (error) {
    // Explicit local cancel/revoke should not become a spurious stream failure.
    if (controller.signal.aborted) return false;
    throw error;
  }
}
function renderJob(j) {
  text(
    "output-state",
    j.executionStatus === "succeeded"
      ? j.output
        ? "Complete — not computation-checked"
        : "Output unavailable — job completed"
      : terminalJob(j)
        ? "Incomplete — not computation-checked"
        : "Provisional — not computation-checked",
  );
  if (j.executionStatus === "succeeded") text("answer", j.output?.text ?? "");
  text(
    "job-state",
    j.executionStatus === "succeeded" ? "Completed" : j.executionStatus,
  );
  text(
    "payment-state",
    ["sponsored-local", "non-economic"].includes(config.accessPolicy)
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
      // Durable state survives expired event cursors and deleted evidence bundles.
      // SDK checks the retained request/output binding; this is not a receipt check.
      job = await (jobClient ?? client).getJob(job.jobId);
      renderJob(job);
      if (!terminalJob(job) && !(await streamRetainedJob())) return;
      await publication();
      status("Retained job refreshed — no new payment");
    } finally {
      busy = false;
    }
  });
$("download-attempt").onclick = () =>
  action(async () => {
    if (!attemptContext) throw new AccessError("NO_RETAINED_ATTEMPT");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(attemptContext, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "private-attempt-context.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status(
      "Private attempt context downloaded — not a session credential or proof of acceptance",
    );
  });
fetch("/config.json")
  .then((r) => r.json())
  .then((c) => {
    config = c;
    if (c.fixture) text("mode", "DEVELOPMENT — synthetic conformance fixture");
  })
  .catch(() => text("error", "Viewer configuration unavailable"));
