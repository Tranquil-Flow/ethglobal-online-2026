import { validate, digestOf, canonicalBytes } from "./contracts.mjs";
import {
  validateSignedOffer,
  offerSigningText,
} from "../../contracts/offers.mjs";
import { AccessError, fail, checked, exact, id } from "./errors.mjs";
import { exportRecovery, proveRecovery } from "./recovery.mjs";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
export { AccessError };
const dto = (name, v, response = false) => checked(validate, name, v, response);
const amount = (v) => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
const enc = (v) => {
  if (!id(v)) fail("INVALID_INPUT");
  return encodeURIComponent(v);
};
const jsonClone = (v) => JSON.parse(JSON.stringify(v));
function validateRecovered(result, input, quote) {
  exact(result, ["version", "status", "job", "capability"]);
  dto("Job", result.job, true);
  if (
    result.version !== "2" ||
    result.status !== "accepted" ||
    typeof result.capability !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.capability) ||
    result.job.requestHash !== quote.requestHash ||
    result.job.mode !== quote.mode ||
    quote.providerId !== input.providerId ||
    quote.profileId !== input.profileId ||
    !result.job.payment
  )
    fail("JOB_MISMATCH");
  for (const k of ["quoteId", "requestHash", "mode"])
    if (result.job.payment[k] !== quote[k]) fail("JOB_MISMATCH");
}
export function safeBaseUrl(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    fail("UNSAFE_URL");
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    fail("UNSAFE_URL");
  return u.origin;
}
export async function selectOfferedProfile(client, providerId, profileIndex) {
  const offer = (await client.listOffers()).offers.find(
    (o) => o.payload.providerId === providerId,
  )?.payload;
  if (!offer) fail("PROVIDER_OFFER_UNAVAILABLE");
  if (profileIndex === undefined) {
    if (offer.profileIds.length !== 1) fail("PROFILE_SELECTION_REQUIRED");
    profileIndex = 0;
  }
  if (
    !Number.isSafeInteger(profileIndex) ||
    profileIndex < 0 ||
    profileIndex >= offer.profileIds.length
  )
    fail("INVALID_PROFILE_SELECTION");
  return offer.profileIds[profileIndex];
}
export async function createRequest(fields) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const request = {
    version: "1",
    nonce,
    sampling: "greedy",
    publishConsent: false,
    ...fields,
  };
  dto("Request", request);
  return request;
}
export async function verifyReceiptIntegrity(receipt, publicKeyJwk) {
  dto("SignedReceipt", receipt);
  if (
    !publicKeyJwk ||
    publicKeyJwk.kty !== "OKP" ||
    publicKeyJwk.crv !== "Ed25519" ||
    publicKeyJwk.d ||
    typeof publicKeyJwk.x !== "string"
  )
    fail("INVALID_PUBLIC_KEY");
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const prefix = new TextEncoder().encode("ethonline:receipt:v1\n"),
      body = await canonicalBytes(receipt.payload),
      data = new Uint8Array(prefix.length + body.length);
    data.set(prefix);
    data.set(body, prefix.length);
    const signature = Uint8Array.from(
      atob(receipt.signature.replace(/-/g, "+").replace(/_/g, "/") + "=="),
      (c) => c.charCodeAt(0),
    );
    return {
      integrity: await crypto.subtle.verify("Ed25519", key, signature, data),
      executionVerified: false,
    };
  } catch {
    fail("INVALID_SIGNATURE");
  }
}
export async function validateEvidence(
  bundle,
  { publicKeyJwk, providerId, keyId, expected } = {},
) {
  exact(bundle, [
    "version",
    "mode",
    "receipt",
    "request",
    "profile",
    "output",
    "assessments",
  ]);
  if (
    bundle.version !== "1" ||
    !["development", "live"].includes(bundle.mode) ||
    !Array.isArray(bundle.assessments) ||
    bundle.assessments.length > 1024
  )
    fail("INVALID_EVIDENCE");
  for (const [k, s] of [
    ["receipt", "SignedReceipt"],
    ["request", "Request"],
    ["profile", "Profile"],
    ["output", "Output"],
  ])
    dto(s, bundle[k], true);
  const p = bundle.receipt.payload,
    rd = await digestOf(bundle.receipt);
  if (
    p.requestHash !== (await digestOf(bundle.request)) ||
    p.profileId !== (await digestOf(bundle.profile)) ||
    p.outputHash !== (await digestOf(bundle.output)) ||
    p.profileId !== bundle.request.profileId ||
    p.providerId !== bundle.request.providerId ||
    p.mode !== bundle.mode ||
    bundle.output.tokenIds.length > bundle.request.maxOutputTokens ||
    (providerId && providerId !== p.providerId) ||
    (keyId && keyId !== bundle.receipt.keyId)
  )
    fail("EVIDENCE_MISMATCH");
  for (const a of bundle.assessments) {
    dto("Assessment", a, true);
    if (
      a.receiptDigest !== rd ||
      a.profileId !== p.profileId ||
      a.mode !== p.mode
    )
      fail("EVIDENCE_MISMATCH");
  }
  if (!publicKeyJwk) fail("KEY_PIN_REQUIRED");
  if (!(await verifyReceiptIntegrity(bundle.receipt, publicKeyJwk)).integrity)
    fail("INVALID_SIGNATURE");
  if (expected !== undefined) {
    if (
      !expected ||
      Object.keys(expected).some(
        (k) =>
          ![
            "request",
            "chat",
            "providerId",
            "profileId",
            "jobId",
            "quoteId",
            "paymentId",
            "output",
          ].includes(k),
      ) ||
      Boolean(expected.request) === Boolean(expected.chat) ||
      ![expected.jobId, expected.quoteId, expected.paymentId].every(id)
    )
      fail("INVALID_BUYER_EXPECTATION");
    let expectedHash;
    if (expected.request) {
      dto("Request", expected.request);
      expectedHash = await digestOf(expected.request);
    } else {
      const chat = expected.chat,
        message = chat.messages?.[0];
      if (
        !id(expected.providerId) ||
        !id(expected.profileId) ||
        Object.keys(chat).some(
          (k) => !["model", "messages", "max_tokens", "stream"].includes(k),
        ) ||
        !Array.isArray(chat.messages) ||
        chat.messages.length !== 1 ||
        !message ||
        Object.keys(message).sort().join(",") !== "content,role" ||
        message.role !== "user" ||
        typeof message.content !== "string" ||
        !message.content.isWellFormed() ||
        (chat.stream !== undefined && typeof chat.stream !== "boolean")
      )
        fail("INVALID_BUYER_EXPECTATION");
      const model =
        "mycelium-" +
        (
          await digestOf({
            providerId: expected.providerId,
            profileId: expected.profileId,
            chat: "single-user-v1",
          })
        ).slice(7);
      if (
        chat.model !== model ||
        expected.providerId !== p.providerId ||
        expected.profileId !== p.profileId ||
        message.content !== bundle.request.prompt ||
        chat.max_tokens !== bundle.request.maxOutputTokens ||
        bundle.request.seed !== 0 ||
        bundle.request.sampling !== "greedy" ||
        bundle.request.publishConsent !== false
      )
        fail("BUYER_EXPECTATION_MISMATCH");
      expectedHash = p.requestHash; // Nonce is server-generated; caller binds original chat semantics above.
    }
    if (expected.output !== undefined) dto("Output", expected.output);
    if (
      expectedHash !== p.requestHash ||
      expected.jobId !== p.jobId ||
      expected.quoteId !== p.quoteId ||
      expected.paymentId !== p.paymentId ||
      (expected.output !== undefined &&
        (await digestOf(expected.output)) !== p.outputHash)
    )
      fail("BUYER_EXPECTATION_MISMATCH");
  }
  return bundle;
}
/** Offline JSON only: no archive extraction, URL fetch or inference claim. */
export async function checkBuyerEvidenceJson(text, pins, expected) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > 2097152
  )
    fail("EVIDENCE_SIZE_LIMIT");
  if (!expected) fail("INVALID_BUYER_EXPECTATION");
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    fail("INVALID_EVIDENCE_JSON");
  }
  await validateEvidence(bundle, { ...pins, expected });
  return {
    integrity: true,
    originalRequestBound: true,
    completeOutputBound: expected.output !== undefined,
    executionVerified: false,
    financialProtection: false,
  };
}
// Only an explicit loopback DEVELOPMENT test adapter. Encoded with pinned x402 SDK.
export async function developmentAuthorizer(context) {
  const { quote, baseUrl, headers } = context;
  const url = new URL(safeBaseUrl(baseUrl));
  if (
    quote.mode !== "development" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    fail("DEVELOPMENT_ONLY");
  const challenge = decodePaymentRequiredHeader(headers["payment-required"]);
  return {
    "payment-signature": encodePaymentSignatureHeader({
      x402Version: 2,
      resource: challenge.resource,
      accepted: challenge.accepts[0],
      payload: { developmentConformance: true },
    }),
  };
}
function budgetCheck(quote, authorization) {
  if (
    !authorization ||
    !amount(authorization.maxAmountBaseUnits) ||
    !id(authorization.asset) ||
    !id(authorization.network)
  )
    fail("EXPLICIT_BOUNDED_AUTHORIZATION_REQUIRED");
  if (BigInt(quote.amountBaseUnits) > BigInt(authorization.maxAmountBaseUnits))
    fail("BUDGET_EXCEEDED");
  if (
    quote.asset !== authorization.asset ||
    quote.network !== authorization.network
  )
    fail("ASSET_NETWORK_MISMATCH");
  if (Date.parse(quote.expiresAt) <= Date.now()) fail("QUOTE_EXPIRED");
}
export function createClient({
  baseUrl,
  fetch: transport = globalThis.fetch,
  capability: initialCapability,
  paymentAuthorizer,
  retries = 2,
  retryBaseMs = 25,
  timeoutMs = 15000,
  pins,
} = {}) {
  const base = safeBaseUrl(baseUrl);
  if (
    !Number.isInteger(retries) ||
    retries < 0 ||
    retries > 3 ||
    !Number.isInteger(retryBaseMs) ||
    retryBaseMs < 0 ||
    retryBaseMs > 1000 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000
  )
    fail("INVALID_CONFIG");
  let capability = initialCapability;
  const quotes = new Map(),
    knownJobs = new Map(),
    attempts = new Map();
  async function retainBuyerOutput(known, job) {
    const expected = known?.expected;
    if (!expected) return;
    if (
      job.payment &&
      (job.payment.quoteId !== expected.quoteId ||
        job.payment.paymentId !== expected.paymentId)
    )
      fail("JOB_MISMATCH");
    if (job.output) {
      if (
        expected.output &&
        (await digestOf(expected.output)) !== (await digestOf(job.output))
      )
        fail("BUYER_EXPECTATION_MISMATCH");
      expected.output ??= jsonClone(job.output);
    }
  }
  function auth() {
    if (!id(capability)) fail("AUTH_REQUIRED");
    return { authorization: `Bearer ${capability}` };
  }
  function scope(options = {}) {
    const ms = options.timeoutMs ?? timeoutMs;
    if (!Number.isInteger(ms) || ms < 1 || ms > 120000) fail("INVALID_INPUT");
    const controller = new AbortController();
    let timedOut = false;
    const aborted = () => controller.abort();
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    return {
      signal: controller.signal,
      close() {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
      },
      translate(e) {
        if (options.signal?.aborted)
          return new DOMException("Aborted", "AbortError");
        if (timedOut) return new AccessError("TIMEOUT");
        if (e instanceof AccessError) return e;
        return new AccessError("NETWORK_ERROR", 0, true);
      },
    };
  }
  async function sleep(ms, signal) {
    await new Promise((resolve, reject) => {
      const end = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        end();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        end();
        resolve();
      }, ms);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function boundedText(response, signal, limit = 2097152) {
    if (Number(response.headers.get("content-length")) > limit)
      fail("RESPONSE_TOO_LARGE");
    if (!response.body) fail("INVALID_RESPONSE");
    const reader = response.body.getReader();
    let size = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) fail("RESPONSE_TOO_LARGE");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function wire(
    path,
    { method = "GET", body, headers = {}, privateRoute = false, signal } = {},
  ) {
    return transport(base + path, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(privateRoute ? auth() : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
  }
  async function request(
    path,
    {
      method = "GET",
      body,
      headers,
      privateRoute = false,
      success = 200,
      options = {},
      allow402 = false,
    } = {},
  ) {
    const guard = scope(options);
    try {
      for (let n = 0; ; n++) {
        let response;
        try {
          response = await wire(path, {
            method,
            body,
            headers,
            privateRoute,
            signal: guard.signal,
          });
        } catch (e) {
          if (guard.signal.aborted || method !== "GET" || n >= retries) throw e;
          await sleep(retryBaseMs * (n + 1), guard.signal);
          continue;
        }
        if (response.status === 429 && method === "GET" && n < retries) {
          const raw = response.headers.get("retry-after");
          const delay =
            raw && /^\d+$/.test(raw)
              ? Number(raw) * 1000
              : raw
                ? Date.parse(raw) - Date.now()
                : retryBaseMs * (n + 1);
          await response.body?.cancel();
          if (!Number.isFinite(delay) || delay > 2000)
            fail("RATE_LIMITED", 429);
          await sleep(Math.max(0, delay), guard.signal);
          continue;
        }
        if (response.status === 204 && success === 204) {
          await response.body?.cancel();
          return;
        }
        if (
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json")
        )
          fail("INVALID_RESPONSE");
        let data;
        try {
          data = JSON.parse(
            await boundedText(
              response,
              guard.signal,
              response.status === 402 ? 65536 : 2097152,
            ),
          );
        } catch (e) {
          if (e instanceof AccessError || guard.signal.aborted) throw e;
          fail("INVALID_RESPONSE");
        }
        if (response.status === 402 && allow402)
          return {
            challenge: data,
            headers: Object.fromEntries(
              [...response.headers].filter(([k]) =>
                ["payment-required", "payment-response"].includes(k),
              ),
            ),
            status: 402,
          };
        if (response.status !== success) {
          dto("Error", data, true);
          if (response.status === 401) {
            capability = undefined;
            quotes.clear();
          }
          throw new AccessError(
            data.error.code,
            response.status,
            data.error.retryable,
          );
        }
        return data;
      }
    } catch (e) {
      throw guard.translate(e);
    } finally {
      guard.close();
    }
  }
  const client = {
    get capability() {
      return capability;
    },
    async connect(options) {
      if (capability) fail("ALREADY_CONNECTED");
      const d = await request("/v1/sessions", {
        method: "POST",
        body: {},
        success: 201,
        options,
      });
      exact(d, ["capability", "expiresAt"]);
      if (
        !id(d.capability) ||
        d.capability.length < 43 ||
        !Number.isFinite(Date.parse(d.expiresAt)) ||
        Date.parse(d.expiresAt) <= Date.now()
      )
        fail("INVALID_RESPONSE");
      capability = d.capability;
      quotes.clear();
      attempts.clear();
      return d;
    },
    async revoke(options) {
      await request("/v1/sessions/revoke", {
        method: "POST",
        body: {},
        privateRoute: true,
        success: 204,
        options,
      });
      capability = undefined;
      quotes.clear();
      attempts.clear();
    },
    async health(options) {
      const d = await request("/healthz", { options });
      exact(d, ["status", "mode"]);
      if (d.status !== "ok" || !["development", "live"].includes(d.mode))
        fail("INVALID_RESPONSE");
      return d;
    },
    async getProfile(profileId, options) {
      const d = dto(
        "Profile",
        await request("/v1/profiles/" + enc(profileId), { options }),
        true,
      );
      if ((await digestOf(d)) !== profileId) fail("PROFILE_MISMATCH");
      return d;
    },
    async listOffers(options) {
      if (!pins?.providerId || !pins.keyId || !pins.publicKeyJwk)
        fail("KEY_PIN_REQUIRED");
      const d = await request("/v2/offers", { options });
      exact(d, ["version", "offers"]);
      if (d.version !== "2" || !Array.isArray(d.offers) || d.offers.length > 8)
        fail("INVALID_RESPONSE");
      const matching = [];
      for (const o of d.offers) {
        try {
          validateSignedOffer(o);
        } catch {
          fail("INVALID_SIGNED_OFFER");
        }
        if (o.payload.providerId !== pins.providerId) continue;
        if (
          o.keyId !== pins.keyId ||
          o.payload.endpoint !== base ||
          Date.parse(o.payload.expiresAt) <= Date.now() ||
          Date.parse(o.payload.issuedAt) > Date.now() + 5000
        )
          fail("OFFER_PIN_OR_EXPIRY_MISMATCH");
        try {
          if (pins.publicKeyJwk.d) throw Error();
          const key = await crypto.subtle.importKey(
            "jwk",
            pins.publicKeyJwk,
            "Ed25519",
            false,
            ["verify"],
          );
          const sig = Uint8Array.from(
            atob(o.signature.replace(/-/g, "+").replace(/_/g, "/") + "=="),
            (c) => c.charCodeAt(0),
          );
          if (
            !(await crypto.subtle.verify(
              "Ed25519",
              key,
              sig,
              new TextEncoder().encode(offerSigningText(o.payload)),
            ))
          )
            throw Error();
        } catch {
          fail("INVALID_OFFER_SIGNATURE");
        }
        matching.push(jsonClone(o));
      }
      if (matching.length !== 1) fail("PROVIDER_OFFER_UNAVAILABLE");
      return { version: "2", offers: matching };
    },
    async listProviders(names, options) {
      if (
        !Array.isArray(names) ||
        names.length > 32 ||
        names.some((n) => !id(n))
      )
        fail("INVALID_INPUT");
      const d = await request(
        "/v1/providers?" + new URLSearchParams(names.map((n) => ["name", n])),
        { options },
      );
      exact(d, ["providers", "errors"]);
      if (
        !Array.isArray(d.providers) ||
        d.providers.length > 128 ||
        !Array.isArray(d.errors) ||
        d.errors.length > 128
      )
        fail("INVALID_RESPONSE");
      d.providers.forEach((p) => dto("Provider", p, true));
      d.errors.forEach((e) => {
        exact(e, ["name", "code"]);
        if (!id(e.name) || !id(e.code)) fail("INVALID_RESPONSE");
      });
      return d;
    },
    async selectProviders(proposal, options) {
      exact(proposal, [
        "providers",
        "quotes",
        "profileId",
        "maxAmountBaseUnits",
        "network",
        "asset",
      ]);
      if (
        !Array.isArray(proposal.providers) ||
        proposal.providers.length > 128 ||
        !Array.isArray(proposal.quotes) ||
        proposal.quotes.length > 128 ||
        !amount(proposal.maxAmountBaseUnits) ||
        !/^sha256:[0-9a-f]{64}$/.test(proposal.profileId) ||
        !id(proposal.network) ||
        !id(proposal.asset)
      )
        fail("INVALID_INPUT");
      proposal.providers.forEach((p) => dto("Provider", p));
      proposal.quotes.forEach((q) => dto("Quote", q));
      const d = await request("/v1/providers/select", {
        method: "POST",
        body: proposal,
        privateRoute: true,
        options,
      });
      exact(d, ["selected", "reasons"]);
      if (d.selected !== null) dto("Provider", d.selected, true);
      if (!Array.isArray(d.reasons) || d.reasons.length > 128)
        fail("INVALID_RESPONSE");
      d.reasons.forEach((r) => {
        exact(r, ["providerId", "eligible", "codes"]);
        if (
          !id(r.providerId) ||
          typeof r.eligible !== "boolean" ||
          !Array.isArray(r.codes) ||
          r.codes.length > 128 ||
          r.codes.some((c) => !id(c))
        )
          fail("INVALID_RESPONSE");
      });
      return d;
    },
    async createQuote(input, options) {
      dto("Request", input);
      const q = dto(
        "Quote",
        await request("/v1/quotes", {
          method: "POST",
          body: { request: input },
          privateRoute: true,
          success: 201,
          options,
        }),
        true,
      );
      if (
        q.requestHash !== (await digestOf(input)) ||
        q.profileId !== input.profileId ||
        q.providerId !== input.providerId
      )
        fail("QUOTE_MISMATCH");
      if (quotes.size >= 128) quotes.delete(quotes.keys().next().value);
      quotes.set(q.quoteId, jsonClone(q));
      return q;
    },
    // Import a previously retained quote (CLI across processes); core remains authoritative.
    rememberQuote(q) {
      dto("Quote", q);
      if (quotes.size >= 128) fail("CLIENT_LIMIT");
      quotes.set(q.quoteId, jsonClone(q));
    },
    async submitJob(
      { request: input, quoteId, idempotencyKey, authorization },
      options = {},
    ) {
      dto("Request", input);
      enc(quoteId);
      enc(idempotencyKey);
      auth();
      const q = quotes.get(quoteId);
      if (!q) fail("QUOTE_REQUIRED");
      budgetCheck(q, authorization);
      const snapshot = jsonClone(input),
        budget = jsonClone(authorization),
        body = { request: snapshot, quoteId };
      if (
        q.requestHash !== (await digestOf(snapshot)) ||
        q.providerId !== snapshot.providerId ||
        q.profileId !== snapshot.profileId
      )
        fail("QUOTE_MISMATCH");
      const previous = attempts.get(idempotencyKey);
      if (previous?.busy) fail("SUBMISSION_IN_PROGRESS");
      if (previous?.uncertain) fail("SUBMISSION_UNCERTAIN");
      if (attempts.size >= 128 && !previous) fail("CLIENT_LIMIT");
      const state = { busy: true, uncertain: false };
      attempts.set(idempotencyKey, state);
      try {
        let d = await request("/v1/jobs", {
          method: "POST",
          body,
          privateRoute: true,
          headers: { "idempotency-key": idempotencyKey },
          success: 202,
          allow402: true,
          options,
        });
        if (d.status === 402) {
          if (typeof paymentAuthorizer !== "function")
            fail("PAYMENT_AUTHORIZER_REQUIRED", 402);
          if (previous?.authorized)
            fail("PAYMENT_REAUTHORIZATION_REQUIRED", 402);
          let challenge;
          try {
            challenge = decodePaymentRequiredHeader(
              d.headers["payment-required"],
            );
          } catch {
            fail("INVALID_PAYMENT_CHALLENGE");
          }
          if (
            challenge.x402Version !== 2 ||
            !Array.isArray(challenge.accepts) ||
            challenge.accepts.length !== 1 ||
            !new Set([
              base + "/v1/jobs",
              base + "/v1/jobs/quotes/" + encodeURIComponent(q.quoteId),
            ]).has(challenge.resource?.url)
          )
            fail("INVALID_PAYMENT_CHALLENGE");
          const a = challenge.accepts[0];
          if (
            a.amount !== q.amountBaseUnits ||
            a.asset !== q.asset ||
            a.network !== q.network ||
            a.payTo !== q.receiver ||
            a.scheme !== "exact" ||
            !Number.isSafeInteger(a.maxTimeoutSeconds) ||
            a.maxTimeoutSeconds <= 0 ||
            a.maxTimeoutSeconds > 3600
          )
            fail("PAYMENT_CHALLENGE_MISMATCH");
          budgetCheck(q, budget);
          const guard = scope(options);
          let h;
          try {
            h = await Promise.race([
              Promise.resolve().then(() =>
                paymentAuthorizer({
                  status: 402,
                  body: d.challenge,
                  headers: d.headers,
                  quote: jsonClone(q),
                  request: jsonClone(snapshot),
                  budget,
                  baseUrl: base,
                  idempotencyKey,
                  signal: guard.signal,
                }),
              ),
              new Promise((_, reject) => {
                if (guard.signal.aborted)
                  reject(new DOMException("Aborted", "AbortError"));
                else
                  guard.signal.addEventListener(
                    "abort",
                    () => reject(new DOMException("Aborted", "AbortError")),
                    { once: true },
                  );
              }),
            ]);
          } catch (e) {
            state.uncertain = true;
            throw guard.translate(e);
          } finally {
            guard.close();
          }
          // The callback may already have spent, even when its output is invalid.
          state.authorized = true;
          if (
            !h ||
            Object.keys(h).length !== 1 ||
            typeof h["payment-signature"] !== "string" ||
            h["payment-signature"].length > 16384 ||
            /[\r\n]/.test(h["payment-signature"])
          )
            fail("INVALID_PAYMENT_HEADERS");
          budgetCheck(q, budget);
          d = await request("/v1/jobs", {
            method: "POST",
            body,
            privateRoute: true,
            headers: { "idempotency-key": idempotencyKey, ...h },
            success: 202,
            options,
          });
        }
        exact(d, ["job", "capability"]);
        dto("Job", d.job, true);
        if (
          !id(d.capability) ||
          d.capability.length < 43 ||
          d.job.requestHash !== q.requestHash ||
          d.job.mode !== q.mode ||
          !d.job.payment ||
          d.job.payment.quoteId !== q.quoteId ||
          d.job.payment.mode !== q.mode ||
          d.job.payment.requestHash !== q.requestHash
        )
          fail("JOB_MISMATCH");
        knownJobs.set(d.job.jobId, {
          requestHash: q.requestHash,
          mode: q.mode,
          expected: {
            request: jsonClone(input),
            jobId: d.job.jobId,
            quoteId: q.quoteId,
            paymentId: d.job.payment.paymentId,
          },
        });
        return d;
      } catch (e) {
        if (state.authorized) state.uncertain = true;
        throw e;
      } finally {
        state.busy = false;
      }
    },
    async getJob(jobId, options) {
      const d = dto(
        "Job",
        await request("/v1/jobs/" + enc(jobId), {
          privateRoute: true,
          options,
        }),
        true,
      );
      if (d.jobId !== jobId) fail("JOB_MISMATCH");
      const expected = knownJobs.get(jobId);
      if (expected?.expected && !expected.requestHash) {
        expected.requestHash = await digestOf(expected.expected.request);
        expected.mode = d.mode;
      }
      if (
        expected?.expected &&
        (d.payment?.quoteId !== expected.expected.quoteId ||
          d.payment?.paymentId !== expected.expected.paymentId)
      )
        fail("JOB_MISMATCH");
      if (
        expected &&
        (expected.requestHash !== d.requestHash || expected.mode !== d.mode)
      )
        fail("JOB_MISMATCH");
      if (
        d.payment &&
        (d.payment.mode !== d.mode || d.payment.requestHash !== d.requestHash)
      )
        fail("JOB_MISMATCH");
      await retainBuyerOutput(expected, d);
      return d;
    },
    async cancelJob(jobId, options) {
      const d = dto(
        "Job",
        await request("/v1/jobs/" + enc(jobId) + "/cancel", {
          method: "POST",
          body: {},
          privateRoute: true,
          options,
        }),
        true,
      );
      if (d.jobId !== jobId) fail("JOB_MISMATCH");
      return d;
    },
    async getReceipt(jobId, options) {
      const d = dto(
        "SignedReceipt",
        await request("/v1/jobs/" + enc(jobId) + "/receipt", {
          privateRoute: true,
          options,
        }),
        true,
      );
      if (d.payload.jobId !== jobId) fail("RECEIPT_MISMATCH");
      return d;
    },
    async getKey(keyId, options) {
      const d = await request("/v1/keys/" + enc(keyId), { options });
      exact(d, ["keyId", "algorithm", "publicKeyJwk"]);
      if (
        d.keyId !== keyId ||
        d.algorithm !== "Ed25519" ||
        d.publicKeyJwk?.d ||
        d.publicKeyJwk?.crv !== "Ed25519" ||
        d.publicKeyJwk?.kty !== "OKP" ||
        typeof d.publicKeyJwk.x !== "string"
      )
        fail("INVALID_PUBLIC_KEY");
      return d;
    },
    // Clients contain private authority in memory, never in a JSON export.
    toJSON() {
      return { type: "PrivateAccessClient", connected: !!capability };
    },
    async exportRecovery(
      { request: input, quote, idempotencyKey, passphrase },
      options,
    ) {
      dto("Request", input);
      dto("Quote", quote);
      enc(idempotencyKey);
      auth();
      return exportRecovery({
        base,
        pins,
        request: jsonClone(input),
        quote: jsonClone(quote),
        idempotencyKey,
        passphrase,
        register: (body) =>
          request("/v2/recoveries", {
            method: "POST",
            body,
            privateRoute: true,
            success: 201,
            options,
          }),
      });
    },
    async importRecovery(archive, passphrase, options) {
      const {
        result,
        attempt,
        pins: originalPins,
      } = await proveRecovery({
        base,
        archive,
        passphrase,
        post: (path, body, success) =>
          request(path, { method: "POST", body, success, options }),
      });
      if (
        result?.version !== "2" ||
        !["unresolved", "accepted"].includes(result.status)
      )
        fail("INVALID_RESPONSE");
      if (result.status === "unresolved") {
        exact(result, ["version", "status"]);
        return { status: "unresolved", attempt, pins: originalPins };
      }
      validateRecovered(result, attempt.request, attempt.quote);
      const child = createClient({
        baseUrl: base,
        capability: result.capability,
        pins: originalPins,
        fetch: transport,
        timeoutMs,
      });
      child.rememberBuyerContext({
        request: attempt.request,
        jobId: result.job.jobId,
        quoteId: attempt.quote.quoteId,
        paymentId: result.job.payment.paymentId,
      });
      const job = await child.getJob(result.job.jobId, options);
      return {
        status: "accepted",
        job,
        client: child,
        attempt,
        pins: originalPins,
      };
    },
    async revokeRecovery(archive, passphrase, options) {
      const { result } = await proveRecovery({
        base,
        archive,
        passphrase,
        action: "revoke",
        post: (path, body, success) =>
          request(path, { method: "POST", body, success, options }),
      });
      exact(result, ["version", "status"]);
      if (result.version !== "2" || result.status !== "revoked")
        fail("INVALID_RESPONSE");
      return result;
    },
    async reconcileAttempt(
      { request: input, quote, quoteId = quote?.quoteId, idempotencyKey },
      options,
    ) {
      dto("Request", input);
      dto("Quote", quote);
      enc(idempotencyKey);
      auth();
      if (quoteId !== quote.quoteId) fail("QUOTE_MISMATCH");
      const result = await request("/v2/attempts/reconcile", {
        method: "POST",
        body: { request: input, quoteId, idempotencyKey },
        privateRoute: true,
        options,
      });
      if (
        result?.version !== "2" ||
        !["unresolved", "accepted"].includes(result.status)
      )
        fail("INVALID_RESPONSE");
      if (result.status === "unresolved") {
        exact(result, ["version", "status"]);
        return result;
      }
      validateRecovered(result, input, quote);
      if (quote.requestHash !== (await digestOf(input))) fail("QUOTE_MISMATCH");
      knownJobs.set(result.job.jobId, {
        requestHash: quote.requestHash,
        mode: quote.mode,
        expected: {
          request: jsonClone(input),
          jobId: result.job.jobId,
          quoteId,
          paymentId: result.job.payment.paymentId,
        },
      });
      attempts.set(idempotencyKey, {
        busy: false,
        uncertain: false,
        accepted: true,
      });
      return result;
    },
    rememberBuyerContext(value) {
      exact(value, ["request", "jobId", "quoteId", "paymentId"]);
      dto("Request", value.request);
      enc(value.jobId);
      enc(value.quoteId);
      enc(value.paymentId);
      if (knownJobs.has(value.jobId)) fail("BUYER_CONTEXT_ALREADY_BOUND");
      if (knownJobs.size >= 128) fail("CLIENT_LIMIT");
      // The original immutable request is caller-retained, not fetched from the provider.
      knownJobs.set(value.jobId, { expected: jsonClone(value) });
    },
    getBuyerExpectation(jobId) {
      const e = knownJobs.get(jobId)?.expected;
      if (!e) fail("BUYER_EXPECTATION_UNAVAILABLE");
      return jsonClone(e);
    },
    async getEvidence(jobId, options) {
      const b = await request("/v1/jobs/" + enc(jobId) + "/evidence", {
        privateRoute: true,
        options,
      });
      if (b.receipt?.payload?.jobId !== jobId) fail("EVIDENCE_MISMATCH");
      if (!pins?.publicKeyJwk || !pins.providerId || !pins.keyId)
        fail("KEY_PIN_REQUIRED");
      return validateEvidence(b, {
        ...pins,
        expected: options?.expected ?? knownJobs.get(jobId)?.expected,
      });
    },
    async deleteEvidence(jobId, options) {
      return request("/v1/jobs/" + enc(jobId) + "/evidence", {
        method: "DELETE",
        privateRoute: true,
        success: 204,
        options,
      });
    },
    async createAssessment(jobId, method, idempotencyKey, options) {
      enc(method);
      enc(idempotencyKey);
      return dto(
        "Assessment",
        await request("/v1/jobs/" + enc(jobId) + "/assessments", {
          method: "POST",
          body: { method },
          headers: { "idempotency-key": idempotencyKey },
          privateRoute: true,
          success: 202,
          options,
        }),
        true,
      );
    },
    async getPublication(jobId, options) {
      const value = dto(
        "PublicationState",
        await request("/v1/jobs/" + enc(jobId) + "/publication", {
          privateRoute: true,
          options,
        }),
        true,
      );
      if (value.jobId !== jobId) fail("JOB_MISMATCH");
      return value;
    },
    async listAssessments(jobId, options) {
      const d = await request("/v1/jobs/" + enc(jobId) + "/assessments", {
        privateRoute: true,
        options,
      });
      exact(d, ["assessments"]);
      if (!Array.isArray(d.assessments) || d.assessments.length > 1024)
        fail("INVALID_RESPONSE");
      return d.assessments.map((a) => dto("Assessment", a, true));
    },
    async getHistory(providerId, options) {
      const d = dto(
        "History",
        await request("/v1/providers/" + enc(providerId) + "/history", {
          options,
        }),
        true,
      );
      if (
        d.providerId !== providerId ||
        d.observations.some((a) => a.mode !== d.mode)
      )
        fail("HISTORY_MISMATCH");
      return d;
    },
    async *streamJob(jobId, options = {}) {
      const guard = scope({
        ...options,
        timeoutMs: options.timeoutMs ?? 120000,
      });
      let cursor = options.lastEventId ?? 0,
        finalJob = false,
        totalText = 0,
        totalTokens = 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail("INVALID_CURSOR");
      try {
        for (let attempt = 0; attempt <= retries; attempt++) {
          let reader;
          try {
            const response = await wire("/v1/jobs/" + enc(jobId) + "/events", {
              privateRoute: true,
              signal: guard.signal,
              headers: {
                accept: "text/event-stream",
                ...(cursor ? { "last-event-id": String(cursor) } : {}),
              },
            });
            if (response.status !== 200) {
              let d;
              try {
                d = JSON.parse(
                  await boundedText(response, guard.signal, 65536),
                );
              } catch {
                fail("INVALID_RESPONSE");
              }
              dto("Error", d, true);
              throw new AccessError(
                d.error.code,
                response.status,
                d.error.retryable,
              );
            }
            if (
              !response.headers
                .get("content-type")
                ?.startsWith("text/event-stream") ||
              !response.body
            )
              fail("INVALID_RESPONSE");
            reader = response.body.getReader();
            let buffer = "";
            const decoder = new TextDecoder("utf-8", { fatal: true });
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              if (buffer.length > 2097152) fail("SSE_BOUNDS");
              let match;
              while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const block = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                const fields = {};
                const data = [];
                for (const line of block.split(/\r?\n/)) {
                  if (line.startsWith(":")) continue;
                  const i = line.indexOf(":");
                  if (i < 0) continue;
                  const key = line.slice(0, i),
                    value = line.slice(i + 1).replace(/^ /, "");
                  if (key === "data") data.push(value);
                  else if (["id", "event"].includes(key)) fields[key] = value;
                }
                if (!data.length) continue;
                const n = Number(fields.id);
                if (
                  !/^\d+$/.test(fields.id || "") ||
                  !Number.isSafeInteger(n) ||
                  n < 1
                )
                  fail("INVALID_SSE");
                if (n <= cursor) continue;
                let d;
                try {
                  d = JSON.parse(data.join("\n"));
                } catch {
                  fail("INVALID_SSE");
                }
                const event = fields.event;
                if (event === "job") {
                  dto("Job", d, true);
                  if (d.jobId !== jobId) fail("JOB_MISMATCH");
                  const expected = knownJobs.get(jobId);
                  if (
                    expected &&
                    (d.requestHash !== expected.requestHash ||
                      d.mode !== expected.mode)
                  )
                    fail("JOB_MISMATCH");
                  if (
                    d.payment &&
                    (d.payment.mode !== d.mode ||
                      d.payment.requestHash !== d.requestHash)
                  )
                    fail("JOB_MISMATCH");
                  await retainBuyerOutput(expected, d);
                  finalJob = ["succeeded", "failed", "cancelled"].includes(
                    d.executionStatus,
                  );
                } else if (event === "delta") {
                  exact(d, ["text", "tokenIds"]);
                  dto("Output", { ...d, finishReason: "stop" }, true);
                  totalText += d.text.length;
                  totalTokens += d.tokenIds.length;
                  if (totalText > 1048576 || totalTokens > 4096)
                    fail("SSE_BOUNDS");
                } else if (event === "assessment") dto("Assessment", d, true);
                else if (event === "error") {
                  dto("Error", d, true);
                  throw new AccessError(d.error.code, 0, d.error.retryable);
                } else if (event === "done") {
                  exact(d, ["jobId"]);
                  if (d.jobId !== jobId || !finalJob) fail("INVALID_SSE");
                } else fail("INVALID_SSE");
                cursor = n;
                yield { id: n, event, data: d };
                if (event === "done") return;
              }
            }
          } catch (e) {
            if (e instanceof AccessError || guard.signal.aborted) throw e;
          } finally {
            if (reader) {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          if (attempt === retries) fail("SSE_INTERRUPTED");
          await sleep(retryBaseMs * (attempt + 1), guard.signal);
        }
      } catch (e) {
        throw guard.translate(e);
      } finally {
        guard.close();
      }
    },
    async runDevelopmentJob(
      { request: input, idempotencyKey, authorization },
      options,
    ) {
      const quote = await client.createQuote(input, options);
      if (quote.mode !== "development") fail("DEVELOPMENT_ONLY");
      return client.submitJob(
        {
          request: input,
          quoteId: quote.quoteId,
          idempotencyKey,
          authorization,
        },
        options,
      );
    },
  };
  return client;
}
