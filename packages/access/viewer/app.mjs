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
let jobClient,
  jobPins,
  recoveryRoot,
  recoveryArchive,
  preparingRecovery = false;
let formRevision = 0;
let jobCursor = 0,
  connecting = false,
  pendingSubmission = false,
  attemptContext,
  recoveredReadOnly = false;
const terminalJob = (j) =>
  ["succeeded", "failed", "cancelled"].includes(j.executionStatus);
function guardNewWork() {
  if (preparingRecovery)
    throw new AccessError("RECOVERY_OPERATION_IN_PROGRESS");
  if (recoveredReadOnly) throw new AccessError("RECOVERY_READ_ONLY");
  if (pendingSubmission) throw new AccessError("SUBMISSION_UNCERTAIN");
}
let client,
  config,
  provider,
  providerProfileId,
  request,
  quote,
  job,
  streamController,
  busy = false,
  submissionAttempted = false;
let userPaymentAuthorizer,
  auditStatusProvider,
  lastArchivedJobId;
// Trusted host code may inject a wallet UI callback; no DOM/data-controlled module loading.
export function setPaymentAuthorizer(callback) {
  if (typeof callback !== "function") throw new TypeError("Expected callback");
  userPaymentAuthorizer = callback;
}
export function setAuditStatusProvider(callback) {
  if (typeof callback !== "function") throw new TypeError("Expected callback");
  auditStatusProvider = callback;
}
export async function authorizeDemoPayment(context) {
  if (!client?.capability) throw new AccessError("Connect explicitly first");
  const result = await client.authorizeDemoPayment(context);
  text("payment-state", result.display?.label ?? "DEMO sponsored payment authorized");
  return result.headers;
}
const status = (v) => (document.querySelector("[role=status]").textContent = v);
function selectedProviderConfig() {
  return config?.providers?.find((row) => row.providerId === $("provider").value);
}
function selectedCapabilities() {
  const profileId = $("profile").value;
  const row = selectedProviderConfig();
  return (
    config?.profileCapabilities?.[profileId] ??
    row?.profileCapabilities?.[profileId] ??
    row?.capabilities ??
    {}
  );
}
function updateModelCapabilities() {
  const capability = selectedCapabilities();
  const profileId = $("profile").value;
  const row = selectedProviderConfig();
  const fact = (value, fallback = "not supplied") =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  text("capability-execution", "Execution: " + fact(capability.execution));
  text(
    "capability-payment",
    "Payment: " +
      fact(
        capability.payment,
        config?.accessPolicy === "non-economic"
          ? "non-economic"
          : config?.payment === "ordinary-x402-not-financial-protection"
            ? "x402"
            : "not supplied",
      ),
  );
  text(
    "capability-audit",
    "Verifier audits: " +
      fact(capability.verifierAudits ?? capability.audit, "unavailable"),
  );
  text("capability-placement", "Placement: " + fact(capability.placement));
  text("profile-digest", profileId || notSupplied);
  text("runtime-digest", row?.runtimeDigest ?? notSupplied);
}
function control(id, enabled, reasonId, reason) {
  $(id).disabled = !enabled;
  if (reasonId) text(reasonId, enabled ? "Ready." : reason);
}
function updateControls() {
  const connected = Boolean(client?.capability);
  const selected = Boolean(
    provider &&
      provider.providerId === $("provider").value &&
      providerProfileId === $("profile").value,
  );
  const promptReady = $("prompt").value.trim().length > 0;
  const quoteReady = Boolean(
    quote &&
      request &&
      request.profileId === $("profile").value &&
      request.providerId === $("provider").value,
  );
  const canQuote =
    connected &&
    selected &&
    promptReady &&
    !busy &&
    !pendingSubmission &&
    !recoveredReadOnly &&
    !preparingRecovery &&
    !recoveryArchive;
  control(
    "quote-button",
    canQuote,
    "quote-reason",
    !connected
      ? "Connect to continue."
      : !selected
        ? "Select and find this model's provider first."
        : !promptReady
          ? "Enter a prompt to request a quote."
          : busy
            ? "A job is in progress."
            : pendingSubmission
              ? "Submission outcome unknown — inspect the existing attempt before new work."
              : recoveryArchive
                ? "This recovery attempt is frozen."
                : "New work is unavailable in read-only recovery.",
  );
  if ($("compare-providers")) $("compare-providers").disabled = !canQuote;
  const canSubmit =
    quoteReady &&
    $("consent").checked &&
    !busy &&
    !submissionAttempted &&
    !pendingSubmission &&
    !recoveredReadOnly;
  control(
    "submit",
    canSubmit,
    "submit-reason",
    !quoteReady
      ? "Obtain a current quote."
      : !$("consent").checked
        ? "Explicit payment consent is required for this quote."
        : busy || submissionAttempted || pendingSubmission
          ? "Inspect the existing attempt before another authorization."
          : "Read-only recovery cannot submit work.",
  );
  const canCancel = Boolean(
    job && !terminalJob(job) && !recoveredReadOnly && !pendingSubmission,
  );
  control(
    "cancel",
    canCancel,
    "cancel-reason",
    recoveredReadOnly
      ? "Read-only recovery cannot cancel a job."
      : "No running job to cancel.",
  );
  const completedWithReceipt = Boolean(
    job?.executionStatus === "succeeded" && job.receiptDigest,
  );
  control(
    "assess",
    completedWithReceipt && !recoveredReadOnly && !busy,
    "assess-reason",
    recoveredReadOnly
      ? "Read-only recovery cannot request an assessment."
      : "Complete a job with a receipt first.",
  );
  control(
    "download",
    completedWithReceipt,
    "export-reason",
    "No completed job with a receipt to export.",
  );
  $("download-context").disabled = !job;
  $("download-attempt").disabled = !attemptContext;
  $("offline-check").disabled = !(
    $("offline-context").files?.[0] && $("offline-evidence").files?.[0]
  );
  const canStartNext = Boolean(
    job && terminalJob(job) && job.jobId !== lastArchivedJobId && !busy,
  );
  $("start-next-request").disabled = !canStartNext;
  text(
    "next-request-reason",
    canStartNext
      ? "Ready — the current job will be copied to prior evidence."
      : "Finish this request first. Prior job evidence will be retained below.",
  );
}
function invalidateQuote(message = "Quote invalidated — obtain a fresh quote") {
  formRevision++;
  quote = undefined;
  request = undefined;
  attemptContext = undefined;
  recoveryArchive = undefined;
  recoveryRoot = undefined;
  $("consent").checked = false;
  text("quote", message);
  updateControls();
}
function invalidateSelection() {
  invalidateQuote();
  provider = undefined;
  providerProfileId = undefined;
  text("provider-state", "No provider selected");
  text("profile-info", "");
  text("history", "History invalidated — find the provider for the selected model");
  text("history-receipts-seen", "Receipts seen: not loaded");
  const comparison = $("history-comparison");
  comparison?.replaceChildren();
  updateModelCapabilities();
  renderAuditUnavailable("Unavailable — model changed; no audit loaded");
}
const invalidate = invalidateQuote;
for (const id of ["prompt", "tokens", "publish-consent", "budget"])
  $(id).addEventListener("input", () => invalidateQuote());
for (const id of ["provider", "profile"])
  $(id).addEventListener("input", invalidateSelection);
$("consent").addEventListener("change", updateControls);
for (const id of ["offline-context", "offline-evidence"])
  $(id).addEventListener("change", updateControls);
$("provider-choice").addEventListener("change", () => queueMicrotask(updateModelCapabilities));
$("profile-choice").addEventListener("change", () => queueMicrotask(updateModelCapabilities));
new MutationObserver(updateModelCapabilities).observe($("profile-choice"), {
  childList: true,
});
async function action(fn) {
  text("error", "");
  try {
    await fn();
  } catch (e) {
    showRuntimeDiagnostic(e);
    text(
      "error",
      e instanceof AccessError
        ? e.code
        : "Operation unavailable; no automatic repayment",
    );
    status("Error — explicit retry required");
  } finally {
    updateControls();
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
// These links expose only server-supplied public identifiers on an explicit click.
// No prefetch, HTML interpretation, credential-bearing URL or inferred receipt count.
const notSupplied = "Not supplied";
const runtimeDiagnostics = Object.freeze({
  NATIVE_TIMEOUT:
    "Native runtime timed out. The request was not retried or repaid automatically.",
  NATIVE_BUSY: "Native runtime is busy. Wait before explicitly retrying.",
  RUNTIME_BUSY: "Runtime is busy. Wait before explicitly retrying.",
  PROVIDER_BUSY: "Provider is busy. Wait before explicitly retrying.",
  JOB_IN_PROGRESS: "Runtime is busy with the current job.",
});
function showRuntimeDiagnostic(error) {
  const message = runtimeDiagnostics[error?.code];
  if (!message) return;
  text("runtime-diagnostic", message);
  $("runtime-diagnostic").dataset.level = "warning";
}
function clearRuntimeDiagnostic() {
  text("runtime-diagnostic", "No runtime diagnostic.");
  delete $("runtime-diagnostic").dataset.level;
}
function displayFact(value) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Number.isSafeInteger(value)) return String(value);
  return notSupplied;
}
function sponsorLink(parent, label, href) {
  const link = document.createElement("a");
  link.className = "sponsor-link";
  link.textContent = label;
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  parent.append(link);
}
function graphLink(value) {
  text("history-url", "Graph query URL: ");
  if (!value) return $("history-url").append(notSupplied);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("UNSAFE_URL");
    sponsorLink($("history-url"), value, url.href);
  } catch {
    $("history-url").append("Unavailable — unsafe URL");
  }
}
function transaction(id, prefix, value, kind) {
  const parent = typeof id === "string" ? $(id) : id;
  parent.textContent = prefix;
  if (!value) return parent.append(notSupplied);
  const href =
    kind === "hedera" && /^0\.0\.\d+[@-]\d+[.-]\d{1,9}$/.test(value)
      ? "https://hashscan.org/testnet/transaction/" + encodeURIComponent(value)
      : kind === "sepolia" && /^0x[0-9a-fA-F]{64}$/.test(value)
        ? "https://sepolia.etherscan.io/tx/" + value
        : undefined;
  if (href) sponsorLink(parent, value, href);
  else parent.append(document.createTextNode(value));
}
const claimClass = {
  pending: "neutral",
  running: "unchecked",
  completed: "complete",
  unchecked: "unchecked",
  valid: "valid",
  unavailable: "unavailable",
  failed: "failed",
  cancelled: "unavailable",
};
function setClaim(id, state, label) {
  const element = $(id);
  if (!element) return;
  element.dataset.state = state;
  element.className = "claim " + (claimClass[state] ?? "neutral");
  element.textContent = label;
}
function receiptLabelFor(j) {
  return j?.receiptDigest
    ? "Receipt available — integrity unchecked · " + j.receiptDigest
    : "Receipt integrity — unavailable";
}
function friendlyNetwork(value) {
  const names = {
    "hedera:testnet": "Hedera testnet",
    "hedera-testnet": "Hedera testnet",
    testnet: "Hedera testnet",
    "eip155:84532": "Base Sepolia (eip155:84532)",
  };
  return names[value] ?? value;
}
function tinybarToHbar(value) {
  const digits = String(value);
  const whole = digits.length > 8 ? digits.slice(0, -8) : "0";
  const fraction = digits.padStart(9, "0").slice(-8).replace(/0+$/, "");
  return fraction ? whole + "." + fraction : whole;
}
function quoteLabel(value) {
  const hbar = String(value.asset).toUpperCase() === "HBAR";
  const amount = hbar
    ? `${value.amountBaseUnits} tinybar (${tinybarToHbar(value.amountBaseUnits)} HBAR)`
    : `${value.amountBaseUnits} base units ${value.asset}`;
  const expiry = new Date(value.expiresAt);
  return (
    `${amount} · ${friendlyNetwork(value.network)} · recipient ${value.receiver} · expires ` +
    (Number.isFinite(expiry.valueOf()) ? expiry.toLocaleString() : value.expiresAt)
  );
}
function setRuntimeFacts(report, row) {
  clearRuntimeDiagnostic();
  const observedAt = row?.observedAt ?? report?.observedAt;
  const age = Number.isFinite(Date.parse(observedAt))
    ? Math.max(0, Date.now() - Date.parse(observedAt))
    : undefined;
  text("runtime-member", displayFact(row?.member ?? row?.memberState));
  text("runtime-serving", displayFact(row?.serving ?? row?.state));
  text("runtime-executing", displayFact(row?.executing));
  text("runtime-last-success", displayFact(row?.lastSuccessAt ?? row?.last_success));
  text(
    "runtime-freshness",
    age === undefined
      ? notSupplied
      : `${age <= 30_000 ? "fresh" : "stale"} · ${Math.round(age / 1000)} s old`,
  );
}
async function refreshRuntimeStatus(providerId) {
  setRuntimeFacts(undefined, undefined);
  try {
    const response = await fetch(config.apiUrl + "/v2/runtime-status");
    if (!response.ok) return;
    const report = await response.json();
    const row = report.providers?.find((p) => p.providerId === providerId);
    if (!row) return;
    setRuntimeFacts(report, row);
  } catch {}
}
async function publication() {
  if (!job || config.fixture) return;
  // Clear first: a failed refresh must not preserve an old transaction claim.
  transaction("publication-tx", "Publication transaction: ", undefined);
  const p = await (jobClient ?? client).getPublication(job.jobId);
  text(
    "publication-state",
    p.consent
      ? p.events.length
        ? p.events.map((e) => e.kind + ": " + e.status).join(" · ")
        : "Consent given; no publishable result yet"
      : "Not published — consent off",
  );
  const events = p.consent ? p.events.filter((e) => e.transactionRef) : [];
  if (events.length) {
    text("publication-tx", "Publication transactions: ");
    for (const [i, event] of events.entries()) {
      if (i) $("publication-tx").append(" · ");
      const item = document.createElement("span");
      transaction(item, event.kind + ": ", event.transactionRef, "sepolia");
      $("publication-tx").append(item);
    }
  }
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
    providerProfileId = undefined;
    text("provider-ens-name", "Provider ENS name: " + notSupplied);
    text("provider-state", "No provider selected");
    text("history", "History: not loaded");
    graphLink();
    const revision = formRevision,
      name = $("provider").value,
      profileId = $("profile").value;
    const selectedClient = clientFor(name, client.capability);
    let p;
    if (config.applicationVersion === "2") {
      const { offers } = await selectedClient.listOffers();
      const o = offers[0];
      p = { ...o.payload, name: o.payload.providerId, signedOffer: o };
      const records = await selectedClient.listProviders([name]);
      const record = records.providers.find(
        (x) =>
          x.providerId === p.providerId &&
          x.mode === p.mode &&
          x.profileIds.includes(profileId),
      );
      if (record?.historyEndpoint) p.historyEndpoint = record.historyEndpoint;
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
    providerProfileId = profileId;
    client = selectedClient;
    text("provider-state", p.name);
    text("provider-ens-name", "Provider ENS name: " + p.providerId);
    const source = p.source
      ? `Resolved on ${p.source.chainId} at block ${p.source.blockNumber}; record expires ${p.source.expiresAt}.`
      : "Resolution provenance: " + notSupplied + ".";
    text("resolved-record", `Endpoint: ${p.endpoint ?? notSupplied}. ${source}`);
    graphLink(p.historyEndpoint);
    text("profile-info", profile.model + " · " + p.mode);
    text("profile-digest", profileId);
    text("runtime-digest", selectedProviderConfig()?.runtimeDigest ?? notSupplied);
    updateModelCapabilities();
    await refreshRuntimeStatus(p.providerId);
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
    text(
      "history-receipts-seen",
      `Receipts seen: ${h.observations.length} assessment observations · indexed block ${h.indexedBlock ?? "unknown"}`,
    );
    status("Provider selected — no prompt fan-out");
  });
$("quote-button").onclick = () =>
  action(async () => {
    guardNewWork();
    need();
    if (recoveryArchive) throw new AccessError("RECOVERY_ATTEMPT_FROZEN");
    if (
      !provider ||
      provider.providerId !== $("provider").value ||
      providerProfileId !== $("profile").value
    )
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
    if (preparingRecovery || recoveryArchive)
      throw new AccessError("RECOVERY_ATTEMPT_FROZEN");
    if (formRevision !== revision || provider !== selectedProvider)
      throw new AccessError("FORM_CHANGED_RETRY");
    if (pendingQuote.mode !== provider.mode)
      throw new AccessError("MODE_MISMATCH");
    request = pendingRequest;
    quote = pendingQuote;
    attemptContext = undefined;
    recoveryArchive = undefined;
    recoveryRoot = undefined;
    submissionAttempted = false;
    $("consent").checked = false;
    text("quote", quoteLabel(quote));
    text(
      "selection-decision",
      "Quote frozen for " + quote.providerId + " — compare providers to make Graph-attributed selection visible",
    );
    status("Quote ready — payment requires consent");
  });
// Explicit user action: only this comparison button requests quotes for the
// compatible configured providers. It never submits, signs, or pays a job.
const compareButton = document.createElement("button");
compareButton.id = "compare-providers";
compareButton.textContent = "Compare providers using this prompt (quotes only)";
compareButton.setAttribute("aria-describedby", "quote-reason");
$("quote-button").after(compareButton);
const historyComparisonList = document.createElement("div");
historyComparisonList.id = "history-comparison";
historyComparisonList.setAttribute("aria-live", "polite");
$("history").after(historyComparisonList);
async function refreshComparison() {
  historyComparisonList.replaceChildren();
  const response = await fetch(config.apiUrl + "/v2/history-comparison");
  if (!response.ok) throw new AccessError("HISTORY_UNAVAILABLE");
  const comparison = await response.json();
  if (comparison.version !== "2" || !Array.isArray(comparison.providers)) throw new AccessError("INVALID_HISTORY_COMPARISON");
  for (const row of comparison.providers) {
    const article = document.createElement("article");
    article.dataset.provider = row.providerId;
    const title = document.createElement("h3"); title.textContent = row.providerId; article.append(title);
    for (const m of row.measures ?? []) {
      const summary = document.createElement("p");
      summary.textContent = `${m.source?.subgraph ?? "Graph source"} · ${m.source?.deploymentId ?? "unknown deployment"} · ${m.freshness} · indexed-head age ${m.freshnessAgeMs ?? "unknown"} ms · sample ${m.sampleDenominator} · receipt blocks ${m.observationWindow?.fromBlock ?? "none"}–${m.observationWindow?.toBlock ?? "none"}`;
      const reasons = document.createElement("p"); reasons.textContent = (m.reasonCodes ?? []).join(" · ");
      const limit = document.createElement("p"); limit.textContent = m.doesNotProve;
      article.append(summary, reasons, limit);
    }
    historyComparisonList.append(article);
  }
}
compareButton.onclick = () => action(async () => {
  guardNewWork(); need();
  if (busy || recoveryArchive || submissionAttempted) throw new AccessError("EXISTING_ATTEMPT_INSPECT_FIRST");
  const revision = formRevision, profileId = $("profile").value;
  const names = config.providers.filter(p => p.profileIds.includes(profileId)).map(p => p.providerId);
  const listed = await client.listProviders(names);
  const quoted = [];
  for (const p of listed.providers) {
    const candidate = clientFor(p.providerId, client.capability);
    const r = await createRequest({providerId:p.providerId,profileId,prompt:$("prompt").value,maxOutputTokens:Number($("tokens").value),seed:0,publishConsent:$("publish-consent")?.checked===true});
    quoted.push({provider:p,client:candidate,request:r,quote:await candidate.createQuote(r)});
  }
  if (!quoted.length) throw new AccessError("NO_ELIGIBLE_PROVIDERS");
  const decision = await client.selectProviders({providers:quoted.map(x=>x.provider),quotes:quoted.map(x=>x.quote),profileId,maxAmountBaseUnits:$("budget").value,network:quoted[0].quote.network,asset:quoted[0].quote.asset});
  if (revision !== formRevision) throw new AccessError("FORM_CHANGED_RETRY");
  const chosen = quoted.find(x=>x.provider.providerId===decision.selected?.providerId);
  if (!chosen) throw new AccessError("NO_ELIGIBLE_PROVIDERS");
  client=chosen.client;provider=chosen.provider;providerProfileId=profileId;request=chosen.request;quote=chosen.quote;
  $("provider").value=provider.providerId;$("provider-choice").value=provider.providerId;
  $("consent").checked=false;attemptContext=undefined;recoveryRoot=undefined;
  text("provider-state",provider.name);text("provider-ens-name","Provider ENS name: "+provider.name);
  text("quote",quoteLabel(quote));
  text("selection-decision",`Selected ${provider.providerId} from ${quoted.length} candidates · `+decision.reasons.map(r=>`${r.providerId}: ${r.codes.join(", ")}`).join("; "));
  await refreshComparison();
  status("Quote ready — selected using Graph receipt history; no payment yet");
});

function recoveryPassphrase() {
  const value = $("recovery-passphrase").value;
  if (value.length < 12 || value.length > 256)
    throw new AccessError("RECOVERY_PASSPHRASE_REQUIRED");
  return value;
}
function downloadJson(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("download-recovery").onclick = () =>
  action(async () => {
    guardNewWork();
    need();
    if (!request || !quote) throw new AccessError("Get quote first");
    if (submissionAttempted)
      throw new AccessError("RECOVERY_MUST_PRECEDE_SUBMISSION");
    if (recoveryArchive) throw new AccessError("RECOVERY_ALREADY_PREPARED");
    const passphrase = recoveryPassphrase(),
      revision = formRevision,
      originClient = client;
    const pendingAttempt = structuredClone({
      version: "viewer-attempt-v1",
      apiUrl: config.apiUrl,
      request,
      quote,
      pins: pinFor(request.providerId),
      idempotencyKey: crypto.randomUUID(),
      budget: {
        maxAmountBaseUnits: $("budget")?.value ?? "10",
        asset: quote.asset,
        network: quote.network,
      },
    });
    preparingRecovery = true;
    try {
      const archive = await originClient.exportRecovery({
        request: pendingAttempt.request,
        quote: pendingAttempt.quote,
        idempotencyKey: pendingAttempt.idempotencyKey,
        passphrase,
      });
      if (revision !== formRevision || client !== originClient) {
        let revoked = false;
        try {
          await originClient.revokeRecovery(archive, passphrase);
          revoked = true;
        } catch {}
        text(
          "attempt-state",
          revoked
            ? "Changed attempt discarded; unused recovery revoked"
            : "Changed attempt discarded; unused recovery revocation unconfirmed",
        );
        throw new AccessError("FORM_CHANGED_RETRY");
      }
      attemptContext = pendingAttempt;
      recoveryArchive = archive;
      recoveryRoot = originClient;
      downloadJson(recoveryArchive, "encrypted-attempt-recovery.json");
      text(
        "attempt-state",
        "Encrypted recovery downloaded before submission — exact attempt frozen",
      );
      status("Recovery ready — now explicitly authorize this frozen attempt");
    } finally {
      preparingRecovery = false;
      $("recovery-passphrase").value = "";
    }
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
    // Recovery-aware submissions reuse the exact pre-exported identifier. Ordinary
    // submissions retain the same private in-memory context as before.
    if (!attemptContext)
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
    if (attemptContext.budget.maxAmountBaseUnits !== budget)
      throw new AccessError("RECOVERY_ATTEMPT_CHANGED");
    busy = true;
    submissionAttempted = true;
    pendingSubmission = true;
    updateControls();
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
      transaction("publication-tx", "Publication transaction: ", undefined);
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
$("import-recovery").onclick = () =>
  action(async () => {
    if (!config) config = await fetch("/config.json").then((r) => r.json());
    const file = $("recovery-file").files?.[0];
    if (!file || file.size > 2097152)
      throw new AccessError("RECOVERY_FILE_REQUIRED");
    const archive = JSON.parse(await file.text());
    const passphrase = recoveryPassphrase();
    const root = createClient({ baseUrl: config.apiUrl });
    try {
      const recovered = await root.importRecovery(archive, passphrase);
      recoveryRoot = root;
      recoveryArchive = archive;
      recoveredReadOnly = true;
      request = structuredClone(recovered.attempt.request);
      quote = structuredClone(recovered.attempt.quote);
      attemptContext = {
        version: "viewer-attempt-v1",
        apiUrl: config.apiUrl,
        request,
        quote,
        pins: structuredClone(recovered.pins),
        idempotencyKey: recovered.attempt.idempotencyKey,
      };
      $("submit").disabled = true;
      $("cancel").disabled = true;
      $("assess").disabled = true;
      if (recovered.status === "unresolved") {
        text(
          "attempt-state",
          "Recovery imported read-only — attempt unresolved",
        );
        status("Attempt unresolved — no submit or resubmit permitted");
        return;
      }
      client = recovered.client;
      jobClient = recovered.client;
      jobPins = structuredClone(recovered.pins);
      job = recovered.job;
      jobCursor = 0;
      renderJob(job);
      text(
        "attempt-state",
        "Recovered accepted job read-only — no resubmission",
      );
      text("receipt-state", "Not checked");
      text("assessment-state", "Separate — read-only recovery");
      await publication();
      status("Accepted job recovered read-only — no new payment or execution");
    } finally {
      $("recovery-passphrase").value = "";
    }
  });
$("revoke-recovery").onclick = () =>
  action(async () => {
    if (!recoveryRoot || !recoveryArchive)
      throw new AccessError("NO_IMPORTED_RECOVERY");
    const passphrase = recoveryPassphrase();
    try {
      await recoveryRoot.revokeRecovery(recoveryArchive, passphrase);
      streamController?.abort();
      client = undefined;
      jobClient = undefined;
      job = undefined;
      recoveredReadOnly = false;
      recoveryRoot = undefined;
      recoveryArchive = undefined;
      $("submit").disabled = false;
      $("cancel").disabled = false;
      $("assess").disabled = false;
      text(
        "attempt-state",
        "Recovery revoked — reconnect explicitly for new work",
      );
      text("job-state", "No job");
      text("answer", "");
      status("Recovery revoked");
    } finally {
      $("recovery-passphrase").value = "";
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
  const terminal = terminalJob(j);
  const executionState =
    j.executionStatus === "succeeded"
      ? "completed"
      : j.executionStatus === "failed"
        ? "failed"
        : j.executionStatus === "cancelled"
          ? "cancelled"
          : "running";
  setClaim(
    "execution-claim",
    executionState,
    executionState === "completed"
      ? "Execution — completed"
      : executionState === "running"
        ? "Execution — running"
        : "Execution — " + j.executionStatus,
  );
  setClaim(
    "output-claim",
    j.executionStatus === "succeeded"
      ? j.output
        ? "unchecked"
        : "unavailable"
      : terminal
        ? "unavailable"
        : "unchecked",
    j.executionStatus === "succeeded" && j.output
      ? "Output — available, unchecked"
      : terminal
        ? "Output — unavailable, unchecked"
        : "Output — provisional, unchecked",
  );
  setClaim(
    "receipt-claim",
    j.receiptDigest ? "unchecked" : "unavailable",
    j.receiptDigest
      ? "Receipt integrity — unchecked"
      : "Receipt integrity — unavailable",
  );
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
  text("receipt-state", receiptLabelFor(j));
  text("receipt-digest", j.receiptDigest ?? notSupplied);
  const sponsorPolicy = ["sponsored-local", "non-economic"].includes(
    config.accessPolicy,
  );
  const paymentLabel = sponsorPolicy
    ? "Non-monetary — no settlement or refund claim"
    : (j.payment?.status || "unknown") + " · " + j.mode;
  text("payment-state", paymentLabel);
  renderPaymentModeBadge(j, sponsorPolicy);
  transaction(
    "payment-tx",
    "Transaction: ",
    j.payment?.transactionRef,
    "hedera",
  );
  $("payment-tx").append(" · Facilitator: " + notSupplied);
  updateControls();
}

// Active payment mode for the receipt card. Reads W6_PAYMENT_MODE (default
// "demo"). "demo" shows a DEMO sponsor-funded badge; "wallet" surfaces the
// real Hedera wallet-connect UI so users can sign with their own account.
// Mirrors composition/w6-demo-sponsor.mjs getPaymentMode — the viewer is
// a trusted host, so reading process.env here is acceptable. A duplicate of
// the constant is intentionally kept here so the renderer does not have to
// load the server-only sponsor module.
function viewerPaymentMode() {
  const raw = (globalThis?.process?.env?.W6_PAYMENT_MODE ?? "")
    .toString()
    .trim()
    .toLowerCase();
  return raw === "wallet" ? "wallet" : "demo";
}

function renderPaymentModeBadge(j, sponsorPolicy) {
  const node = $("payment-mode-badge");
  if (!node) return;
  const mode = viewerPaymentMode();
  node.dataset.mode = mode;
  if (sponsorPolicy) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  if (mode === "wallet") {
    node.className = "payment-mode-badge payment-mode-wallet";
    node.textContent =
      "Wallet mode — connect HashPack to sign your own payment-signature header.";
    return;
  }
  node.className = "payment-mode-badge payment-mode-demo";
  const sponsor = j.payment?.payer?.accountId ?? config?.payerAccountId;
  node.textContent = sponsor
    ? `DEMO mode — this request is funded by the project's DEMO sponsor (${sponsor}). No wallet required.`
    : "DEMO mode — this request is funded by the project's DEMO sponsor. No wallet required.";
}
// Wallet-mode controls (only meaningful when W6_PAYMENT_MODE=wallet). The
// HashPack / WalletConnect wiring lives in w6-hashpack-adapter.mjs; this
// handler is a thin affordance that opens a connect dialog when the user
// wants to switch out of DEMO mode without leaving the receipt card.
const connectWalletButton = $("connect-wallet");
if (connectWalletButton) {
  connectWalletButton.onclick = () =>
    action(async () => {
      status("Connect your Hedera wallet (HashPack) to sign your own payment-signature header.");
      const connect =
        globalThis?.w6ConnectWallet ?? globalThis?.hashpackConnect;
      if (typeof connect === "function") {
        try {
          await connect();
          status("Wallet connected — payment-signature headers will be signed locally.");
        } catch (error) {
          status("Wallet connect failed: " + (error?.message ?? "unknown"));
        }
      } else {
        status(
          "Wallet adapter not injected by host — open the demo with the HashPack adapter enabled to use wallet mode.",
        );
      }
    });
}

$("cancel").onclick = () =>
  action(async () => {
    if (recoveredReadOnly) throw new AccessError("RECOVERY_READ_ONLY");
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
    if (recoveredReadOnly) throw new AccessError("RECOVERY_READ_ONLY");
    need();
    if (!job) throw new AccessError("No job");
    const a = await (jobClient ?? client).createAssessment(
      job.jobId,
      config.replayMethod || "independent-replay",
      crypto.randomUUID(),
    );
    text("assessment-state", "Separate — " + a.outcome + " (" + a.method + ")");
      if (a.outcome === "unavailable") {
        setClaim("assessment-claim", "unavailable", "Assessment — unavailable");
      } else if (a.outcome === "mismatch") {
        setClaim("assessment-claim", "failed", "Assessment — mismatch");
      } else {
        setClaim(
          "assessment-claim",
          "unchecked",
          "Assessment — " + a.outcome + " (separate)",
        );
      }
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
      "Integrity verified against configured pin — not inference verification" +
        (job?.receiptDigest ? " · " + job.receiptDigest : ""),
    );
    setClaim(
      "receipt-claim",
      "valid",
      "Receipt integrity — valid",
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
      "Integrity verified against configured pin — not inference verification" +
        (job?.receiptDigest ? " · " + job.receiptDigest : ""),
    );
    setClaim(
      "receipt-claim",
      "valid",
      "Receipt integrity — valid",
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

const auditCapabilities = Object.freeze({
  "tee-attested": "TEE-attested verifier",
  local: "Local verifier (not TEE)",
  unavailable: "Unavailable",
  "not-applicable": "Not applicable",
});
function renderAuditUnavailable(summary = "Unavailable — no audit loaded") {
  $("audit-status-panel").dataset.outcome = "unavailable";
  text("audit-summary", summary);
  const capability = selectedCapabilities().verifierAudits ?? selectedCapabilities().audit;
  text("audit-capability", auditCapabilities[capability] ?? "Unavailable");
  text("audit-id", notSupplied);
  text("audit-trigger-id", notSupplied);
}
function safeAuditIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)
    ? value
    : undefined;
}
function renderAuditStatus(result) {
  const audit = result?.audit;
  const auditId = safeAuditIdentifier(audit?.audit_id);
  const triggerId = safeAuditIdentifier(audit?.trigger_request_id);
  const outcome = audit?.outcome;
  const state = typeof outcome === "string" ? outcome : outcome?.status;
  const errorCode =
    typeof outcome?.error_code === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/.test(outcome.error_code)
      ? outcome.error_code
      : undefined;
  if (
    !["match", "mismatch", "inconclusive", "unavailable"].includes(state) ||
    !auditId ||
    !triggerId ||
    auditId === triggerId
  ) {
    renderAuditUnavailable("Unavailable — invalid or missing audit identity");
    return;
  }
  const labels = {
    match: "Match — reference sample matched",
    mismatch: "Mismatch — reference sample differed",
    inconclusive: "Inconclusive — reference sample could not decide",
    unavailable: "Unavailable — reference-sample audit did not complete",
  };
  $("audit-status-panel").dataset.outcome = state;
  text("audit-summary", labels[state] + (errorCode ? ` (${errorCode})` : ""));
  text(
    "audit-capability",
    auditCapabilities[result.capability] ?? "Unavailable",
  );
  text("audit-id", auditId);
  text("audit-trigger-id", triggerId);
}
async function refreshAuditStatus() {
  const button = $("refresh-audit");
  button.disabled = true;
  text("audit-summary", "Loading independent audit status…");
  try {
    const capability = selectedCapabilities().verifierAudits ?? selectedCapabilities().audit;
    const result = auditStatusProvider
      ? await auditStatusProvider({
          job: job ? structuredClone(job) : undefined,
          request: request ? structuredClone(request) : undefined,
          quote: quote ? structuredClone(quote) : undefined,
          capability,
        })
      : { capability: capability ?? "unavailable", audit: null };
    renderAuditStatus(result);
  } catch {
    renderAuditUnavailable("Unavailable — audit status could not be loaded");
  } finally {
    button.disabled = false;
  }
}
$("refresh-audit").onclick = refreshAuditStatus;

function archiveCurrentJob() {
  const article = document.createElement("article");
  const title = document.createElement("h4");
  title.textContent = `Job ${job.jobId}`;
  const summary = document.createElement("p");
  summary.textContent = [
    `Execution: ${job.executionStatus}`,
    `Payment: ${$("payment-state").textContent}`,
    `Receipt: ${job.receiptDigest ?? notSupplied}`,
    `Assessment: ${$("assessment-state").textContent}`,
  ].join(" · ");
  const output = document.createElement("pre");
  output.setAttribute("aria-label", "Prior job output");
  output.textContent = job.output?.text ?? $("answer").textContent;
  article.append(title, summary, output);
  $("prior-job-list").append(article);
  $("prior-job-evidence").hidden = false;
  lastArchivedJobId = job.jobId;
}
$("start-next-request").onclick = () =>
  action(async () => {
    if (!job || !terminalJob(job) || busy)
      throw new AccessError("NO_COMPLETED_JOB_TO_ARCHIVE");
    archiveCurrentJob();
    submissionAttempted = false;
    pendingSubmission = false;
    invalidateQuote("No quote yet — previous job evidence retained below");
    $("prompt").value = "";
    text(
      "selection-decision",
      "Previous job retained — enter the next prompt and obtain a fresh quote",
    );
    status("Ready for next request — prior job evidence retained");
  });

setRuntimeFacts(undefined, undefined);
renderAuditUnavailable();
updateControls();
fetch("/config.json")
  .then((r) => r.json())
  .then((c) => {
    config = c;
    if (c.fixture) text("mode", "DEVELOPMENT — synthetic conformance fixture");
    updateModelCapabilities();
    renderAuditUnavailable();
    updateControls();
  })
  .catch(() => text("error", "Viewer configuration unavailable"));
