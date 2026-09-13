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
import { createServer, request } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import {
  loadProvidersFromEns,
  DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
} from "./w6-ens-discovery-loader.mjs";
import { RECORD_KEYS } from "../packages/discovery/src/index.mjs";

const root = process.env.W6_RUNTIME_ROOT
  ?? "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z";
// Hard fail-closed: W6_PUBLIC_ORIGIN must be set explicitly. Do not silently
// fall back to a trycloudflare / debug hostname; this script proxies
// authenticated work and must only ever serve under the operator-approved
// stable HTTPS origin.
const origin = process.env.W6_PUBLIC_ORIGIN;
if (!origin) throw Error("W6_PUBLIC_ORIGIN_REQUIRED");
let allowedAuthority;
try { allowedAuthority = new URL(origin).host.toLowerCase(); } catch { throw Error("W6_PUBLIC_ORIGIN_INVALID"); }

const NON_ECONOMIC_UPSTREAM = "http://127.0.0.1:4350";
const PAID_UPSTREAM = "http://127.0.0.1:4352";
const TRUST_CARDS_UPSTREAM = "http://127.0.0.1:4361";

// Cache the upstream probe for a bounded window so a judge page-load does not
// double-probe on every request (the retired script probed twice per request).
let probeCache = { at: 0, paid: false };
async function paidUp() {
  if (Date.now() - probeCache.at < 5_000) return probeCache.paid;
  const paid = await fetch(PAID_UPSTREAM + "/healthz").then(() => true).catch(() => false);
  probeCache = { at: Date.now(), paid };
  return paid;
}

// ENSv2 frontend provenance — read supervisor env once, build a cached loader,
// answer /v2/ens-discovery directly. This is independent of the signed-offer
// gate so the browser always sees the ENS reads even when the live offers
// reject the ENS data with OFFER_RECORD_MISMATCH.
const supervisorEnvFile =
  process.env.W6_SUPERVISOR_ENV_FILE ??
  `${process.env.HOME}/.config/mycelium/w6-supervisors.env`;
function readSupervisorEnv() {
  if (!existsSync(supervisorEnvFile)) return { enabled: false, reason: `supervisor env file not found at ${supervisorEnvFile}` };
  const raw = readFileSync(supervisorEnvFile, "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2];
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
const ensConfig = readSupervisorEnv();
let ensLoader = null;
if (ensConfig.enabled) {
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
    console.log(
      JSON.stringify({
        status: "ens-discovery-edge-attached",
        enabled: true,
        rpcHost: new URL(ensConfig.rpcUrl).host,
        configuredNames: ensConfig.names,
      }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "ens-discovery-edge-disabled",
        reason: error?.message ?? String(error),
      }),
    );
    ensLoader = null;
  }
} else {
  console.log(
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
  if (req.method === "GET" && req.url === "/__w6/stream-probe") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" }); res.flushHeaders();
    res.write('event: probe\ndata: {"fixture":true,"part":1}\n\n');
    const timer = setTimeout(() => res.end('event: probe\ndata: {"fixture":true,"part":2}\n\n'), 1200);
    res.once("close", () => clearTimeout(timer)); return;
  }
  // /v2/ens-discovery — answered locally so the browser can render the
  // "Resolved via ENSv2 · Sepolia" badge independently of the signed-offer
  // gate that /v1/providers runs.
  if (req.method === "GET" && new URL(req.url, `http://${req.headers.host ?? allowedAuthority}`).pathname === "/v2/ens-discovery") {
    const url = new URL(req.url, `http://${req.headers.host ?? allowedAuthority}`);
    await serveEnsDiscovery(url, res);
    return;
  }
  if (req.method === "GET" && req.url === "/v2/ens-discovery/healthz") {
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
  if (!existsSync(root + "/public-app-enabled.json")) { res.writeHead(503, { "content-type": "application/json" }); res.end('{"status":"preparing"}'); return; }
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
    const target = new URL(TRUST_CARDS_UPSTREAM);
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
  let base = NON_ECONOMIC_UPSTREAM;
  if (await paidUp()) base = PAID_UPSTREAM;
  const target = new URL(base);
  const headers = { ...req.headers, host: target.host };
  const up = request(target.origin + req.url, { method: req.method, headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" }); res.end('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"app upstream unavailable","retryable":true}}'); });
  req.on("aborted", () => up.destroy()); res.on("close", () => up.destroy()); req.pipe(up);
});
server.headersTimeout = 5000; server.requestTimeout = 120000; server.maxConnections = 128;
server.listen(4351, "127.0.0.1", () => console.log(JSON.stringify({ status: "public-edge-ready", origin, paidUpstream: "preferred-for-v1", inferenceEnabled: false })));
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => server.close(() => process.exit(0)));
