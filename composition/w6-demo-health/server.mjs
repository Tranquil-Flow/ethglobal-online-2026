#!/usr/bin/env node
// Mycelium demo-health dashboard — w6 Demo-Health-Dashboard lane.
// Single-purpose local HTTP server. Port 4363.
// Probes all 12 demo surfaces in parallel and renders a judge-facing matrix.
// No writes outside this directory + artifacts/w6-v2/demo-health/.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.W6_DEMO_HEALTH_PORT ?? 4363);
const HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = Number(process.env.W6_DEMO_HEALTH_PROBE_TIMEOUT_MS ?? 5000);

// ----------------------------------------------------------------------------
// Surface definitions. Each entry: id, display name, probe URL, parser.
// parser(state, body, headers) -> { state, reason }
//   state: "GREEN" | "YELLOW" | "RED"
//   reason: short string
// ----------------------------------------------------------------------------
const SURFACES = [
  {
    id: "owner-console",
    name: "Owner console",
    url: "http://127.0.0.1:4360/healthz",
    probe: standardHealthzProbe,
  },
  {
    id: "free-viewer",
    name: "Free viewer",
    url: "http://127.0.0.1:4350/healthz",
    probe: standardHealthzProbe,
  },
  {
    id: "native-gateway",
    name: "Native gateway",
    url: "http://127.0.0.1:8791/healthz",
    probe: standardHealthzProbe,
  },
  {
    id: "paid-app",
    name: "Paid app",
    // Two-step probe: /healthz must be GREEN, /v2/demo-sponsor/authorize known YELLOW (OT1 bug).
    url: "http://127.0.0.1:4352/healthz",
    probe: paidAppProbe,
  },
  {
    id: "trust-cards",
    name: "Trust cards",
    url: "http://127.0.0.1:4361/healthz",
    probe: standardHealthzProbe,
  },
  {
    id: "demo-ui",
    name: "Demo UI (this lane)",
    url: "http://127.0.0.1:4362/api/status",
    probe: standardJsonProbe,
  },
  {
    id: "tee-verifier",
    name: "TEE verifier (Flask)",
    url: "http://34.7.61.130:8765/healthz",
    probe: teeFlaskProbe,
  },
  {
    id: "tee-launcher",
    name: "TEE tee-launcher (alt)",
    url: "http://34.7.61.130:8766/healthz",
    probe: teeLauncherProbe,
  },
  {
    id: "public-endpoint",
    name: "Public endpoint",
    url: "https://mycelium.now/healthz",
    probe: myceliumPublicProbe,
  },
  {
    id: "subgraph-studio",
    name: "Subgraph Studio v0.3.1",
    url: "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile",
    probe: subgraphProbe,
  },
  {
    id: "hedera-mirror",
    name: "Hedera mirror (canonical paid G01)",
    url: "https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789239567-211071753",
    probe: hederaMirrorProbe,
  },
  {
    id: "hashscan",
    name: "HashScan (canonical paid G01)",
    url: "https://hashscan.io/testnet/transaction/0.0.7162784-1789239567-211071753",
    probe: hashscanProbe,
  },
];

// ----------------------------------------------------------------------------
// Fetch helper with bounded timeout via AbortController.
async function boundedFetch(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/json,text/plain,*/*" },
    });
    const elapsed = Date.now() - start;
    const body = await res.text();
    clearTimeout(timer);
    return { ok: true, status: res.status, body, elapsed, headers: res.headers };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    const aborted = err && (err.name === "AbortError" || err.code === "ABORT_ERR");
    return { ok: false, status: 0, body: "", elapsed, error: aborted ? "timeout" : String(err && err.message ? err.message : err) };
  }
}

// ----------------------------------------------------------------------------
// Probe functions. Each returns { state, reason, detail? }.
function standardHealthzProbe({ status, body }) {
  if (status === 200) return { state: "GREEN", reason: "200 OK" };
  if (status === 0) return { state: "RED", reason: "unreachable" };
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  if (status >= 400) return { state: "YELLOW", reason: `${status} not ok` };
  return { state: "YELLOW", reason: `${status} unexpected` };
}

function standardJsonProbe({ status, body }) {
  if (status === 0) return { state: "RED", reason: "unreachable" };
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  if (status >= 400) return { state: "YELLOW", reason: `${status} not ok` };
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      return { state: "GREEN", reason: `200 ok` };
    } catch {
      return { state: "YELLOW", reason: `200 non-JSON` };
    }
  }
  return { state: "YELLOW", reason: `${status} unexpected` };
}

// Paid app: /healthz must be 200 GREEN; /v2/demo-sponsor/authorize is a known OT1 bug -> YELLOW.
async function paidAppProbe() {
  const health = await boundedFetch("http://127.0.0.1:4352/healthz");
  if (!health.ok || health.status !== 200) {
    return {
      state: health.ok && health.status >= 500 ? "RED" : "YELLOW",
      reason: `healthz ${health.status || "unreachable"}`,
      detail: { healthz: health },
    };
  }
  // Optional authorize probe; mark YELLOW on 503 (OT1 bug), otherwise degrade.
  const auth = await boundedFetch(
    "http://127.0.0.1:4352/v2/demo-sponsor/authorize",
    PROBE_TIMEOUT_MS,
  );
  if (auth.status === 503) {
    return {
      state: "YELLOW",
      reason: "healthz OK; DEMO authorize 503 OT1 bug known",
      detail: { healthz: health, authorize: { status: auth.status, body: auth.body.slice(0, 200) } },
    };
  }
  if (auth.status >= 500 || auth.status === 0) {
    return {
      state: "YELLOW",
      reason: `healthz OK; authorize ${auth.status || "unreachable"}`,
      detail: { healthz: health, authorize: { status: auth.status, body: auth.body.slice(0, 200) } },
    };
  }
  return {
    state: "GREEN",
    reason: "healthz + authorize OK",
    detail: { healthz: health, authorize: { status: auth.status, body: auth.body.slice(0, 200) } },
  };
}

function teeFlaskProbe({ status, body }) {
  if (status === 0) return { state: "RED", reason: "unreachable" };
  if (status === 200) {
    // SEV kernel proof only, no /attestation or /generate-key — YELLOW per SUBMISSION-REPORT §5 Y3.
    return { state: "YELLOW", reason: "200 ok; plain Flask no /attestation (Y3)" };
  }
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  return { state: "YELLOW", reason: `${status} not 200` };
}

function teeLauncherProbe({ status, body }) {
  // tee-launcher /healthz returns a status JSON (state/swname) and /attestation returns a JWT.
  // If the status payload indicates CONFIDENTIAL_SPACE/SEV with state=ok, GREEN.
  if (status === 0) return { state: "RED", reason: "unreachable" };
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      if (j && (j.status === "ok" || j.state === "running") && (j.swname || j.hwmodel)) {
        const tee = String(j.swname || "").includes("CONFIDENTIAL") || String(j.swname || "").includes("SEV") || /SEV|EPYC|Confidential/i.test(String(j.hwmodel || ""));
        if (tee && (j.key_generated || j.attestation || j.tee_port)) {
          return { state: "GREEN", reason: `TEE ok (${j.swname || j.hwmodel || "TEE"})` };
        }
        return { state: "YELLOW", reason: `200 but no TEE fields (${JSON.stringify(j).slice(0, 80)})` };
      }
      return { state: "YELLOW", reason: "200 unexpected body" };
    } catch {
      return { state: "YELLOW", reason: "200 non-JSON" };
    }
  }
  if (status === 404) return { state: "YELLOW", reason: "404 tee-launcher not deployed (N1)" };
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  return { state: "YELLOW", reason: `${status} unexpected` };
}

function myceliumPublicProbe({ status, body }) {
  if (status === 0) return { state: "RED", reason: "unreachable" };
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      if (j && j.status === "ok" && j.mode === "live") {
        return { state: "GREEN", reason: `200 ok live` };
      }
      return { state: "YELLOW", reason: `200 unexpected body: ${JSON.stringify(j).slice(0, 80)}` };
    } catch {
      return { state: "YELLOW", reason: "200 non-JSON" };
    }
  }
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  return { state: "YELLOW", reason: `${status} not 200` };
}

function subgraphProbe({ status, body }) {
  if (status === 0) return { state: "RED", reason: "unreachable" };
  // Subgraph Studio returns 302 (redirect) when the deployment slug is wrong/not deployed.
  if (status === 302 || status === 301 || status === 307 || status === 308) {
    return { state: "YELLOW", reason: `${status} deployment not live at this slug` };
  }
  if (status === 200) {
    const head = String(body).slice(0, 600);
    if (/GraphiQL|<title>The GraphiQL/i.test(head)) {
      return { state: "YELLOW", reason: "200 redirected to GraphiQL playground (deployment slug not deployed)" };
    }
    try {
      const j = JSON.parse(body);
      if (j && j.data) {
        return { state: "GREEN", reason: "200 Graph response" };
      }
      if (j && j.errors) {
        return { state: "YELLOW", reason: `200 Graph errors: ${(j.errors[0] && j.errors[0].message) || "unknown"}` };
      }
      return { state: "YELLOW", reason: "200 unexpected shape" };
    } catch {
      return { state: "YELLOW", reason: "200 non-JSON body" };
    }
  }
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  return { state: "YELLOW", reason: `${status} not 200` };
}

function hederaMirrorProbe({ status, body }) {
  if (status === 0) return { state: "RED", reason: "unreachable" };
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      // Canonical G01 has result: SUCCESS — see SUBMISSION-REPORT.md §2.
      if (j && j.transactions && Array.isArray(j.transactions) && j.transactions.length > 0) {
        const t = j.transactions[0];
        if (t.result === "SUCCESS") {
          return { state: "GREEN", reason: `200 SUCCESS ${(t.transaction_id || "").slice(0, 20)}…` };
        }
        return { state: "YELLOW", reason: `200 result=${t.result || "?"}` };
      }
      return { state: "YELLOW", reason: "200 no transactions array" };
    } catch {
      return { state: "YELLOW", reason: "200 non-JSON" };
    }
  }
  if (status === 404) return { state: "RED", reason: "404 not found" };
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  return { state: "YELLOW", reason: `${status} not 200` };
}

function hashscanProbe({ status, body }) {
  // HashScan returns 200 HTML; we only verify reachability + title presence.
  if (status === 0) return { state: "RED", reason: "unreachable" };
  if (status === 200) {
    if (/HashScan|Hedera|Transaction/i.test(body.slice(0, 4000))) {
      return { state: "GREEN", reason: "200 page live" };
    }
    return { state: "YELLOW", reason: "200 unexpected body" };
  }
  if (status >= 500) return { state: "RED", reason: `${status} server error` };
  return { state: "YELLOW", reason: `${status} not 200` };
}

// ----------------------------------------------------------------------------
// Probes one surface record sequentially (used by parallel orchestration).
async function probeOne(surface) {
  const startedAt = new Date().toISOString();
  try {
    // paid-app has its own async probe.
    if (surface.id === "paid-app") {
      const result = await surface.probe();
      return finalize(surface, startedAt, result);
    }
    const fetchResult = await boundedFetch(surface.url);
    const result = surface.probe(fetchResult);
    return finalize(surface, startedAt, { ...result, elapsedMs: fetchResult.elapsed, status: fetchResult.status });
  } catch (err) {
    return {
      id: surface.id,
      name: surface.name,
      url: surface.url,
      state: "RED",
      reason: `probe error: ${err && err.message ? err.message : String(err)}`,
      probedAt: startedAt,
    };
  }
}

function finalize(surface, startedAt, result) {
  return {
    id: surface.id,
    name: surface.name,
    url: surface.url,
    state: result.state,
    reason: result.reason,
    probedAt: startedAt,
    ...(result.detail
      ? { detail: { status: result.detail.healthz ? result.detail.healthz.status : undefined } }
      : {}),
  };
}

// ----------------------------------------------------------------------------
// Aggregate overall state from surface states.
function aggregate(states) {
  if (states.some((s) => s === "RED")) return "RED";
  if (states.some((s) => s === "YELLOW")) return "YELLOW";
  return "GREEN";
}

// ----------------------------------------------------------------------------
// Run all probes in parallel with an outer wallclock bound.
async function runDiagnostics() {
  const capturedAt = new Date().toISOString();
  const probes = SURFACES.map((surface) =>
    probeOne(surface).catch((err) => ({
      id: surface.id,
      name: surface.name,
      url: surface.url,
      state: "RED",
      reason: `probe crash: ${err && err.message ? err.message : String(err)}`,
      probedAt: new Date().toISOString(),
    })),
  );
  const settled = await Promise.allSettled(probes);
  const surfaces = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      id: SURFACES[i].id,
      name: SURFACES[i].name,
      url: SURFACES[i].url,
      state: "RED",
      reason: `probe rejected: ${String(r.reason && r.reason.message ? r.reason.message : r.reason)}`,
      probedAt: new Date().toISOString(),
    };
  });
  const overall = aggregate(surfaces.map((s) => s.state));
  return { capturedAt, surfaces, overall };
}

// ----------------------------------------------------------------------------
// HTTP server.
function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Demo-Health": "w6-demo-health",
  });
  res.end(body);
}

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Demo-Health": "w6-demo-health",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method !== "GET") {
    return textResponse(res, 405, "method not allowed\n");
  }
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(join(PUBLIC_DIR, "index.html"));
      return textResponse(res, 200, html, "text/html; charset=utf-8");
    }
    if (url.pathname === "/dashboard.js") {
      const js = await readFile(join(PUBLIC_DIR, "dashboard.js"));
      return textResponse(res, 200, js, "application/javascript; charset=utf-8");
    }
    if (url.pathname === "/dashboard.css") {
      const css = await readFile(join(PUBLIC_DIR, "dashboard.css"));
      return textResponse(res, 200, css, "text/css; charset=utf-8");
    }
    if (url.pathname === "/api/diagnostics" || url.pathname === "/healthz") {
      const diag = await runDiagnostics();
      return jsonResponse(res, 200, diag);
    }
    return textResponse(res, 404, "not found\n");
  } catch (err) {
    return jsonResponse(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[w6-demo-health] listening on http://${HOST}:${PORT}/`);
});

// Bounded probe budget: 5s each, but Promise.all parallel — outer wallclock is bounded by slowest probe.
process.on("SIGINT", () => {
  // eslint-disable-next-line no-console
  console.log("[w6-demo-health] SIGINT, shutting down");
  server.close(() => process.exit(0));
});