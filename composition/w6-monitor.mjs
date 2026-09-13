#!/usr/bin/env node
// Wave 6 availability monitor. It never submits jobs, authorizes payments,
// restarts processes, or modifies retained application journals.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FRESHNESS_MS = 60_000;
const DEFAULT_TEE_FRESHNESS_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_ENDPOINTS = Object.freeze({
  offHostUrl: "https://mycelium.now/",
  edgeUrl: "http://127.0.0.1:4351/",
  paidBaseUrl: "http://127.0.0.1:4352",
  freeBaseUrl: "http://127.0.0.1:4350",
  verifierUrl: "https://verifier.mycelium.now/attestation",
  mirrorBaseUrl: "https://testnet.mirrornode.hedera.com/api/v1/accounts",
});
const DEFAULT_STATE_FILE = fileURLToPath(
  new URL("../artifacts/w6-v2/monitor/state.json", import.meta.url),
);
const FREE_PROBE_PROMPT = "W6 availability probe; no inference requested.";

function integerSetting(value, fallback, { minimum = 1 } = {}) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error("INVALID_MONITOR_INTEGER_SETTING");
  return parsed;
}

function timestampFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["issuedAt", "observedAt", "generatedAt", "checkedAt", "timestamp"]) {
    if (typeof payload[key] === "string" || typeof payload[key] === "number") return payload[key];
  }
  if (payload.attestation && typeof payload.attestation === "object") {
    const nested = timestampFromPayload(payload.attestation);
    if (nested !== null) return nested;
  }
  const token = [payload.token, payload.jwt, payload.attestationToken].find(
    (value) => typeof value === "string" && value.split(".").length === 3,
  );
  if (token) {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      if (Number.isFinite(claims.iat)) return claims.iat * 1000;
    } catch {
      return null;
    }
  }
  return null;
}

export function evaluateFreshness({ payload, responseDate, now = Date.now(), maxAgeMs = DEFAULT_FRESHNESS_MS }) {
  const candidate = timestampFromPayload(payload) ?? responseDate;
  if (candidate === undefined || candidate === null || candidate === "") {
    return { ok: false, reason: "missing" };
  }
  const timestamp = typeof candidate === "number" ? candidate : Date.parse(candidate);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "invalid" };
  const ageMs = now - timestamp;
  if (ageMs < -30_000) return { ok: false, reason: "future", ageMs };
  if (ageMs > maxAgeMs) return { ok: false, reason: "stale", ageMs };
  return { ok: true, state: "fresh", ageMs };
}

export function classifyOffHost(status, body) {
  if (status === 200) return { ok: true, state: "ok", status };
  if (status === 403 && String(body).trim() === "ORIGIN_DENIED") {
    return { ok: true, state: "pre-cutover-ok", status };
  }
  return { ok: false, state: "failed", status, reason: `status-${status}` };
}

async function fetchResponse(fetchImpl, url, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

async function responseText(response, maximum = 1_048_576) {
  const text = await response.text();
  if (Buffer.byteLength(text) > maximum) throw new Error("MONITOR_RESPONSE_TOO_LARGE");
  return text;
}

async function responseJson(response) {
  const text = await responseText(response);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error("MONITOR_INVALID_JSON");
  }
}

async function checkOffHost({ fetchImpl, endpoints, timeoutMs }) {
  const response = await fetchResponse(fetchImpl, endpoints.offHostUrl, {}, timeoutMs);
  return classifyOffHost(response.status, await responseText(response));
}

async function localEdgeGet(url, host, timeoutMs) {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new Error("EDGE_ENDPOINT_MUST_BE_LOOPBACK_HTTP");
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method: "GET", headers: { host } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1_048_576) {
          request.destroy(new Error("MONITOR_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("EDGE_TIMEOUT")));
    request.once("error", reject);
    request.end();
  });
}

async function checkEdge({ endpoints, timeoutMs }) {
  const publicHost = new URL(endpoints.offHostUrl).host;
  const response = await localEdgeGet(endpoints.edgeUrl, publicHost, timeoutMs);
  return response.status === 200
    ? { ok: true, state: "ok", status: 200 }
    : { ok: false, state: "failed", status: response.status, reason: `status-${response.status}` };
}

async function checkPaidHealth({ fetchImpl, endpoints, timeoutMs }) {
  const response = await fetchResponse(fetchImpl, `${endpoints.paidBaseUrl}/healthz`, {}, timeoutMs);
  const body = await responseJson(response);
  if (response.status === 200 && body?.status === "ok") {
    return { ok: true, state: "ok", status: 200, mode: body.mode ?? null };
  }
  return { ok: false, state: "failed", status: response.status, reason: "paid-health-invalid" };
}

async function checkRuntimeStatus({ fetchImpl, endpoints, timeoutMs, now, freshnessMs }) {
  const response = await fetchResponse(fetchImpl, `${endpoints.paidBaseUrl}/v2/runtime-status`, {}, timeoutMs);
  const body = await responseJson(response);
  if (response.status !== 200) {
    return { ok: false, state: "failed", status: response.status, reason: `status-${response.status}` };
  }
  const freshness = evaluateFreshness({
    payload: body,
    responseDate: response.headers.get("date"),
    now,
    maxAgeMs: freshnessMs,
  });
  if (!freshness.ok) return { ok: false, state: "failed", status: 200, reason: `runtime-${freshness.reason}` };
  if (body?.version !== "1" || !Array.isArray(body.providers) || body.providers.length === 0) {
    return { ok: false, state: "failed", status: 200, reason: "runtime-shape-invalid" };
  }
  const unavailable = body.providers.filter((provider) => provider?.state !== "ready").map((provider) => provider?.providerId ?? "unknown");
  if (unavailable.length) {
    return { ok: false, state: "failed", status: 200, reason: "runtime-provider-not-ready", unavailable };
  }
  return { ok: true, state: "ok", status: 200, freshness, providerCount: body.providers.length };
}

async function postJson(fetchImpl, url, body, { capability, timeoutMs } = {}) {
  return fetchResponse(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(capability ? { authorization: `Bearer ${capability}` } : {}),
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

async function checkFreeQuote({ fetchImpl, endpoints, timeoutMs }) {
  const configResponse = await fetchResponse(fetchImpl, `${endpoints.freeBaseUrl}/config.json`, {}, timeoutMs);
  const config = await responseJson(configResponse);
  if (configResponse.status !== 200) {
    return { ok: false, state: "failed", status: configResponse.status, reason: "free-config-unavailable" };
  }
  if (config?.accessPolicy !== "non-economic") {
    return { ok: false, state: "failed", status: 200, reason: "free-app-not-non-economic" };
  }
  const providerId = config.providerId ?? config.providers?.[0]?.providerId;
  const profileId = config.profileId ?? config.providers?.[0]?.profileIds?.[0];
  if (typeof providerId !== "string" || typeof profileId !== "string") {
    return { ok: false, state: "failed", status: 200, reason: "free-config-missing-route" };
  }

  let capability;
  try {
    const sessionResponse = await postJson(fetchImpl, `${endpoints.freeBaseUrl}/v1/sessions`, {}, { timeoutMs });
    const session = await responseJson(sessionResponse);
    if (sessionResponse.status !== 201 || typeof session?.capability !== "string") {
      return { ok: false, state: "failed", status: sessionResponse.status, reason: "free-session-unavailable" };
    }
    capability = session.capability;
    const request = {
      version: "1",
      nonce: randomBytes(32).toString("hex"),
      providerId,
      profileId,
      prompt: FREE_PROBE_PROMPT,
      maxOutputTokens: 1,
      seed: 0,
      sampling: "greedy",
      publishConsent: false,
    };
    const quoteResponse = await postJson(
      fetchImpl,
      `${endpoints.freeBaseUrl}/v1/quotes`,
      { request },
      { capability, timeoutMs },
    );
    const quote = await responseJson(quoteResponse);
    if (
      quoteResponse.status !== 201 ||
      quote?.amountBaseUnits !== "0" ||
      quote?.providerId !== providerId ||
      quote?.profileId !== profileId
    ) {
      return { ok: false, state: "failed", status: quoteResponse.status, reason: "zero-value-quote-invalid" };
    }
    return { ok: true, state: "ok", status: 201, amountBaseUnits: "0" };
  } finally {
    if (capability) {
      const revoke = await postJson(
        fetchImpl,
        `${endpoints.freeBaseUrl}/v1/sessions/revoke`,
        {},
        { capability, timeoutMs },
      );
      await revoke.arrayBuffer();
      if (revoke.status !== 204) throw new Error("FREE_SESSION_REVOKE_FAILED");
    }
  }
}

function dnsResolutionFailure(error) {
  const text = `${error?.code ?? ""} ${error?.cause?.code ?? ""} ${error?.message ?? ""}`;
  return /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text);
}

async function checkTeeAttestation({ fetchImpl, endpoints, timeoutMs, now, teeFreshnessMs, env }) {
  let response;
  try {
    response = await fetchResponse(fetchImpl, endpoints.verifierUrl, {}, timeoutMs);
  } catch (error) {
    if (env.W6_TEE_MONITOR_ENABLED !== "1" && dnsResolutionFailure(error)) {
      return { ok: true, state: "not-deployed" };
    }
    throw error;
  }
  const body = await responseJson(response);
  if (response.status !== 200) {
    return { ok: false, state: "failed", status: response.status, reason: `status-${response.status}` };
  }
  const freshness = evaluateFreshness({
    payload: body,
    responseDate: null,
    now,
    maxAgeMs: teeFreshnessMs,
  });
  if (!freshness.ok) {
    return { ok: false, state: "failed", status: 200, reason: `attestation-${freshness.reason}` };
  }
  return { ok: true, state: "ok", status: 200, freshness };
}

async function checkSponsorBalance({ fetchImpl, endpoints, timeoutMs, env }) {
  const accountId = env.W6_DEMO_SPONSOR_ACCOUNT_ID;
  if (!accountId) return { ok: true, state: "not-configured" };
  if (!/^0\.0\.[0-9]+$/.test(accountId)) {
    return { ok: false, state: "failed", reason: "account-id-invalid" };
  }
  const response = await fetchResponse(
    fetchImpl,
    `${endpoints.mirrorBaseUrl}/${encodeURIComponent(accountId)}`,
    {},
    timeoutMs,
  );
  const body = await responseJson(response);
  if (response.status !== 200 || !body?.balance || !/^-?[0-9]+$/.test(String(body.balance.balance))) {
    return { ok: false, state: "failed", status: response.status, reason: "mirror-balance-invalid" };
  }
  const balance = BigInt(String(body.balance.balance));
  const threshold = env.W6_DEMO_SPONSOR_MIN_TINYBAR;
  if (threshold !== undefined && !/^[0-9]+$/.test(threshold)) {
    return { ok: false, state: "failed", status: 200, reason: "balance-threshold-invalid" };
  }
  if (threshold !== undefined && balance < BigInt(threshold)) {
    return { ok: false, state: "failed", status: 200, reason: "balance-below-threshold", balanceTinybar: balance.toString() };
  }
  return { ok: true, state: "ok", status: 200, balanceTinybar: balance.toString() };
}

function metricsEndpoint(config) {
  const match = String(config).match(/^\s*metrics\s*:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/m);
  if (!match) return null;
  const value = match[1];
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

async function checkTunnelConnectors({ fetchImpl, timeoutMs, tunnelConfigFile }) {
  let config;
  try {
    config = await readFile(tunnelConfigFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, state: "config-not-found" };
    throw error;
  }
  const endpoint = metricsEndpoint(config);
  if (!endpoint) return { ok: true, state: "metrics-not-enabled" };
  const response = await fetchResponse(fetchImpl, endpoint, {}, timeoutMs);
  const body = await responseText(response);
  if (response.status !== 200) {
    return { ok: false, state: "failed", status: response.status, reason: `metrics-status-${response.status}` };
  }
  let connectors = 0;
  let found = false;
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^cloudflared_tunnel_ha_connections(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?)(?:\s|$)/);
    if (match) {
      found = true;
      connectors += Number(match[1]);
    }
  }
  if (!found) return { ok: false, state: "failed", status: 200, reason: "connector-metric-missing" };
  if (connectors < 1) return { ok: false, state: "failed", status: 200, reason: "no-tunnel-connectors", connectors };
  return { ok: true, state: "ok", status: 200, connectors };
}

async function safeCheck(name, operation) {
  try {
    return [name, await operation()];
  } catch (error) {
    return [name, { ok: false, state: "failed", reason: error?.name === "TimeoutError" ? "timeout" : "request-error", errorCode: error?.cause?.code ?? error?.code ?? null }];
  }
}

export async function appendStateHistory(stateFile, entry, limit = DEFAULT_HISTORY_LIMIT) {
  let history = [];
  try {
    const existing = JSON.parse(await readFile(stateFile, "utf8"));
    if (existing?.version === 1 && Array.isArray(existing.history)) history = existing.history;
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  history.push(entry);
  history = history.slice(-limit);
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, history }, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, stateFile);
}

function escapeAppleScript(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function macOSNotification({ title, message }) {
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`OSASCRIPT_EXIT_${code}`))));
  });
}

export async function deliverAlerts(report, { env = process.env, fetchImpl = fetch, notify = macOSNotification } = {}) {
  const summary = report.failures.map((failure) => `${failure.check}:${failure.reason}`).join(", ").slice(0, 500);
  const outcome = { notification: "not-attempted", webhook: env.W6_ALERT_WEBHOOK_URL ? "not-attempted" : "not-configured" };
  try {
    await notify({ title: "Mycelium W6 monitor", message: `Availability failure: ${summary}` });
    outcome.notification = "sent";
  } catch {
    outcome.notification = "failed";
  }
  if (env.W6_ALERT_WEBHOOK_URL) {
    try {
      const response = await fetchResponse(
        fetchImpl,
        env.W6_ALERT_WEBHOOK_URL,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "w6-monitor-alert", checkedAt: report.checkedAt, failures: report.failures }),
        },
        DEFAULT_TIMEOUT_MS,
      );
      await response.arrayBuffer();
      outcome.webhook = response.ok ? "sent" : `failed-status-${response.status}`;
    } catch {
      outcome.webhook = "failed";
    }
  }
  return outcome;
}

export async function runMonitor({
  env = process.env,
  endpoints = DEFAULT_ENDPOINTS,
  fetchImpl = fetch,
  notify = macOSNotification,
  stateFile = env.W6_MONITOR_STATE_FILE ?? DEFAULT_STATE_FILE,
  tunnelConfigFile = env.W6_CLOUDFLARED_CONFIG ?? join(homedir(), ".cloudflared/mycelium-demo.yml"),
  now = Date.now(),
} = {}) {
  const timeoutMs = integerSetting(env.W6_MONITOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const freshnessMs = integerSetting(env.W6_RUNTIME_STATUS_MAX_AGE_MS, DEFAULT_FRESHNESS_MS);
  const teeFreshnessMs = integerSetting(env.W6_TEE_ATTESTATION_MAX_AGE_MS, DEFAULT_TEE_FRESHNESS_MS);
  const operations = [
    safeCheck("offHost", () => checkOffHost({ fetchImpl, endpoints, timeoutMs })),
    safeCheck("edge", () => checkEdge({ fetchImpl, endpoints, timeoutMs })),
    safeCheck("paidHealth", () => checkPaidHealth({ fetchImpl, endpoints, timeoutMs })),
    safeCheck("runtimeStatus", () => checkRuntimeStatus({ fetchImpl, endpoints, timeoutMs, now, freshnessMs })),
    safeCheck("freeQuote", () => checkFreeQuote({ fetchImpl, endpoints, timeoutMs })),
    safeCheck("teeAttestation", () => checkTeeAttestation({ fetchImpl, endpoints, timeoutMs, now, teeFreshnessMs, env })),
    safeCheck("sponsorBalance", () => checkSponsorBalance({ fetchImpl, endpoints, timeoutMs, env })),
    safeCheck("tunnelConnectors", () => checkTunnelConnectors({ fetchImpl, timeoutMs, tunnelConfigFile })),
  ];
  const checks = Object.fromEntries(await Promise.all(operations));
  const failures = Object.entries(checks)
    .filter(([, result]) => !result.ok)
    .map(([check, result]) => ({ check, reason: result.reason ?? result.state ?? "failed" }));
  const report = {
    version: 1,
    checkedAt: new Date(now).toISOString(),
    ok: failures.length === 0,
    failures,
    checks,
  };
  if (!report.ok) report.alerts = await deliverAlerts(report, { env, fetchImpl, notify });
  await appendStateHistory(stateFile, report, DEFAULT_HISTORY_LIMIT);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--loop")) throw new Error("Usage: node composition/w6-monitor.mjs [--loop]");
  const loop = args.includes("--loop");
  const intervalMs = integerSetting(process.env.W6_MONITOR_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  do {
    const report = await runMonitor();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!loop) {
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "monitor-error", reason: error?.message ?? String(error) })}\n`);
    process.exitCode = 1;
  });
}
