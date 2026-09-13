import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { redactSensitive } from "./safety.mjs";

const W = "/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench";
const RUN = "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z";
const PAID_ROOT = join(RUN, "application-live-paid-01");
const IDENTITY = join(RUN, "identities/node-0.key");
const MONITOR_STATE = join(W, "artifacts/w6-v2/monitor/state.json");
const PROFILE_MAP = join(W, "composition/w6-verifier-profiles.json");
const ATTESTATION_VERIFICATION = join(W, "artifacts/w6-v2/l4/attestation-verification.json");
const EXPECTED_TEE_IMAGE_DIGEST_PREFIX = "sha256:35fec927";
const GRAPH_ENDPOINT = "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const MIRROR_ACCOUNTS = "https://testnet.mirrornode.hedera.com/api/v1/accounts";
const HEALTH_PORTS = Object.freeze([4350, 4351, 4352, 8791]);
const REQUIRED_CONFIRMATIONS = 12;
const UNAVAILABLE = "unavailable";

export const available = (value) => ({ available: true, value });
export const unavailable = (reason) => ({ available: false, reason });
const evidence = (id, label = "Open supporting panel") => ({ label, href: `/console#${id}` });
const panel = (id, title, status, data, reason) => ({ id, title, status, boundary: status === UNAVAILABLE ? UNAVAILABLE : "real", ...(reason ? { reason } : {}), data });

function truthy(env, key) { return env?.[key] === "1"; }
function boolRow(id, label, enabled, reason, evidenceId) {
  return { id, label, enabled: enabled === true, state: enabled === true ? "on" : "off", reason, evidence: evidence(evidenceId) };
}

export function buildCapabilityPanel({ ownerConsoleServing = false, service = {}, native = {}, graph = {}, verifier = {}, stakes = {}, env = process.env } = {}) {
  const demo = truthy(env, "W6_DEMO_SPONSOR_ENABLED") && /^0\.0\.\d+$/.test(env.W6_DEMO_SPONSOR_ACCOUNT ?? "") && service.paidHealthy === true;
  const route = native.routeReady === true && native.nodesLive === true;
  const pq1 = native.parity?.PQ1 === "qualified";
  const pq2 = native.parity?.PQ2 === "qualified";
  const pq3 = native.parity?.PQ3 === "qualified";
  const localOrTee = ["local", "tee"].includes(verifier.mode);
  const graphStats = graph.policyReady === true;
  const escrow = truthy(env, "W6_ESCROW_ENABLED") && truthy(env, "W6_ESCROW_G14_PASSED");
  const staking = truthy(env, "W6_STAKING_ENABLED") && graphStats && stakes.available === true;
  const rows = [
    boolRow("demo-sponsored-payment", "DEMO sponsored payment", demo, demo ? "Explicit sponsor flag, account identity, and paid health probe are present." : "Off until OT1 + G01: explicit sponsor enablement, configured account, and healthy paid service are all required.", "service-health"),
    boolRow("hedera-wallet", "Hedera wallet", truthy(env, "W6_HEDERA_WALLET_ENABLED") && truthy(env, "W6_WALLET_W2_PASSED"), "Requires W2 live wallet pass; otherwise use DEMO because signing support is not qualified.", "service-health"),
    boolRow("0.5b-distributed", "0.5B distributed", route, route ? "Native route qualification and both node probes are live." : "Swarm node offline or native route is not currently qualification-ready; never rerouted.", "native-route"),
    boolRow("0.5b-audits", "0.5B audits", route && pq1 && verifier.profile05Audit === true, "Requires TN2 + PQ1 + a pinned 0.5B verifier service; otherwise audits are unavailable for this model.", "native-route"),
    boolRow("0.5b-ensemble", "0.5B ensemble", verifier.profile05Ensemble === true && truthy(env, "W6_05B_ENSEMBLE_V6_PASSED"), "Requires V6 current-int8 trained bundle; random audits do not imply ensemble availability.", "verifier-status"),
    boolRow("27b-hosted", "27B hosted", truthy(env, "W6_27B_ENABLED") && truthy(env, "W6_27B_M2_PASSED"), "Hidden until the M2 admission gate passes.", "native-route"),
    boolRow("27b-audits-ensemble", "27B audits + ensemble", pq3 && verifier.profile27Audit === true && truthy(env, "W6_27B_M2_PASSED"), "Requires V8 plus the M2/PQ3 reference audit.", "verifier-status"),
    boolRow("tee", "TEE", verifier.mode === "tee" && verifier.attestationVerified === true && truthy(env, "W6_TEE_G11_PASSED"), "Requires T2/T3/T6 and G11; local verifier is explicitly not TEE.", "verifier-status"),
    boolRow("escrow", "Escrowed payouts", escrow, "Requires X0–X3 and G14; otherwise payments are direct and labelled no escrow.", "request-timeline"),
    boolRow("staking", "Staking / eligibility", staking, "Requires X1 + X4 + G15 with fresh Graph ledger data.", "stakes"),
    boolRow("slashing", "Slashing", staking && truthy(env, "W6_SLASHING_ENABLED") && truthy(env, "W6_SLASHING_G16_PASSED") && (pq1 || pq2 || pq3), "Requires X1–X5 + G16 and is enabled only per parity-qualified profile.", "stakes"),
    boolRow("graph-stats", "Graph stats", graphStats, graphStats ? "G1/G2 endpoint is fresh enough for the 12-confirmation policy." : "Stats unavailable until G1/G2/G17 are live and fresh.", "graph-freshness"),
    boolRow("owner-console", "Owner console", ownerConsoleServing, ownerConsoleServing ? "This loopback-only process is serving the console." : "OT2 console process is not serving.", "service-health"),
    boolRow("judge-package", "Judge package", truthy(env, "W6_JUDGE_PACKAGE_ENABLED") && truthy(env, "W6_A8_J3_PASSED"), "Requires A8 + J3; otherwise Mac package is coming soon and the hosted demo remains available.", "native-route"),
    boolRow("judge-swarm-audits", "Judge swarm audits", truthy(env, "W6_JUDGE_AUDITS_ENABLED") && pq2, "Requires J1 + PQ2 + G12; swarm execution does not imply audit availability.", "native-route"),
  ];
  return panel("capabilities", "Capability / flag matrix", "available", { rows });
}

async function defaultCommand(name) {
  if (name === "launchctl") return runCommand("/bin/launchctl", ["list"], 1200);
  if (name === "cloudflared") return runCommand("/opt/homebrew/bin/cloudflared", ["tunnel", "--output", "json", "info", "mycelium-demo"], 3500);
  return unavailable("command not allowlisted");
}

function runCommand(file, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { if (bytes < 1_048_576) { chunks.push(chunk); bytes += chunk.length; } });
    child.once("error", (error) => { clearTimeout(timer); resolve(unavailable(error.code ?? "command unavailable")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(available(Buffer.concat(chunks).toString("utf8")));
      else resolve(unavailable(signal === "SIGKILL" ? "command timeout" : `command exit ${code}`));
    });
  });
}

function defaultProbeHttp(port) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/healthz", method: "GET", headers: { host: `127.0.0.1:${port}` } }, (response) => {
      response.on("data", (chunk) => { if (bytes < 64 * 1024) { chunks.push(chunk); bytes += chunk.length; } });
      response.once("end", () => resolve(available({ status: response.statusCode ?? null, body: redactSensitive(Buffer.concat(chunks).toString("utf8")).slice(0, 500) })));
    });
    request.setTimeout(900, () => request.destroy(new Error("timeout")));
    request.once("error", (error) => resolve(unavailable(error.message === "timeout" ? "timeout" : (error.code ?? "connection failed"))));
    request.end();
  });
}

async function defaultReadJson(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 2 * 1024 * 1024) return unavailable("file too large");
    return available(JSON.parse(bytes.toString("utf8")));
  } catch (error) { return unavailable(error.code === "ENOENT" ? "not recorded" : "invalid or unreadable JSON"); }
}

export async function collectServiceHealth({ command = defaultCommand, probeHttp = defaultProbeHttp, readJson = defaultReadJson } = {}) {
  const [launch, tunnel, monitor, ...probes] = await Promise.all([
    command("launchctl"), command("cloudflared"), readJson(MONITOR_STATE), ...HEALTH_PORTS.map((port) => probeHttp(port)),
  ]);
  const launchd = launch.available ? launch.value.split(/\r?\n/).filter((line) => /mycelium/i.test(line)).map((line) => {
    const [pid, exitCode, label] = line.trim().split(/\s+/);
    return { label, pid: pid === "-" ? null : Number(pid), lastExitCode: Number(exitCode) };
  }).filter((row) => row.label) : [];
  let tunnelConnectors = null;
  if (tunnel.available) { try { tunnelConnectors = JSON.parse(tunnel.value).conns?.length ?? null; } catch {} }
  const health = probes.map((result, index) => ({ port: HEALTH_PORTS[index], ...(result.available ? result.value : { state: UNAVAILABLE, reason: result.reason }) }));
  const history = monitor.available && Array.isArray(monitor.value?.history) ? monitor.value.history : [];
  const lastMonitorRun = history.at(-1) ?? null;
  const paidHealthy = health.find((row) => row.port === 4352)?.status === 200;
  const degraded = health.some((row) => row.status !== 200) || launchd.some((row) => row.lastExitCode !== 0);
  return panel("service-health", "Service health", degraded ? "degraded" : "available", {
    launchd, launchctlState: launch.available ? "available" : UNAVAILABLE, health, tunnelConnectors,
    tunnelState: tunnelConnectors === null ? UNAVAILABLE : "available",
    tunnelReason: tunnelConnectors === null ? (tunnel.reason ?? "connector query returned no count") : null,
    lastMonitorRun,
    lastMonitorState: lastMonitorRun ? "available" : UNAVAILABLE,
    lastMonitorReason: lastMonitorRun ? null : (monitor.reason ?? "monitor has no recorded run"), paidHealthy,
  });
}

async function defaultFileMeta(path) {
  try { const s = await lstat(path); return available({ present: s.isFile() && !s.isSymbolicLink(), mode: (s.mode & 0o777).toString(8).padStart(4, "0"), size: s.size, modifiedAt: s.mtime.toISOString() }); }
  catch (error) { return unavailable(error.code === "ENOENT" ? "identity artifact not present" : "identity metadata unavailable"); }
}

function defaultTcpProbe({ host, port }) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(available({ alive: false, reason: "timeout" })); }, 700);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(available({ alive: true })); });
    socket.once("error", (error) => { clearTimeout(timer); resolve(available({ alive: false, reason: error.code ?? "connect failed" })); });
  });
}

async function fetchJson(url, init = {}, timeoutMs = 1200) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) return unavailable("response too large");
    let body; try { body = text ? JSON.parse(text) : null; } catch { return unavailable(`HTTP ${response.status}: invalid JSON`); }
    return response.ok ? available(body) : unavailable(`HTTP ${response.status}`);
  } catch (error) { return unavailable(error?.name === "TimeoutError" ? "timeout" : (error?.cause?.code ?? "request unavailable")); }
}

async function defaultQualification() {
  const tokenPath = join(RUN, "native-preparation-01/request-gateway-token.txt");
  let bearer;
  try { bearer = (await readFile(tokenPath, "utf8")).trim(); } catch { return unavailable("gateway credential unavailable for local qualification probe"); }
  const result = await fetchJson("http://127.0.0.1:8791/v1/qualification/current", { headers: { authorization: `Bearer ${bearer}` } }, 900);
  bearer = null;
  if (!result.available) return result;
  const q = result.value ?? {};
  return available({ route_ready: q.route_ready === true, evidence_class: typeof q.evidence_class === "string" ? q.evidence_class : null, binding: { model_id: typeof q.binding?.model_id === "string" ? q.binding.model_id : null, resolved_commit: typeof q.binding?.resolved_commit === "string" ? q.binding.resolved_commit.slice(0, 12) : null, qualification_digest: typeof q.binding?.qualification_digest === "string" ? q.binding.qualification_digest : null, manifest_digest: typeof q.binding?.manifest_digest === "string" ? q.binding.manifest_digest : null }, observed_at: typeof q.observed_at === "string" ? q.observed_at : null, reason_codes: Array.isArray(q.reason_codes) ? q.reason_codes.map(String).slice(0, 20) : [] });
}

async function defaultPqStatus(id) {
  const dir = join(W, `artifacts/w6-v2/${id.toLowerCase()}`);
  let files;
  try { files = (await readdir(dir, { recursive: true })).filter((x) => x.endsWith(".json")); } catch { return unavailable(`${id} not run — coming online after W3-F`); }
  for (const relative of files.reverse()) {
    const result = await defaultReadJson(join(dir, relative));
    if (!result.available) continue;
    const value = result.value;
    const qualified = value?.qualified === true || value?.passed === true || /^(qualified|passed)$/i.test(value?.status ?? value?.result ?? "");
    return available({ status: qualified ? "qualified" : "not-qualified", observedAt: value?.observedAt ?? value?.checkedAt ?? null, matches: Number.isInteger(value?.matches) ? value.matches : null, total: Number.isInteger(value?.total) ? value.total : null });
  }
  return unavailable(`${id} has no readable receipt — coming online after W3-F`);
}

export async function collectNativeRoute({ fileMeta = defaultFileMeta, tcpProbe = defaultTcpProbe, qualification = defaultQualification, pqStatus = defaultPqStatus } = {}) {
  const [identity, gateway, node0, node2, pq1, pq2, pq3] = await Promise.all([
    fileMeta(IDENTITY), tcpProbe({ label: "gateway", host: "127.0.0.1", port: 8791 }), tcpProbe({ label: "node-0", host: "100.84.252.4", port: 8876 }), tcpProbe({ label: "node-2-sidecar", host: "127.0.0.1", port: 8877 }), pqStatus("PQ1"), pqStatus("PQ2"), pqStatus("PQ3"),
  ]);
  const q = await qualification();
  const safeQualification = q.available ? { routeReady: q.value.route_ready === true, evidenceClass: q.value.evidence_class ?? null, modelId: q.value.binding?.model_id ?? null, resolvedCommit: q.value.binding?.resolved_commit ?? null, observedAt: q.value.observed_at ?? null } : { routeReady: false, state: UNAVAILABLE, reason: q.reason };
  const parity = Object.fromEntries([["PQ1", pq1], ["PQ2", pq2], ["PQ3", pq3]].map(([id, result]) => [id, result.available ? result.value.status : UNAVAILABLE]));
  const parityDetails = Object.fromEntries([["PQ1", pq1], ["PQ2", pq2], ["PQ3", pq3]].map(([id, result]) => [id, result.available ? result.value : { state: UNAVAILABLE, reason: result.reason }]));
  const nodes = { gateway: gateway.available ? gateway.value : { alive: false, reason: gateway.reason }, node0: node0.available ? node0.value : { alive: false, reason: node0.reason }, node2: node2.available ? node2.value : { alive: false, reason: node2.reason } };
  return panel("native-route", "Native route qualification + node status", q.available || identity.available ? (safeQualification.routeReady && nodes.node0.alive && nodes.node2.alive ? "available" : "degraded") : UNAVAILABLE, {
    identity: identity.available ? identity.value : { state: UNAVAILABLE, reason: identity.reason }, route: safeQualification, nodes, parity, parityDetails,
    routeReady: safeQualification.routeReady, nodesLive: nodes.node0.alive === true && nodes.node2.alive === true,
  }, q.available || identity.available ? undefined : "Native route evidence is unavailable");
}

function safeJson(value) { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } }
function openReadonlyDatabases() {
  const require = createRequire(join(W, "packages/payments/package.json"));
  const Database = require("better-sqlite3");
  const result = { quotes: [], payments: [], jobs: [], observations: [], escrow: [], scores: [], audits: [] };
  if (!existsSync(join(PAID_ROOT, "core.sqlite"))) return unavailable("paid core store not present");
  const core = new Database(join(PAID_ROOT, "core.sqlite"), { readonly: true, fileMustExist: true });
  try {
    for (const row of core.prepare("SELECT id,value FROM records WHERE namespace='jobs' ORDER BY id DESC LIMIT 50").all()) {
      const rec = safeJson(row.value); const job = rec?.job ?? {};
      const eventsRaw = core.prepare("SELECT value FROM records WHERE namespace='events' AND id=?").get(row.id);
      const events = safeJson(eventsRaw?.value)?.items ?? [];
      const deltas = events.filter((e) => e?.type === "delta" && Array.isArray(e?.data?.tokenIds));
      result.jobs.push({ jobId: job.jobId ?? row.id, quoteId: job.payment?.quoteId ?? null, paymentId: job.payment?.paymentId ?? null, executionStatus: job.executionStatus ?? "unknown", createdAt: job.createdAt ?? null, updatedAt: job.updatedAt ?? null, receiptDigest: job.receiptDigest ?? null, tokenIdsPresent: deltas.some((e) => e.data.tokenIds.length > 0), tokenIdCount: deltas.reduce((sum, e) => sum + e.data.tokenIds.length, 0) });
    }
  } finally { core.close(); }
  const providerRoot = join(PAID_ROOT, "providers");
  if (existsSync(providerRoot)) {
    for (const directory of require("node:fs").readdirSync(providerRoot)) {
      const path = join(providerRoot, directory, "payments.sqlite");
      if (!existsSync(path)) continue;
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        for (const row of db.prepare("SELECT data FROM quotes ORDER BY rowid DESC LIMIT 50").all()) { const q = safeJson(row.data)?.quote; if (q) result.quotes.push({ quoteId: q.quoteId, providerId: q.providerId, profileId: q.profileId, amountBaseUnits: q.amountBaseUnits, network: q.network, asset: q.asset, expiresAt: q.expiresAt }); }
        for (const row of db.prepare("SELECT data FROM payments ORDER BY rowid DESC LIMIT 50").all()) { const p = safeJson(row.data); if (p?.payment) result.payments.push({ paymentId: p.payment.paymentId, quoteId: p.payment.quoteId, transactionId: p.transactionId ?? p.payment.transactionRef ?? null, status: p.payment.status ?? p.phase ?? "unknown", failureCode: p.payment.failureCode ?? null }); }
      } finally { db.close(); }
    }
  }
  const configuredState = process.env.W6_APP_STATE_DIR;
  const allowedState = configuredState && (configuredState === RUN || configuredState.startsWith(`${RUN}/`) || configuredState.startsWith(`${join(W, "artifacts")}/`));
  const observationCandidates = [allowedState && join(configuredState, "verifier-observations.json"), join(PAID_ROOT, "verifier-observations.json")].filter(Boolean);
  for (const path of observationCandidates) {
    if (!existsSync(path)) continue;
    const journal = safeJson(require("node:fs").readFileSync(path, "utf8"));
    for (const [requestId, entry] of Object.entries(journal?.observations ?? {})) result.observations.push({ requestId, providerId: entry?.providerId ?? null, randomSelected: entry?.receipt?.random_selected === true, auditIds: Array.isArray(entry?.receipt?.audit_ids) ? entry.receipt.audit_ids.map(String).slice(0, 20) : [] });
    break;
  }
  return available(result);
}

function stateStep(id, label, state, detail = null) { return { id, label, state, ...(detail !== null ? { detail } : {}) }; }
export async function collectTimeline({ timelineSources = async () => { try { return openReadonlyDatabases(); } catch { return unavailable("payment store or verifier observation log is unreadable"); } } } = {}) {
  const source = await timelineSources();
  if (!source.available) return panel("request-timeline", "Per-request timeline", UNAVAILABLE, { requests: [] }, `${source.reason}; coming online when retained stores are mounted`);
  const data = source.value;
  const paymentsByQuote = new Map(data.payments.map((x) => [x.quoteId, x]));
  const jobsByQuote = new Map(data.jobs.filter((x) => x.quoteId).map((x) => [x.quoteId, x]));
  const observationsByRequest = new Map(data.observations.map((x) => [x.requestId, x]));
  const requests = data.quotes.map((quote) => {
    const payment = paymentsByQuote.get(quote.quoteId); const job = jobsByQuote.get(quote.quoteId); const observation = job ? observationsByRequest.get(job.jobId) : null;
    const escrow = data.escrow.find((x) => x.paymentId === payment?.paymentId); const score = data.scores.find((x) => x.requestId === job?.jobId); const audit = data.audits.find((x) => x.requestId === job?.jobId || observation?.auditIds?.includes(x.auditId));
    const settlement = escrow && ["RELEASED", "REFUNDED", "RELEASED_UNVERIFIED"].includes(escrow.state) ? escrow.state : UNAVAILABLE;
    return { quoteId: quote.quoteId, providerId: quote.providerId, profileId: quote.profileId, amountBaseUnits: quote.amountBaseUnits, hasActivity: Boolean(payment || job), timeline: [
      stateStep("quote", "Quote", "recorded", quote.expiresAt ?? null),
      stateStep("payment", "Payment tx", payment ? payment.status : UNAVAILABLE, payment?.transactionId ?? null),
      stateStep("escrow", "Escrow state", escrow?.state ?? UNAVAILABLE, escrow ? null : "unavailable — coming online after X3"),
      stateStep("stream", "Stream", job?.executionStatus ?? UNAVAILABLE, job?.updatedAt ?? null),
      stateStep("token-ids", "Token IDs present?", job ? (job.tokenIdsPresent ? "present" : "absent") : UNAVAILABLE, job ? `${job.tokenIdCount ?? 0} observed IDs` : null),
      stateStep("observation", "Observation", observation ? "recorded" : UNAVAILABLE, observation ? (observation.randomSelected ? "random audit selected" : "not randomly selected") : "verifier observation not recorded"),
      stateStep("score", "Score", score?.state ?? UNAVAILABLE, score?.summary ?? "unavailable — coming online after V8"),
      stateStep("audit", "Audit", audit?.state ?? (observation?.auditIds?.length ? "selected" : UNAVAILABLE), audit?.auditId ?? observation?.auditIds?.[0] ?? "unavailable — no terminal audit record"),
      stateStep("settlement", "Release / refund", settlement, settlement === UNAVAILABLE ? "unavailable — coming online after X3" : null),
    ] };
  }).sort((a, b) => Number(b.hasActivity) - Number(a.hasActivity)).slice(0, 30).map(({ hasActivity, ...request }) => request);
  return panel("request-timeline", "Per-request timeline", "available", { requests, source: "read-only payment SQLite + core event store + verifier observation journal when present", emptyReason: requests.length ? null : "No retained quotes are present." });
}

async function defaultReadProfiles() { return defaultReadJson(PROFILE_MAP); }
async function defaultObservationSummary() {
  const source = openReadonlyDatabases();
  if (!source.available) return source;
  return available({ completed: source.value.observations.length, pending: null });
}
async function defaultAttestation(env) {
  if (!env.W6_VERIFIER_TEE_URL) return unavailable("TEE not configured — coming online after T3/T6");
  let base;
  try { base = new URL(env.W6_VERIFIER_TEE_URL); } catch { return unavailable("TEE URL is invalid"); }
  if (base.protocol !== "https:" || base.username || base.password) return unavailable("TEE URL must be credential-free HTTPS");
  const url = new URL("/attestation", base);
  const result = await fetchJson(url, {}, 1200); if (!result.available) return result;
  const b = result.value ?? {}; const claims = b.claims ?? b.attestation ?? b;
  return available({ verified: b.verified === true, issuedAt: claims.issuedAt ?? claims.iat ?? null, expiresAt: claims.expiresAt ?? claims.exp ?? null, hwmodel: claims.hwmodel ?? null, swname: claims.swname ?? null, dbgstat: claims.dbgstat ?? null, imageDigest: claims?.submods?.container?.image_digest ?? claims.imageDigest ?? null });
}
function probabilities(env) {
  if (!env.W6_VERIFIER_AUDIT_PROBABILITIES_JSON) return { state: UNAVAILABLE, reason: "per-provider scheduler probabilities unavailable — coming online after V7" };
  try { const value = JSON.parse(env.W6_VERIFIER_AUDIT_PROBABILITIES_JSON); const rows = Object.entries(value).filter(([provider, probability]) => typeof provider === "string" && Number.isFinite(probability) && probability >= 0 && probability <= 1).map(([provider, probability]) => ({ provider, probability })); return rows.length ? { state: "available", rows } : { state: UNAVAILABLE, reason: "no valid probability rows" }; } catch { return { state: UNAVAILABLE, reason: "probability configuration invalid" }; }
}
async function defaultReadAttestationVerification() { return defaultReadJson(ATTESTATION_VERIFICATION); }
function imageDigestFrom(value) {
  return value?.image_digest ?? value?.imageDigest ?? value?.claims?.image_digest ?? value?.claims?.imageDigest ?? value?.claims?.submods?.container?.image_digest ?? value?.attestation?.image_digest ?? value?.attestation?.imageDigest ?? null;
}
function imageDigestMatch(result) {
  if (!result.available) return { state: UNAVAILABLE, reason: result.reason, expectedImageDigestPrefix: EXPECTED_TEE_IMAGE_DIGEST_PREFIX, observedImageDigest: null, match: false };
  const observed = imageDigestFrom(result.value);
  if (typeof observed !== "string" || !observed) return { state: "absent", reason: "attestation image_digest absent", expectedImageDigestPrefix: EXPECTED_TEE_IMAGE_DIGEST_PREFIX, observedImageDigest: null, match: false };
  return { state: "available", expectedImageDigestPrefix: EXPECTED_TEE_IMAGE_DIGEST_PREFIX, observedImageDigest: observed, match: observed.startsWith(EXPECTED_TEE_IMAGE_DIGEST_PREFIX) };
}
export async function collectVerifierStatus({ env = process.env, readProfiles = defaultReadProfiles, readObservationSummary = defaultObservationSummary, attestation = () => defaultAttestation(env), qualification = defaultQualification, readAttestationVerification = defaultReadAttestationVerification } = {}) {
  const [profilesResult, observations, attestationResult, qualificationResult, attestationVerification] = await Promise.all([readProfiles(), readObservationSummary(), attestation(), qualification(), readAttestationVerification()]);
  const teeConfigured = Boolean(env.W6_VERIFIER_TEE_URL); const localConfigured = Boolean(env.W6_VERIFIER_LOCAL_CMD) || qualificationResult.available;
  const mode = teeConfigured ? "tee" : localConfigured ? "local" : UNAVAILABLE;
  const profiles = profilesResult.available ? profilesResult.value.profiles.map((row) => ({ id: row.id, referenceSamples: row.audits?.referenceSamples === true, ensembleScorer: row.audits?.ensembleScorer === true, pinned: typeof row.verifierProfileSha256 === "string", reason: row.pinReason })) : [];
  const attestationData = attestationResult.available ? { state: "available", ...attestationResult.value } : { state: UNAVAILABLE, reason: attestationResult.reason };
  const q = qualificationResult.available ? qualificationResult.value : null;
  const qualificationData = q ? { state: "available", routeReady: q.route_ready === true, evidenceClass: q.evidence_class ?? null, modelId: q.binding?.model_id ?? null, resolvedCommit: q.binding?.resolved_commit ?? null, qualificationDigest: q.binding?.qualification_digest ?? null, manifestDigest: q.binding?.manifest_digest ?? null, reasonCodes: q.reason_codes ?? [] } : { state: UNAVAILABLE, reason: qualificationResult.reason };
  const attestationVerificationData = attestationVerification.available ? { state: "available", path: ATTESTATION_VERIFICATION, value: attestationVerification.value } : { state: UNAVAILABLE, path: ATTESTATION_VERIFICATION, reason: attestationVerification.reason };
  return panel("verifier-status", "Verifier status", profilesResult.available ? (mode === UNAVAILABLE ? "degraded" : "available") : UNAVAILABLE, {
    mode, modeReason: mode === UNAVAILABLE ? "No local or TEE verifier transport is configured in this process." : mode === "tee" ? "TEE URL is configured; G11 remains separate." : "Local qualification endpoint is available (not TEE).",
    qualification: qualificationData,
    attestation: attestationData, attestationVerified: attestationData.verified === true,
    attestationVerification: attestationVerificationData, attestationImageDigestMatch: imageDigestMatch(attestationVerification),
    queueDepth: observations.available ? (observations.value.pending ?? UNAVAILABLE) : UNAVAILABLE,
    completedObservations: observations.available ? observations.value.completed : UNAVAILABLE,
    policyVersion: env.W6_VERIFIER_POLICY_VERSION || UNAVAILABLE,
    auditProbability: probabilities(env), profiles,
    profile05Audit: profiles.some((p) => /0\.5b/i.test(p.id) && p.referenceSamples && p.pinned),
    profile05Ensemble: profiles.some((p) => /0\.5b/i.test(p.id) && p.ensembleScorer && p.pinned),
    profile27Audit: profiles.some((p) => /27b/i.test(p.id) && p.referenceSamples && p.pinned),
  }, profilesResult.available ? undefined : profilesResult.reason);
}

async function defaultLedgerQuery(endpoint) {
  const query = `{ providers(first:50) { id stake requiredStake status slashCount } slashes(first:20, orderBy:blockNumber, orderDirection:desc) { id provider amount outcome blockNumber } requiredStakes(first:20, orderBy:blockNumber, orderDirection:desc) { id profile amount blockNumber } }`;
  const result = await fetchJson(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) }, 1400);
  if (!result.available || result.value?.errors) return unavailable(result.reason ?? "VerificationLedger schema not available");
  return available({ providers: result.value?.data?.providers ?? [], slashes: result.value?.data?.slashes ?? [], requiredStakes: result.value?.data?.requiredStakes ?? [] });
}
export async function collectStakes({ env = process.env, queryLedger = defaultLedgerQuery } = {}) {
  const endpoint = env.W6_VERIFICATION_LEDGER_GRAPH_ENDPOINT;
  if (!endpoint) return panel("stakes", "Stakes / required stake / slashes", UNAVAILABLE, { providers: [], slashes: [], requiredStakes: [] }, "unavailable — coming online after G1 VerificationLedger lands in Graph Studio");
  const result = await queryLedger(endpoint);
  return result.available ? panel("stakes", "Stakes / required stake / slashes", "available", result.value) : panel("stakes", "Stakes / required stake / slashes", UNAVAILABLE, { providers: [], slashes: [], requiredStakes: [] }, `${result.reason}; G1 ledger query unavailable`);
}

async function defaultGraphMeta() {
  const result = await fetchJson(GRAPH_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ _meta { block { number timestamp hash } hasIndexingErrors } }" }) }, 1300);
  if (!result.available || result.value?.errors || !Number.isInteger(result.value?.data?._meta?.block?.number)) return unavailable(result.reason ?? "Graph metadata unavailable");
  const meta = result.value.data._meta; return available({ indexedBlock: meta.block.number, indexedTimestamp: meta.block.timestamp ?? null, hasIndexingErrors: meta.hasIndexingErrors === true });
}
async function defaultChainHead() {
  const result = await fetchJson(SEPOLIA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }, 1300);
  if (!result.available || !/^0x[0-9a-f]+$/i.test(result.value?.result ?? "")) return unavailable(result.reason ?? "Sepolia head unavailable");
  return available(Number.parseInt(result.value.result, 16));
}
export async function collectGraphFreshness({ graphMeta = defaultGraphMeta, chainHead = defaultChainHead } = {}) {
  const [meta, head] = await Promise.all([graphMeta(), chainHead()]);
  if (!meta.available || !head.available) return panel("graph-freshness", "Graph freshness", UNAVAILABLE, {}, `unavailable — ${meta.reason ?? head.reason}`);
  const indexedBlock = meta.value.indexedBlock; const chainHeadBlock = head.value; const lagBlocks = Math.max(0, chainHeadBlock - indexedBlock); const safeBlock = Math.max(0, chainHeadBlock - REQUIRED_CONFIRMATIONS); const safeBlockIndexed = indexedBlock >= safeBlock;
  return panel("graph-freshness", "Graph freshness", meta.value.hasIndexingErrors ? "degraded" : "available", { indexedBlock, chainHeadBlock, lagBlocks, requiredConfirmations: REQUIRED_CONFIRMATIONS, safeBlock, safeBlockIndexed, hasIndexingErrors: meta.value.hasIndexingErrors, indexedTimestamp: meta.value.indexedTimestamp ?? null, policyReady: safeBlockIndexed && !meta.value.hasIndexingErrors && Boolean(process.env.W6_VERIFICATION_LEDGER_GRAPH_ENDPOINT) });
}

async function defaultMirrorAccount(accountId) { return fetchJson(`${MIRROR_ACCOUNTS}/${encodeURIComponent(accountId)}`, {}, 1300); }
export async function collectSponsorBalance({ env = process.env, mirrorAccount = defaultMirrorAccount } = {}) {
  const accountId = env.W6_DEMO_SPONSOR_ACCOUNT ?? env.W6_DEMO_SPONSOR_ACCOUNT_ID;
  if (!/^0\.0\.\d+$/.test(accountId ?? "")) return panel("sponsor-balance", "Sponsor balance", UNAVAILABLE, {}, "unavailable — DEMO sponsor account is not configured");
  const result = await mirrorAccount(accountId);
  const balance = result.value?.balance?.balance;
  if (!result.available || !/^-?\d+$/.test(String(balance ?? ""))) return panel("sponsor-balance", "Sponsor balance", UNAVAILABLE, { accountId }, `unavailable — ${result.reason ?? "mirror response missing balance"}`);
  return panel("sponsor-balance", "Sponsor balance", "available", { accountId, balanceTinybar: String(balance), consensusTimestamp: result.value.balance.timestamp ?? null, source: "Hedera testnet mirror node" });
}

async function defaultListLogs() {
  try { const names = (await readdir("/Users/evinova-self/Library/Logs")).filter((name) => /^mycelium-.*\.log$/.test(name)).map((name) => join("/Users/evinova-self/Library/Logs", name)); return names.length ? available(names) : unavailable("no matching logs"); }
  catch { return unavailable("log directory unavailable"); }
}
async function defaultTailLines(path) {
  const result = await runCommand("/usr/bin/tail", ["-n", "100", path], 900);
  return result.available ? available(result.value.split(/\r?\n/).filter(Boolean)) : result;
}
export async function collectRecentErrors({ listLogs = defaultListLogs, tailLines = defaultTailLines } = {}) {
  const files = await listLogs();
  if (!files.available) return panel("recent-errors", "Recent errors", UNAVAILABLE, { logs: [] }, files.reason);
  const results = await Promise.all(files.value.map(async (path) => [path, await tailLines(path)]));
  const logs = results.map(([path, result]) => ({ file: basename(path), state: result.available ? "available" : UNAVAILABLE, lines: result.available ? redactSensitive(result.value.join("\n")).split("\n") : [], ...(result.available ? {} : { reason: result.reason }) }));
  return panel("recent-errors", "Recent errors — last 100 lines per log", logs.some((x) => x.state === "available") ? "available" : UNAVAILABLE, { logs }, logs.some((x) => x.state === "available") ? undefined : "No readable logs");
}

export async function collectDashboard({ env = process.env } = {}) {
  const [service, native, verifier, stakes, graph, sponsor, timeline, errors] = await Promise.all([
    collectServiceHealth(), collectNativeRoute(), collectVerifierStatus({ env }), collectStakes({ env }), collectGraphFreshness(), collectSponsorBalance({ env }), collectTimeline(), collectRecentErrors(),
  ]);
  const capabilities = buildCapabilityPanel({ ownerConsoleServing: true, service: service.data, native: native.data, graph: graph.data, verifier: verifier.data, stakes: { available: stakes.status === "available" }, env });
  return { generatedAt: new Date().toISOString(), boundary: "No synthetic production data. Each value is live/read-only retained state or explicitly unavailable.", panels: [capabilities, service, native, timeline, verifier, stakes, graph, sponsor, errors] };
}
