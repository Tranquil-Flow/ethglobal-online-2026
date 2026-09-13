// Loopback-only edge adapter for the explicitly selected public demo origin.
// Native gateway and its bearer are never reachable through this listener.
// P2: this is now the single edge. It carries the paid-upstream selection
// from scripts/w6-paid-edge.mjs (which is retired): when the paid app on 4352
// is healthy it takes precedence for /v1/* API traffic; otherwise the
// non-economic app on 4350 serves everything. The route allowlist and the
// public-app gate are preserved fail-closed.
import { createServer, request } from "node:http";
import { existsSync, readFileSync } from "node:fs";

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
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
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
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on("aborted", () => up.destroy()); res.on("close", () => up.destroy()); req.pipe(up);
});
server.headersTimeout = 5000; server.requestTimeout = 120000; server.maxConnections = 128;
server.listen(4351, "127.0.0.1", () => console.log(JSON.stringify({ status: "public-edge-ready", origin, paidUpstream: "preferred-for-v1", inferenceEnabled: false })));
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => server.close(() => process.exit(0)));
