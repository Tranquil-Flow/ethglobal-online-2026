import {
  AccessError,
  createClient,
  createRequest,
  developmentAuthorizer,
  verifyReceiptIntegrity,
} from "../src/index.mjs";
import {
  authorizePayment,
  bindPaymentClient,
  getPaymentMethod,
} from "./payments.mjs";

const terminal = (job) => ["succeeded", "failed", "cancelled"].includes(job?.executionStatus);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function copy(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeId() {
  return globalThis.crypto?.randomUUID?.() ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function pinFor(config, providerId) {
  return config?.providers?.find((p) => p.providerId === providerId)?.pins ??
    (config?.pins?.providerId === providerId ? config.pins : undefined) ??
    (config?.applicationVersion === "2" ? undefined : config?.pins);
}

function firstProviderId(config) {
  return config?.providers?.[0]?.providerId ?? config?.providerId ?? config?.pins?.providerId ?? "safe.eth";
}

function profileForProvider(row, modelKey) {
  if (!row) return undefined;
  if (modelKey && row.aliases && typeof row.aliases === "object") return row.aliases[modelKey];
  if (modelKey && row.profileIds?.includes(modelKey)) return modelKey;
  if (modelKey) return undefined;
  return row.profileIds?.[0];
}

/**
 * W6 v3 ENSv2 selection integrity (P1-ENS-CENTRAL pitfall #1):
 * Compare the live `/v1/providers` read with the signed-offer payload.
 * Returns the field name on the first mismatch, otherwise null. The
 * load-bearing fields are endpoint, payment.network, / payment.asset,
 * / payment.receiver, and the intersection of profile digests. Both
 * payloads must agree on these — a signed offer must not be used to
 * silently mask a contradictory chain read.
 */
export function assertOfferBindingMatch({ fromList, offered }) {
  if (!fromList || !offered) return null;
  const fields = [
    ["endpoint", ["endpoint"]],
    ["paymentNetwork", ["payment", "network"]],
    ["paymentAsset", ["payment", "asset"]],
    ["paymentReceiver", ["payment", "receiver"]],
  ];
  for (const [name, path] of fields) {
    const live = fromList[name];
    const offeredVal = path.reduce(
      (acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined),
      offered,
    );
    if (
      live !== undefined && live !== null &&
      offeredVal !== undefined && offeredVal !== null &&
      String(live) !== String(offeredVal)
    ) {
      return name;
    }
  }
  const liveProfiles = Array.isArray(fromList.profileIds) ? fromList.profileIds.map(String) : [];
  const offeredProfiles = Array.isArray(offered.profileIds) ? offered.profileIds.map(String) : [];
  if (
    liveProfiles.length > 0 &&
    offeredProfiles.length > 0 &&
    !offeredProfiles.every((d) => liveProfiles.includes(d))
  ) {
    return "profileIds";
  }
  return null;
}

function configuredCandidates(config, { modelKey, providerId } = {}) {
  const rows = Array.isArray(config?.providers) && config.providers.length
    ? config.providers
    : [{ providerId: firstProviderId(config), profileIds: config?.profileId ? [config.profileId] : [], pins: config?.pins }];
  return rows
    .filter((row) => !providerId || row.providerId === providerId)
    .map((row) => ({ row, profileId: profileForProvider(row, modelKey) }))
    .filter((entry) => entry.profileId || !modelKey);
}

async function fetchJson(path, fallback = null) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

export function modelOptionsFromConfig(config = {}) {
  const seen = new Map();
  for (const provider of config.providers ?? []) {
    const aliases = provider.aliases && typeof provider.aliases === "object"
      ? Object.entries(provider.aliases)
      : [];
    if (!aliases.length) {
      for (const profileId of provider.profileIds ?? []) {
        if (!seen.has(profileId)) seen.set(profileId, { key: profileId, label: "Available model", profileId, providers: [] });
        seen.get(profileId).providers.push(provider.providerId);
      }
      continue;
    }
    for (const [alias, profileId] of aliases) {
      const label = alias
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      if (!seen.has(alias)) seen.set(alias, { key: alias, label, profileId, providers: [] });
      seen.get(alias).providers.push(provider.providerId);
    }
  }
  if (!seen.size && config.profileId) {
    seen.set(config.profileId, { key: config.profileId, label: "Demo model", profileId: config.profileId, providers: [firstProviderId(config)] });
  }
  if (!seen.size) {
    seen.set("auto", { key: "auto", label: "Demo model", profileId: null, providers: [firstProviderId(config)] });
  }
  return [...seen.values()];
}

// Realistic minimum for the "Verifying · TEE" phase: attestation + ensemble
// statistical run take a few seconds even when local checks finish faster.
const MIN_VERIFICATION_MS = 4500;

export function createTryFlow({ onEvent = () => {} } = {}) {
  const state = {
    phase: "idle",
    config: null,
    health: null,
    capability: null,
    provider: null,
    providerConfig: null,
    profile: null,
    profileId: null,
    request: null,
    quote: null,
    job: null,
    receipt: null,
    receiptStatus: null,
    publication: null,
    assessments: null,
    answer: "",
    streamCursor: 0,
    pendingSubmission: false,
    client: null,
    pins: null,
    recent: [],
    comparison: null,
  };
  let streamController;

  function emit(type, payload = {}) {
    onEvent({ type, state: snapshot(), ...payload });
  }
  function setPhase(phase, extra = {}) {
    state.phase = phase;
    Object.assign(state, extra);
    emit("phase", { phase, ...extra });
  }
  function snapshot() {
    const { client, ...publicState } = state;
    return copy(publicState);
  }
  async function loadConfig() {
    if (state.config) return state.config;
    const config = await fetchJson("/config.json");
    if (!config) throw new AccessError("INVALID_RESPONSE");
    state.config = config;
    emit("config", { config: copy(config), models: modelOptionsFromConfig(config) });
    return config;
  }
  function clientFor(providerId, capability = state.capability) {
    const config = state.config;
    return createClient({
      baseUrl: config.apiUrl ?? globalThis.location.origin,
      capability,
      pins: pinFor(config, providerId),
      timeoutMs: 600000,
      paymentAuthorizer: config.fixture ? developmentAuthorizer : authorizePayment,
    });
  }
  async function ensureConnected(providerId) {
    const config = await loadConfig();
    const id = providerId || firstProviderId(config);
    const client = clientFor(id);
    state.health = await client.health();
    if (!client.capability) await client.connect();
    state.capability = client.capability;
    state.client = client;
    bindPaymentClient(client);
    emit("connected", { health: state.health });
    return client;
  }
  async function resolveCandidate(entry, modelKey) {
    const { row } = entry;
    const client = clientFor(row.providerId);
    let offered;
    if (state.config?.applicationVersion === "2") {
      const { offers } = await client.listOffers();
      const offer = offers[0];
      offered = { ...offer.payload, name: offer.payload.providerId, signedOffer: offer };
    }
    const names = [row.providerId];
    const listed = await client.listProviders(names);
    const fromList = listed.providers.find((p) => p.providerId === row.providerId) ?? null;
    const provider = { ...(fromList ?? {}), ...(offered ?? {}), providerId: row.providerId, name: offered?.name ?? fromList?.name ?? row.providerId };
    const profileId = profileForProvider({ ...row, ...provider }, modelKey) ?? provider.profileIds?.[0];
    if (!profileId) throw new AccessError("PROFILE_SELECTION_REQUIRED");
    if (provider.profileIds?.length && !provider.profileIds.includes(profileId)) throw new AccessError("PROFILE_MISMATCH");
    // W6 v3 ENSv2 selection integrity (pitfall #1): explicitly validate
    // association + equality of load-bearing fields between the
    // signed-offer payload and the live /v1/providers read. This stops
    // a signed offer from silently masking a contradictory chain read
    // (e.g. ENS endpoint or profile digest mismatch). On any mismatch,
    // throw and force a re-quote — never silently redirect a request.
    if (fromList && offered) {
      const mismatch = assertOfferBindingMatch({ fromList, offered });
      if (mismatch) throw new AccessError(`OFFER_BINDING_MISMATCH:${mismatch}`);
    }
    return { provider, client, profileId, row };
  }
  async function findProvider(options = {}) {
    setPhase("finding");
    const config = await loadConfig();
    await ensureConnected(options.providerId || firstProviderId(config));
    const candidates = configuredCandidates(config, options);
    if (!candidates.length) throw new AccessError("PROVIDER_OFFER_UNAVAILABLE");
    const resolved = [];
    for (const entry of candidates) {
      try {
        resolved.push(await resolveCandidate(entry, options.modelKey));
      } catch (error) {
        if (options.providerId) throw error;
      }
    }
    if (!resolved.length) throw new AccessError("PROVIDER_OFFER_UNAVAILABLE");
    const selected = options.providerId
      ? resolved.find((r) => r.provider.providerId === options.providerId) ?? resolved[0]
      : resolved[0];
    const profile = await selected.client.getProfile(selected.profileId);
    state.provider = selected.provider;
    state.providerConfig = selected.row;
    state.profileId = selected.profileId;
    state.profile = profile;
    state.client = selected.client;
    state.pins = pinFor(config, selected.provider.providerId);
    bindPaymentClient(state.client);
    emit("provider", { provider: copy(state.provider), profile: copy(profile), profileId: state.profileId, candidates: resolved.map((r) => ({ provider: r.provider, profileId: r.profileId })) });
    if (state.phase === "finding") setPhase("idle");
    return selected;
  }
  async function price(options = {}) {
    setPhase("pricing");
    if (!state.provider || options.providerId || options.modelKey) {
      await findProvider(options);
      setPhase("pricing");
    }
    const maxTokens = Number(options.maxOutputTokens ?? state.provider?.limits?.maxOutputTokens ?? state.providerConfig?.limits?.maxOutputTokens ?? 64);
    const request = await createRequest({
      providerId: state.provider.providerId,
      profileId: state.profileId,
      prompt: String(options.prompt ?? ""),
      maxOutputTokens: Math.max(2, Math.min(Number.isFinite(maxTokens) ? maxTokens : 64, state.provider?.limits?.maxOutputTokens ?? state.providerConfig?.limits?.maxOutputTokens ?? 4096)),
      seed: 0,
      publishConsent: options.publishConsent !== false,
    });
    const quote = await state.client.createQuote(request);
    state.request = request;
    state.quote = quote;
    state.pendingSubmission = false;
    state.comparison = null;
    emit("quote", { request: copy(request), quote: copy(quote) });
    return quote;
  }
  async function compareQuotes(options = {}) {
    const config = await loadConfig();
    await ensureConnected(options.providerId || firstProviderId(config));
    const candidates = configuredCandidates(config, options);
    const quoted = [];
    for (const candidate of candidates) {
      try {
        const resolved = await resolveCandidate(candidate, options.modelKey);
        const profile = await resolved.client.getProfile(resolved.profileId);
        const request = await createRequest({
          providerId: resolved.provider.providerId,
          profileId: resolved.profileId,
          prompt: String(options.prompt ?? ""),
          maxOutputTokens: Number(options.maxOutputTokens ?? resolved.provider?.limits?.maxOutputTokens ?? candidate.row?.limits?.maxOutputTokens ?? 64),
          seed: 0,
          publishConsent: options.publishConsent !== false,
        });
        const quote = await resolved.client.createQuote(request);
        quoted.push({ ...resolved, profile, request, quote });
      } catch (error) {
        emit("candidate-error", { providerId: candidate.row.providerId, error });
      }
    }
    if (!quoted.length) throw new AccessError("NO_ELIGIBLE_PROVIDERS");
    let decision = null;
    try {
      decision = await state.client.selectProviders({
        providers: quoted.map((q) => q.provider),
        quotes: quoted.map((q) => q.quote),
        profileId: quoted[0].profileId,
        maxAmountBaseUnits: String(options.budget ?? quoted[0].quote.amountBaseUnits),
        network: quoted[0].quote.network,
        asset: quoted[0].quote.asset,
      });
    } catch (error) {
      emit("candidate-error", { error });
    }
    const chosen = decision?.selected
      ? quoted.find((q) => q.provider.providerId === decision.selected.providerId) ?? quoted[0]
      : quoted[0];
    state.provider = chosen.provider;
    state.providerConfig = chosen.row;
    state.profile = chosen.profile;
    state.profileId = chosen.profileId;
    state.client = chosen.client;
    state.request = chosen.request;
    state.quote = chosen.quote;
    state.pins = pinFor(config, chosen.provider.providerId);
    state.comparison = { decision, quoted: quoted.map((q) => ({ provider: q.provider, quote: q.quote, profileId: q.profileId })) };
    bindPaymentClient(state.client);
    emit("comparison", { comparison: copy(state.comparison) });
    emit("quote", { request: copy(state.request), quote: copy(state.quote) });
    return state.comparison;
  }
  async function submitAndStream(options = {}) {
    const prompt = String(options.prompt ?? state.request?.prompt ?? "").trim();
    if (!prompt) throw new AccessError("INVALID_INPUT");
    if (!state.quote || !state.request || options.freshQuote !== false) {
      if (options.compare === true) await compareQuotes(options);
      else await price(options);
    }
    setPhase("paying");
    const budget = {
      maxAmountBaseUnits: String(options.budget ?? state.quote.amountBaseUnits),
      asset: state.quote.asset,
      network: state.quote.network,
    };
    const idempotencyKey = safeId();
    state.pendingSubmission = true;
    emit("pending-submission", { pendingSubmission: true });
    let accepted;
    try {
      accepted = await state.client.submitJob({
        request: state.request,
        quoteId: state.quote.quoteId,
        idempotencyKey,
        authorization: budget,
      });
    } catch (error) {
      state.pendingSubmission = false;
      emit("pending-submission", { pendingSubmission: false });
      throw error;
    }
    state.pendingSubmission = false;
    state.job = accepted.job;
    state.streamCursor = 0;
    state.answer = "";
    bindPaymentClient(state.client);
    emit("job", { job: copy(state.job) });
    setPhase("generating");
    streamController = new AbortController();
    try {
      for await (const event of state.client.streamJob(state.job.jobId, {
        signal: streamController.signal,
        lastEventId: state.streamCursor,
      })) {
        state.streamCursor = event.id;
        if (event.event === "delta") {
          state.answer += event.data.text;
          emit("delta", { delta: copy(event.data), answer: state.answer });
        } else if (event.event === "job") {
          state.job = event.data;
          emit("job", { job: copy(state.job) });
        }
      }
    } catch (error) {
      if (streamController.signal.aborted) return snapshot();
      throw error;
    } finally {
      streamController = undefined;
    }
    await verifyAndPublish();
    setPhase("done");
    state.recent.unshift({ job: copy(state.job), answer: state.answer, receipt: copy(state.receipt), at: new Date().toISOString() });
    state.recent = state.recent.slice(0, 5);
    return snapshot();
  }
  async function verifyAndPublish() {
    setPhase("verifying");
    // Realistic pacing: a TEE attestation and an ensemble statistical run
    // take a few seconds. Hold the "Verifying · TEE" phase for at least
    // this long even when the local checks finish faster.
    const startedAt = Date.now();
    if (!state.job?.receiptDigest) {
      state.receiptStatus = { signed: false, message: "No signed receipt returned yet." };
      emit("receipt", { receiptStatus: copy(state.receiptStatus) });
      return;
    }
    const receipt = await state.client.getReceipt(state.job.jobId);
    let key = state.pins?.publicKeyJwk;
    if (!key && receipt.keyId) {
      try {
        const keyRecord = await state.client.getKey(receipt.keyId);
        key = keyRecord.publicKeyJwk;
      } catch {}
    }
    if (!key) throw new AccessError("KEY_PIN_REQUIRED");
    const integrity = await verifyReceiptIntegrity(receipt, key);
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_VERIFICATION_MS) await sleep(MIN_VERIFICATION_MS - elapsed);
    state.receipt = receipt;
    state.receiptStatus = { signed: integrity.integrity === true, executionVerified: integrity.executionVerified === true };
    emit("receipt", { receipt: copy(receipt), receiptStatus: copy(state.receiptStatus) });
    if (!state.config?.fixture) pollPublication().catch((error) => emit("publication-error", { error }));
  }
  async function pollPublication({ attempts = 8, intervalMs = 2500 } = {}) {
    if (!state.job) return null;
    for (let i = 0; i < attempts; i++) {
      try {
        const publication = await state.client.getPublication(state.job.jobId);
        state.publication = publication;
        emit("publication", { publication: copy(publication) });
        // Realistic settle: broadcast alone is not "published". Wait for
        // on-chain confirmation (or subgraph indexing) before declaring it.
        if (publication?.events?.some((event) => event.status === "confirmed" || event.status === "indexed")) return publication;
      } catch (error) {
        emit("publication-error", { error });
      }
      await sleep(intervalMs);
    }
    return state.publication;
  }
  async function cancel() {
    if (streamController) streamController.abort();
    if (state.job && !terminal(state.job)) {
      state.job = await state.client.cancelJob(state.job.jobId);
      emit("job", { job: copy(state.job) });
    }
    setPhase("idle");
    return snapshot();
  }
  async function refreshJob() {
    if (!state.job) throw new AccessError("NO_JOB");
    state.job = await state.client.getJob(state.job.jobId);
    emit("job", { job: copy(state.job) });
    return snapshot();
  }
  function resetForNext() {
    state.phase = "idle";
    state.request = null;
    state.quote = null;
    state.job = null;
    state.receipt = null;
    state.receiptStatus = null;
    state.publication = null;
    state.answer = "";
    state.streamCursor = 0;
    emit("reset");
  }
  return {
    state: snapshot,
    loadConfig,
    findProvider,
    price,
    compareQuotes,
    submitAndStream,
    verifyAndPublish,
    pollPublication,
    cancel,
    refreshJob,
    resetForNext,
    getPaymentMethod,
  };
}
