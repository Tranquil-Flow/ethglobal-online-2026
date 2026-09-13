import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendStateHistory,
  classifyOffHost,
  deliverAlerts,
  evaluateFreshness,
  runMonitor,
} from "../w6-monitor.mjs";

async function fixtureServer({ offHostStatus = 200, offHostBody = "ok" } = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/offhost") {
      res.writeHead(offHostStatus, { "content-type": "text/plain" });
      return res.end(offHostBody);
    }
    if (req.url === "/edge") return res.end("edge ok");
    if (req.url === "/paid/healthz") return json(200, { status: "ok", mode: "live" });
    if (req.url === "/paid/v2/runtime-status") {
      return json(
        200,
        { version: "1", providers: [{ providerId: "paid.example", state: "ready" }] },
        { date: new Date().toUTCString() },
      );
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("# TYPE cloudflared_tunnel_ha_connections gauge\ncloudflared_tunnel_ha_connections 2\n");
    }
    if (req.url === "/free/config.json") {
      return json(200, {
        accessPolicy: "non-economic",
        providerId: "free.example",
        profileId: `sha256:${"a".repeat(64)}`,
      });
    }
    if (req.url === "/free/v1/sessions" && req.method === "POST") {
      return json(201, { capability: "fixture-capability", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    if (req.url === "/free/v1/quotes" && req.method === "POST") {
      assert.equal(req.headers.authorization, "Bearer fixture-capability");
      const parsed = JSON.parse(body);
      assert.equal(parsed.request.providerId, "free.example");
      assert.equal(parsed.request.prompt, "W6 availability probe; no inference requested.");
      return json(201, {
        quoteId: "fixture-free-quote",
        amountBaseUnits: "0",
        providerId: parsed.request.providerId,
        profileId: parsed.request.profileId,
      });
    }
    if (req.url === "/free/v1/sessions/revoke" && req.method === "POST") {
      return json(204, undefined);
    }
    json(404, { code: "NOT_FOUND" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    calls,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function endpoints(base) {
  return {
    offHostUrl: `${base}/offhost`,
    edgeUrl: `${base}/edge`,
    paidBaseUrl: `${base}/paid`,
    freeBaseUrl: `${base}/free`,
    verifierUrl: "https://verifier.example/attestation",
    mirrorBaseUrl: "https://mirror.example/api/v1/accounts",
  };
}

test("403 ORIGIN_DENIED is the only pre-cutover off-host success", async () => {
  assert.deepEqual(classifyOffHost(403, "ORIGIN_DENIED"), {
    ok: true,
    state: "pre-cutover-ok",
    status: 403,
  });
  assert.equal(classifyOffHost(403, '{"code":"OTHER"}').ok, false);
  assert.equal(classifyOffHost(502, "ORIGIN_DENIED").ok, false);
  assert.equal(classifyOffHost(200, "index").state, "ok");
});

test("runtime freshness rejects missing, stale, and implausibly future timestamps", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  assert.equal(evaluateFreshness({ responseDate: "Sat, 12 Sep 2026 11:59:30 GMT", now, maxAgeMs: 60_000 }).ok, true);
  assert.equal(evaluateFreshness({ responseDate: "Sat, 12 Sep 2026 11:50:00 GMT", now, maxAgeMs: 60_000 }).reason, "stale");
  assert.equal(evaluateFreshness({ responseDate: "Sat, 12 Sep 2026 12:02:00 GMT", now, maxAgeMs: 60_000 }).reason, "future");
  assert.equal(evaluateFreshness({ responseDate: null, now, maxAgeMs: 60_000 }).reason, "missing");
});

test("single shot checks edge, paid runtime, and a zero-value free quote without jobs or payments", async (t) => {
  const fixture = await fixtureServer();
  t.after(fixture.close);
  const dir = await mkdtemp(join(tmpdir(), "w6-monitor-"));
  const tunnelConfig = join(dir, "tunnel.yml");
  await writeFile(tunnelConfig, "tunnel: fixture\ningress:\n  - service: http://127.0.0.1:4351\n");
  const notifications = [];
  const fetchCalls = [];
  const configuredEndpoints = { ...endpoints(fixture.base), offHostUrl: "https://mycelium.now/" };
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
    if (String(url) === "https://mycelium.now/") return new Response("index", { status: 200 });
    if (String(url) === "https://verifier.example/attestation") {
      const error = new TypeError("fetch failed");
      error.cause = { code: "ENOTFOUND" };
      throw error;
    }
    return fetch(url, init);
  };
  const result = await runMonitor({
    env: {},
    endpoints: configuredEndpoints,
    fetchImpl,
    notify: async (alert) => notifications.push(alert),
    stateFile: join(dir, "state.json"),
    tunnelConfigFile: tunnelConfig,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.offHost.state, "ok");
  assert.equal(result.checks.runtimeStatus.state, "ok");
  assert.equal(result.checks.freeQuote.state, "ok");
  assert.equal(result.checks.teeAttestation.state, "not-deployed");
  assert.equal(result.checks.sponsorBalance.state, "not-configured");
  assert.equal(result.checks.tunnelConnectors.state, "metrics-not-enabled");
  assert.equal(notifications.length, 0);
  assert.equal(fetchCalls.some((call) => call.url.includes("/v1/jobs")), false);
  assert.equal(fetchCalls.some((call) => call.url.includes("payment")), false);
  assert.equal(fixture.calls.some((call) => call.url === "/free/v1/quotes"), true);
  assert.equal(fixture.calls.some((call) => call.url === "/free/v1/sessions/revoke"), true);
  assert.equal(fixture.calls.find((call) => call.url === "/edge")?.headers.host, "mycelium.now");
});

test("full monitor accepts the exact edge 403 body before cutover", async (t) => {
  const fixture = await fixtureServer({ offHostStatus: 403, offHostBody: "ORIGIN_DENIED" });
  t.after(fixture.close);
  const dir = await mkdtemp(join(tmpdir(), "w6-monitor-"));
  const result = await runMonitor({
    env: {},
    endpoints: endpoints(fixture.base),
    fetchImpl: async (url, init) => {
      if (String(url).includes("verifier.example")) {
        const error = new TypeError("getaddrinfo ENOTFOUND verifier.example");
        error.cause = { code: "ENOTFOUND" };
        throw error;
      }
      return fetch(url, init);
    },
    notify: async () => assert.fail("pre-cutover status must not alert"),
    stateFile: join(dir, "state.json"),
    tunnelConfigFile: join(dir, "absent.yml"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.offHost.state, "pre-cutover-ok");
});

test("enabled TEE, sponsor balance, and cloudflared connector metrics are checked", async (t) => {
  const fixture = await fixtureServer();
  t.after(fixture.close);
  const dir = await mkdtemp(join(tmpdir(), "w6-monitor-enabled-"));
  const tunnelConfig = join(dir, "tunnel.yml");
  await writeFile(tunnelConfig, `tunnel: fixture\nmetrics: ${fixture.base}/metrics\n`);
  const now = Date.now();
  const result = await runMonitor({
    env: {
      W6_TEE_MONITOR_ENABLED: "1",
      W6_DEMO_SPONSOR_ACCOUNT_ID: "0.0.12345",
      W6_DEMO_SPONSOR_MIN_TINYBAR: "100",
    },
    endpoints: endpoints(fixture.base),
    fetchImpl: async (url, init) => {
      if (String(url) === "https://verifier.example/attestation") {
        return Response.json({ issuedAt: new Date(now).toISOString(), token: "fixture-attestation" });
      }
      if (String(url) === "https://mirror.example/api/v1/accounts/0.0.12345") {
        return Response.json({ account: "0.0.12345", balance: { balance: 1000 } });
      }
      return fetch(url, init);
    },
    notify: async () => assert.fail("all enabled checks should pass"),
    now,
    stateFile: join(dir, "state.json"),
    tunnelConfigFile: tunnelConfig,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.teeAttestation.state, "ok");
  assert.equal(result.checks.sponsorBalance.balanceTinybar, "1000");
  assert.equal(result.checks.tunnelConnectors.connectors, 2);
});

test("failures use both macOS notification and optional webhook alert paths", async () => {
  const notifications = [];
  const webhookCalls = [];
  const report = {
    ok: false,
    checkedAt: "2026-09-12T12:00:00.000Z",
    failures: [{ check: "edge", reason: "status-502" }],
    checks: {},
  };
  const delivered = await deliverAlerts(report, {
    env: { W6_ALERT_WEBHOOK_URL: "https://alerts.example/hook" },
    notify: async (alert) => notifications.push(alert),
    fetchImpl: async (url, init) => {
      webhookCalls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(notifications.length, 1);
  assert.equal(webhookCalls.length, 1);
  assert.equal(webhookCalls[0].init.method, "POST");
  assert.equal(webhookCalls[0].init.headers["content-type"], "application/json");
  assert.equal(JSON.parse(webhookCalls[0].init.body).kind, "w6-monitor-alert");
  assert.deepEqual(delivered, { notification: "sent", webhook: "sent" });
});

test("state history is atomically bounded to the newest 500 entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "w6-monitor-state-"));
  const stateFile = join(dir, "state.json");
  for (let index = 0; index < 507; index += 1) {
    await appendStateHistory(stateFile, { index }, 500);
  }
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.history.length, 500);
  assert.equal(state.history[0].index, 7);
  assert.equal(state.history.at(-1).index, 506);
});
