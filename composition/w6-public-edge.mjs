// Loopback-only edge adapter for the explicitly selected public demo origin.
// Native gateway and its bearer are never reachable through this listener.
// P2: this is now the single edge. It carries the paid-upstream selection
// from scripts/w6-paid-edge.mjs (which is retired): when the paid app on 4352
// is healthy it takes precedence for /v1/* API traffic; otherwise the
// non-economic app on 4350 serves everything. The route allowlist and the
// public-app gate are preserved fail-closed.
//
// W6 v3 ENSv2 frontend provenance: the edge answers /v2/ens-discovery
// locally using the composition/w6-ens-discovery-http.mjs service. This is
// a read-only provenance surface (not a closed Provider DTO), and it is
// independent of the signed-offer gate that /v1/providers runs. The browser
// hits /v2/ens-discovery to render the "Resolved via ENSv2 · Sepolia" badge
// and the expandable detail, then uses /v1/providers for the closed
// selection-gated DTO used in the quote/inference journey.
//
// Phase R (rate limits + view cache hardening):
//   * Every public GET is charged against a bounded per-IP + per-route-class
//     token bucket (composition/w6-rate-limit.mjs) before it can reach the
//     paid app, the subgraph, the RPC or the trust-card sidecar. Rejections
//     are HTTP 429 with a Retry-After derived from the actual bucket.
//   * Upstream 429 bodies are read (bounded, JSON only, 64 KiB cap) so an
//     exact `retryAfterMs` is preserved and forwarded instead of the generic
//     60s. The demo sponsor's precise windows — DEMO_QUEUE_FULL => 1s and
//     DEMO_RATE_LIMITED => its configured session/IP refill from the
//     supervisor env — win over the upstream's generic Retry-After: 60.
//   * /v2/providers/stats answers a rate-limited caller from its retained view
//     cache (stale + Retry-After) instead of erroring, and never re-queries
//     the subgraph to do so.
//
// The module is import-safe: it exports createPublicEdgeServer() for tests and
// only binds port 4351 (or W6_EDGE_PORT) when executed directly.
import { createServer, request } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadProvidersFromEns,
  DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
} from "./w6-ens-discovery-loader.mjs";
import {
  tryHandleProviderStatsRoute,
  tryServeRateLimitedStaleProviderStats,
} from "./w6-provider-stats-endpoint.mjs";
import { RECORD_KEYS } from "../packages/discovery/src/index.mjs";
import {
  PUBLIC_GET_LIMITS,
  RATE_LIMIT_BODY_MAX_BYTES,
  classifyPublicGet,
  clientKey,
  createPublicGetLimiter,
  deriveUpstreamRetryAfterMs,
  readDemoSponsorRefillConfig,
  retryAfterSecondsFromMs,
  send429,
} from "./w6-rate-limit.mjs";

const DEFAULT_RUNTIME_ROOT =
  "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z";
const DEFAULT_PAID_UPSTREAM = "http://127.0.0.1:4352";
const DEFAULT_NON_ECONOMIC_UPSTREAM = "http://127.0.0.1:4350";
const DEFAULT_TRUST_CARDS_UPSTREAM = "http://127.0.0.1:4361";

// ENSv2 frontend provenance — read supervisor env once, build a cached loader,
// answer /v2/ens-discovery directly. This is independent of the signed-offer
// gate so the browser always sees the ENS reads even when the live offers
// reject the ENS data with OFFER_RECORD_MISMATCH.
function parseSupervisorEnv(raw) {
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2];
  }
  return env;
}

function readEnsConfiguration(env, envFile) {
  if (!env) {
    return { enabled: false, reason: `supervisor env file not found at ${envFile}` };
  }
  if (env.W6_USE_ENS_DISCOVERY !== "1") {
    return { enabled: false, reason: "W6_USE_ENS_DISCOVERY is not \"1\" in supervisor env" };
  }
  if (!env.W6_ENS_DISCOVERY_RPC_URL) {
    return { enabled: false, reason: "W6_ENS_DISCOVERY_RPC_URL is required when discovery is on" };
  }
  const rawNames = env.W6_ENS_DISCOVERY_NAMES;
  const names = typeof rawNames === "string" && rawNames.length > 0
    ? rawNames.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  return {
    enabled: true,
    rpcUrl: env.W6_ENS_DISCOVERY_RPC_URL,
    names,
    ttlMs: Number(env.W6_ENS_DISCOVERY_TTL_MS ?? DEFAULT_TTL_MS),
    timeoutMs: Number(env.W6_ENS_DISCOVERY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  };
}

/**
 * Read the supervisor env file (0600) once and derive the ENS configuration
 * plus the demo sponsor's configured refill windows. Only the numeric refill
 * values are lifted out of the file; nothing from it is logged or echoed.
 */
export function readSupervisorConfiguration(envFile) {
  let env = null;
  if (existsSync(envFile)) {
    env = parseSupervisorEnv(readFileSync(envFile, "utf8"));
  }
  return {
    envFile,
    envFound: env !== null,
    ens: readEnsConfiguration(env, envFile),
    demoSponsor: env ? readDemoSponsorRefillConfig(env) : readDemoSponsorRefillConfig({}),
  };
}

/** Pipe an upstream response, correcting the Retry-After on small JSON 429s. */
function pipeUpstreamResponse({ res, upstream, pathname, sponsor }) {
  const isJson429 =
    upstream.statusCode === 429 &&
    String(upstream.headers?.["content-type"] ?? "").includes("application/json");
  if (!isJson429) {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
    return;
  }
  const chunks = [];
  let size = 0;
  let streaming = false;
  let finished = false;

  const derivedHeaders = (body) => {
    const derived = deriveUpstreamRetryAfterMs({
      body,
      headers: upstream.headers ?? {},
      pathname,
      sponsor,
    });
    const headers = { ...upstream.headers };
    if (Number.isFinite(derived.retryAfterMs)) {
      // Preserve/forward the precise value (never a hard-coded 60 when the
      // upstream or the sponsor published something exact).
      headers["retry-after"] = String(retryAfterSecondsFromMs(derived.retryAfterMs));
    }
    return headers;
  };

  upstream.on("data", (chunk) => {
    if (streaming) {
      if (!res.writableEnded) res.write(chunk);
      return;
    }
    chunks.push(chunk);
    size += chunk.length;
    if (size > RATE_LIMIT_BODY_MAX_BYTES) {
      // Too large to buffer: fall back to header-only derivation and stream.
      const headers = derivedHeaders(null);
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      res.writeHead(429, headers);
      for (const buffered of chunks) res.write(buffered);
      chunks.length = 0;
      streaming = true;
    }
  });
  upstream.on("end", () => {
    if (finished) return;
    finished = true;
    if (streaming) {
      res.end();
      return;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const headers = derivedHeaders(raw);
    headers["content-length"] = String(Buffer.byteLength(raw));
    delete headers["transfer-encoding"];
    res.writeHead(429, headers);
    res.end(raw);
  });
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"app upstream unavailable","retryable":true}}');
      return;
    }
    res.destroy();
  });
}

/**
 * Build the public edge server. All side effects (binding, timers) are owned
 * by the caller so tests can start it on an ephemeral port with fixture
 * upstreams, while the supervisor entry point below binds 4351 unchanged.
 */
export function createPublicEdgeServer(options = {}) {
  const origin = options.origin;
  if (!origin) throw Error("W6_PUBLIC_ORIGIN_REQUIRED");
  let allowedAuthority;
  try {
    allowedAuthority = new URL(origin).host.toLowerCase();
  } catch {
    throw Error("W6_PUBLIC_ORIGIN_INVALID");
  }

  const runtimeRoot =
    options.runtimeRoot ?? process.env.W6_RUNTIME_ROOT ?? DEFAULT_RUNTIME_ROOT;
  const paidUpstream =
    options.paidUpstream ?? process.env.W6_EDGE_PAID_UPSTREAM ?? DEFAULT_PAID_UPSTREAM;
  const nonEconomicUpstream =
    options.nonEconomicUpstream ??
    process.env.W6_EDGE_FREE_UPSTREAM ??
    DEFAULT_NON_ECONOMIC_UPSTREAM;
  const trustCardsUpstream =
    options.trustCardsUpstream ??
    process.env.W6_EDGE_TRUST_CARDS_UPSTREAM ??
    DEFAULT_TRUST_CARDS_UPSTREAM;
  const supervisorEnvFile =
    options.supervisorEnvFile ??
    process.env.W6_SUPERVISOR_ENV_FILE ??
    `${process.env.HOME}/.config/mycelium/w6-supervisors.env`;
  const log = typeof options.log === "function" ? options.log : console.log;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const limits = options.limits ?? PUBLIC_GET_LIMITS;
  const limiter = options.limiter ?? createPublicGetLimiter({ limits, now });
  const supervisor = options.supervisorConfiguration ?? readSupervisorConfiguration(supervisorEnvFile);
  const ensConfig = supervisor.ens;
  const sponsor = supervisor.demoSponsor;
  const handleProviderStats = options.providerStatsHandler ?? tryHandleProviderStatsRoute;
  const handleRateLimitedStats = options.rateLimitedStatsHandler ?? tryServeRateLimitedStaleProviderStats;

  // Cache the upstream probe for a bounded window so a judge page-load does not
  // double-probe on every request (the retired script probed twice per request).
  let probeCache = { at: 0, paid: false };
  async function paidUp() {
    if (now() - probeCache.at < 5_000) return probeCache.paid;
    const paid = await fetch(paidUpstream + "/healthz").then(() => true).catch(() => false);
    probeCache = { at: now(), paid };
    return paid;
  }

  let ensLoader = null;
  if (options.ensLoader !== undefined) {
    ensLoader = options.ensLoader;
  } else if (ensConfig.enabled) {
    try {
      ensLoader = loadProvidersFromEns({
        names: ensConfig.names.length
          ? ensConfig.names
          : ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"],
        rpcUrl: ensConfig.rpcUrl,
        ttlMs: ensConfig.ttlMs,
        timeoutMs: ensConfig.timeoutMs,
        mode: "live",
      });
      log(
        JSON.stringify({
          status: "ens-discovery-edge-attached",
          enabled: true,
          rpcHost: new URL(ensConfig.rpcUrl).host,
          configuredNames: ensConfig.names,
        }),
      );
    } catch (error) {
      log(
        JSON.stringify({
          status: "ens-discovery-edge-disabled",
          reason: error?.message ?? String(error),
        }),
      );
      ensLoader = null;
    }
  } else {
    log(
      JSON.stringify({
        status: "ens-discovery-edge-disabled",
        reason: ensConfig.reason,
      }),
    );
  }

  async function serveEnsDiscovery(url, res) {
    const names = url.searchParams.getAll("name").filter(Boolean);
    if (names.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INVALID_INPUT", message: "name query required" } }));
      return;
    }
    if (names.length > 32) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INVALID_INPUT", message: "too many names (max 32)" } }));
      return;
    }
    if (!ensLoader) {
      const body = {
        version: "w6.ens-discovery.v1",
        ok: false,
        enabled: false,
        reason: ensConfig.reason,
        names,
        providers: [],
        errors: names.map((n) => ({ name: n, code: "DISCOVERY_DISABLED" })),
        provenance: names.map((n) => ({
          name: n,
          state: "unavailable",
          hasProvider: false,
          hasError: true,
          error: { code: "DISCOVERY_DISABLED", message: ensConfig.reason ?? "not enabled" },
          ageMs: null,
          ttlMs: ensConfig.ttlMs ?? null,
        })),
        observedAt: new Date().toISOString(),
        recordKeys: [...RECORD_KEYS],
        route: null,
        rpcHost: ensConfig.rpcUrl ? new URL(ensConfig.rpcUrl).host : null,
        ttlMs: ensConfig.ttlMs ?? null,
        timeoutMs: ensConfig.timeoutMs ?? null,
      };
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
      return;
    }
    const startedAt = Date.now();
    // Bump the per-call budget to (timeoutMs + 5s) so two sequential
    // 15s reads still fit, while still bounding total latency.
    let result;
    try {
      result = await Promise.race([
        ensLoader.list({ names }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error("ENS_RPC_TIMEOUT"), { code: "ENS_RPC_TIMEOUT" })),
            (ensConfig.timeoutMs + 5000) * Math.max(1, names.length),
          ),
        ),
      ]);
    } catch (error) {
      result = {
        providers: [],
        errors: names.map((n) => ({
          name: n,
          code: error?.code ?? "ENS_RPC_UNAVAILABLE",
          message: error?.message ?? String(error),
        })),
      };
    }
    const elapsedMs = Date.now() - startedAt;
    const providers = (result.providers ?? []).map((p) => ({
      providerId: p.providerId,
      endpoint: p.endpoint,
      profileIds: p.profileIds,
      paymentNetwork: p.paymentNetwork,
      paymentAsset: p.paymentAsset,
      paymentReceiver: p.paymentReceiver,
      historyEndpoint: p.historyEndpoint,
      source: p.source,
    }));
    const errorCodes = new Map((result.errors ?? []).map((e) => [e.name, e.code]));
    const provenance = names.map((name) => {
      const p = providers.find((x) => x.providerId === name) ?? null;
      const errorCode = errorCodes.get(name);
      let state;
      if (!p && errorCode) state = "unavailable";
      else if (p && errorCode) state = "conflicting";
      else if (p) state = "valid";
      else state = "expired";
      return {
        name,
        state,
        hasProvider: Boolean(p),
        hasError: Boolean(errorCode),
        provider: p,
        error: errorCode ? { code: errorCode } : null,
        ageMs: p ? elapsedMs : null,
        ttlMs: ensConfig.ttlMs,
      };
    });
    const body = {
      version: "w6.ens-discovery.v1",
      ok: providers.length > 0,
      enabled: true,
      reason: null,
      route: "ensv2-sepolia-onchain",
      rpcHost: new URL(ensConfig.rpcUrl).host,
      ttlMs: ensConfig.ttlMs,
      timeoutMs: ensConfig.timeoutMs,
      recordKeys: [...RECORD_KEYS],
      elapsedMs,
      observedAt: new Date().toISOString(),
      names,
      providers,
      errors: [...(result.errors ?? [])],
      provenance,
    };
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    // Exact Host authority matching: W6_PUBLIC_ORIGIN host (including port if
    // non-default). Any mismatch returns 403.
    const host = String(req.headers.host || "").toLowerCase();
    if (host !== allowedAuthority) { res.writeHead(403); res.end("ORIGIN_DENIED"); return; }

    const requestUrl = new URL(req.url, `http://${req.headers.host ?? allowedAuthority}`);

    // Phase R — bounded per-IP / per-route-class rate limiting for public GETs.
    // Runs before /v2/ens-discovery, /v2/providers/stats, the trust-card proxy
    // and the /v1|/v2 upstream proxy so none of them can be hammered.
    if (req.method === "GET") {
      const routeClass = classifyPublicGet(requestUrl.pathname);
      if (routeClass) {
        const decision = limiter.consume(routeClass, clientKey(req));
        if (!decision.ok) {
          // A cached stats value beats a hard 429: serve it stale with the
          // precise Retry-After so the viewer still renders real data.
          if (routeClass === "providers-stats" && handleRateLimitedStats(req, res, requestUrl, decision)) {
            return;
          }
          send429(res, {
            reason: decision.scope === "global" ? "RATE_LIMITED_GLOBAL" : "RATE_LIMITED",
            retryAfterMs: decision.retryAfterMs,
            route: routeClass,
          });
          return;
        }
      }
    }

    if (req.method === "GET" && req.url === "/__w6/stream-probe") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" }); res.flushHeaders();
      res.write('event: probe\ndata: {"fixture":true,"part":1}\n\n');
      const timer = setTimeout(() => res.end('event: probe\ndata: {"fixture":true,"part":2}\n\n'), 1200);
      res.once("close", () => clearTimeout(timer)); return;
    }
    // /v2/ens-discovery — answered locally so the browser can render the
    // "Resolved via ENSv2 · Sepolia" badge independently of the signed-offer
    // gate that /v1/providers runs.
    if (req.method === "GET" && requestUrl.pathname === "/v2/ens-discovery") {
      await serveEnsDiscovery(requestUrl, res);
      return;
    }
    // Step 7 — /v2/providers/stats (provider-stats API). Answered locally so
    // the subgraph credentials stay server-side. Intercepted before the
    // /v2/* proxy and before the static-route allowlist so the route is
    // available even when the upstream app is unhealthy.
    if (handleProviderStats(req, res, requestUrl)) return;
    if (req.method === "GET" && requestUrl.pathname === "/v2/ens-discovery/healthz") {
      const body = {
        status: ensLoader ? "ok" : "disabled",
        enabled: ensConfig.enabled,
        reason: ensConfig.reason ?? null,
        route: ensConfig.enabled ? "ensv2-sepolia-onchain" : null,
        rpcHost: ensConfig.rpcUrl ? new URL(ensConfig.rpcUrl).host : null,
        ttlMs: ensConfig.ttlMs ?? null,
        timeoutMs: ensConfig.timeoutMs ?? null,
      };
      res.writeHead(ensConfig.enabled ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
      return;
    }
    if (!existsSync(runtimeRoot + "/public-app-enabled.json")) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"status":"preparing"}'); return; }
    const staticRoutes = new Set([
      "/",
      "/style.css",
      "/app.js",
      "/viewer.js",
      "/application-browser.js",
      "/w6-wallet-ui.mjs",
      "/w6-hashpack-adapter.mjs",
      "/w6-isolated-free.js",
      "/debug-drawer.js",
      "/debug-drawer.css",
      "/config.json",
      "/healthz",
    ]);
    const pathname = new URL(req.url, origin).pathname;
    const trustCardRoutes =
      pathname === "/trust-cards" ||
      pathname === "/trust-cards/" ||
      pathname === "/trust-cards.js" ||
      pathname === "/trust-cards.css" ||
      pathname.startsWith("/api/");
    const publicRoutes =
      staticRoutes.has(pathname) ||
      trustCardRoutes ||
      pathname.startsWith("/v1/") ||
      pathname.startsWith("/v2/");
    if (!publicRoutes) { res.writeHead(404); res.end(); return; }
    if (trustCardRoutes) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      const target = new URL(trustCardsUpstream);
      const headers = { ...req.headers, host: target.host };
      const up = request(target.origin + req.url, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"trust cards upstream unavailable","retryable":true}}'); });
      req.on("aborted", () => up.destroy()); res.on("close", () => up.destroy()); req.pipe(up);
      return;
    }

    // Paid-upstream selection (behavior of the retired scripts/w6-paid-edge.mjs):
    // when the paid app is healthy it serves ALL public routes — the judge
    // journey reads /config.json expecting accessPolicy ordinary-paid-x402 and
    // runs its payment flow against the same origin. The non-economic app is
    // the full fallback when the paid app is down.
    let base = nonEconomicUpstream;
    if (await paidUp()) base = paidUpstream;
    const target = new URL(base);
    const headers = { ...req.headers, host: target.host };
    const up = request(target.origin + req.url, { method: req.method, headers }, (r) => {
      pipeUpstreamResponse({ res, upstream: r, pathname, sponsor });
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"app upstream unavailable","retryable":true}}'); });
    req.on("aborted", () => up.destroy()); res.on("close", () => up.destroy()); req.pipe(up);
  });
  server.headersTimeout = 5000; server.requestTimeout = 120000; server.maxConnections = 128;

  return {
    server,
    limiter,
    ensConfig,
    sponsor,
    allowedAuthority,
    config: { origin, runtimeRoot, paidUpstream, nonEconomicUpstream, trustCardsUpstream },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  const self = fileURLToPath(import.meta.url);
  if (argv1 === self) return true;
  try {
    return realpathSync(argv1) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const origin = process.env.W6_PUBLIC_ORIGIN;
  if (!origin) throw Error("W6_PUBLIC_ORIGIN_REQUIRED");
  const configuredPort = Number(process.env.W6_EDGE_PORT ?? 4351);
  const port = Number.isFinite(configuredPort) && configuredPort >= 0 ? configuredPort : 4351;
  const edge = createPublicEdgeServer({ origin });
  edge.server.listen(port, "127.0.0.1", () =>
    console.log(JSON.stringify({ status: "public-edge-ready", origin, port, paidUpstream: "preferred-for-v1", inferenceEnabled: false })),
  );
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => edge.server.close(() => process.exit(0)));
}
