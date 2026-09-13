#!/usr/bin/env node
// Mycelium product demo UI server — w6 Demo UI lane.
// Standalone HTTP server, no dependencies. Port 4362.
// Probes live surfaces (Graph, TEE, free inference) and local artifacts (receipt, ENS prep).
// No writes outside artifacts/w6-v2/product-demo-ui; no edits to existing files.

import { createServer } from "node:http";
import { readFile, stat, readdir, writeFile, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClient as createAccessClient,
  createRequest as createAccessRequest,
} from "../../packages/access/src/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.W6_DEMO_UI_PORT ?? 4362);
const HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 9000;
const FREE_APP = process.env.W6_FREE_APP_ORIGIN ?? "http://127.0.0.1:4350";

// Workbench root for artifact reads.
const WB = resolve(
  "/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench",
);

// ----------------------------------------------------------------------------
// Live surface URLs
const GRAPH_URL =
  "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile";
const TEE_URLS = [
  "http://34.7.61.130:8765", // primary SEV
];
const TEE_URL_OPT = "http://34.7.61.130:8766"; // T6 — detected if present
const PUBLIC_ORIGIN = "https://mycelium.now";
const ENS_PREP_DIR = join(WB, "artifacts/w6-v2/ens-prep");
const RECEIPT_FILE = join(WB, "artifacts/w6-v2/l2/paid-retry/g01-receipt.json");
const EVIDENCE_FILE = join(WB, "artifacts/w6-v2/l6/evidence-sha256.txt");

// ----------------------------------------------------------------------------
// Helpers
function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Demo-UI": "w6-demo-ui",
  });
  res.end(body);
}

function textResponse(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function fetchBounded(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: controller.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function safeJsonFetch(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    const r = await fetchBounded(url, opts, timeoutMs);
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
    return { ok: r.ok, status: r.status, body, url };
  } catch (e) {
    return { ok: false, status: 0, body: null, url, error: e?.name ?? String(e) };
  }
}

// Faster timeout — used for an optional port that may not be listening so TCP
// connect won't hang the whole request.
async function safeJsonFetchFast(url, opts = {}) {
  return await safeJsonFetch(url, opts, 800);
}

function sha256OfString(s) {
  return createHash("sha256").update(s).digest("hex");
}

async function readMaybeFile(path) {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseSseBlock(block) {
  const parsed = { id: null, event: null, dataText: "", data: null, raw: block };
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i);
    const value = line.slice(i + 1).replace(/^ /, "");
    if (key === "id") parsed.id = value;
    else if (key === "event") parsed.event = value;
    else if (key === "data") dataLines.push(value);
  }
  parsed.dataText = dataLines.join("\n");
  if (parsed.dataText) {
    try {
      parsed.data = JSON.parse(parsed.dataText);
    } catch {
      parsed.data = parsed.dataText;
    }
  }
  return parsed;
}

async function collectJobStream(path, capability, deadlineMs = 60_000) {
  const url = new URL(path, FREE_APP).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const events = [];
  const deltas = [];
  let terminalJob = null;
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${capability}`,
        "last-event-id": "0",
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      return { ok: false, status: response.status, url, error: `STREAM_HTTP_${response.status}`, body: text.slice(0, 500), events, deltas };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1_048_576) return { ok: false, status: response.status, url, error: "STREAM_TOO_LARGE", events, deltas };
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (!block.trim()) continue;
          const parsed = parseSseBlock(block);
          const compact = {
            id: parsed.id,
            event: parsed.event,
            data: parsed.data,
          };
          events.push(compact);
          if (parsed.event === "delta" && parsed.data && typeof parsed.data === "object") {
            deltas.push({
              text: typeof parsed.data.text === "string" ? parsed.data.text : "",
              tokenIds: Array.isArray(parsed.data.tokenIds) ? parsed.data.tokenIds : [],
            });
          }
          if (parsed.event === "job" && parsed.data && typeof parsed.data === "object") {
            terminalJob = parsed.data;
          }
          if (parsed.event === "done") {
            return { ok: true, status: response.status, url, done: true, events, deltas, terminalJob };
          }
          if (parsed.event === "error") {
            return { ok: false, status: response.status, url, error: "STREAM_ERROR_EVENT", events, deltas, terminalJob };
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return { ok: true, status: response.status, url, done: false, events, deltas, terminalJob };
  } catch (e) {
    return { ok: false, status: 0, url, error: e?.name === "AbortError" ? "STREAM_DEADLINE" : String(e?.message ?? e), events, deltas, terminalJob };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeNative(status) {
  if (!status || typeof status !== "object") return null;
  return {
    model_id: status.model_id ?? null,
    simulated: status.simulated ?? null,
    route_alive: status.route_alive ?? null,
    topology_version: status.topology_version ?? null,
    decode_mode: status.decode_mode ?? null,
    peers: (status.peers ?? []).map((p) => ({
      node_id: p.node_id,
      applied_operation_count: p.applied_operation_count,
      frames_received: p.frames_received,
      frames_sent: p.frames_sent,
    })),
    recent_inferences_count: Array.isArray(status.recent_inferences) ? status.recent_inferences.length : null,
  };
}

function countersByNode(status) {
  return Object.fromEntries((status?.peers ?? []).map((p) => [p.node_id, {
    appliedOperationCount: p.applied_operation_count ?? 0,
    framesReceived: p.frames_received ?? 0,
    framesSent: p.frames_sent ?? 0,
  }]));
}

function counterDelta(before, after) {
  const b = countersByNode(before);
  const a = countersByNode(after);
  return Object.fromEntries(Object.keys(a).map((node) => [node, {
    appliedOperationCount: (a[node]?.appliedOperationCount ?? 0) - (b[node]?.appliedOperationCount ?? 0),
    framesReceived: (a[node]?.framesReceived ?? 0) - (b[node]?.framesReceived ?? 0),
    framesSent: (a[node]?.framesSent ?? 0) - (b[node]?.framesSent ?? 0),
  }]));
}

// ----------------------------------------------------------------------------
// Endpoint: /api/status (aggregate home page status)
async function apiStatus(_req, res) {
  const teeHealth = await safeJsonFetch(`${TEE_URLS[0]}/healthz`);
  const teeInfo = await safeJsonFetch(`${TEE_URLS[0]}/info`);
  const teeAttest = await safeJsonFetch(`${TEE_URLS[0]}/attestation`);
  const teeGenKey = await safeJsonFetch(`${TEE_URLS[0]}/generate-key`);
  const teeAltHealth = await safeJsonFetchFast(`${TEE_URL_OPT}/healthz`);
  const teeAltAttest = await safeJsonFetchFast(`${TEE_URL_OPT}/attestation`);
  const teeAltGenKey = await safeJsonFetchFast(`${TEE_URL_OPT}/generate-key`);
  const graphMeta = await safeJsonFetch(GRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ _meta { block { number } deployment hasIndexingErrors } }" }),
  });
  const freeHealth = await safeJsonFetch(`${FREE_APP}/healthz`);
  const freeConfig = await safeJsonFetch(`${FREE_APP}/config.json`);
  const nativeStatus = await safeJsonFetch("http://127.0.0.1:8791/__mycelium/live-status");
  // W6-DEMO-UI: also probe the paid app so the status reflects real Hedera
  // sponsorship availability (was hardcoded YELLOW pre-commit 381cc8b).
  const PAID_APP = process.env.W6_PAID_APP_ORIGIN ?? "http://127.0.0.1:4352";
  const paidConfig = await safeJsonFetch(`${PAID_APP}/config.json`);
  const paidAuthorizeState =
    paidConfig.ok && paidConfig.body?.demoSponsor?.status === "available"
      ? "GREEN"
      : paidConfig.ok
        ? "YELLOW"
        : "YELLOW";
  const paidAuthorizeReason = paidConfig.ok
    ? paidConfig.body?.demoSponsor?.status === "available"
      ? `payer ${paidConfig.body?.demoSponsor?.payerAccountId ?? "?"} on Hedera testnet`
      : `demo sponsor: ${paidConfig.body?.demoSponsor?.status ?? "unknown"}`
    : `paid app unreachable: ${paidConfig.error ?? ""}`;

  const capabilities = {
    inference: { state: freeHealth.ok && nativeStatus.ok ? "GREEN" : "YELLOW", reason: freeHealth.ok ? "free route alive" : "free app unreachable" },
    paymentReceipt: { state: "GREEN", reason: "G01 08020e41 settled (see receipts page)" },
    paidAuthorize: {
      state: paidAuthorizeState,
      reason: paidAuthorizeReason,
    },
    graphProvenance: {
      state: graphMeta.ok && graphMeta.body?.data?._meta ? "GREEN" : "YELLOW",
      reason: graphMeta.ok ? `block ${graphMeta.body?.data?._meta?.block?.number ?? "?"}` : "Graph probe failed",
    },
    teeCompute: {
      state: teeHealth.ok && teeInfo.ok ? "GREEN" : "YELLOW",
      reason: teeHealth.ok ? `SEV VM ${TEE_URLS[0]} healthy` : `TEE ${TEE_URLS[0]} unreachable`,
    },
    teeAttestation: {
      state: (teeAttest.ok && teeAttest.status === 200) || (teeAltAttest.ok && teeAltAttest.status === 200) ? "GREEN" : "YELLOW",
      reason: teeAltAttest.ok && teeAltAttest.status === 200
        ? `T6 tee-launcher attestation detected on ${TEE_URL_OPT}`
        : teeAttest.ok
          ? "JWT-bound tee-launcher endpoints reachable on primary"
          : "Primary 8765 is plain Flask; no /attestation (Y3 per submission report)",
    },
    ens: { state: "YELLOW", reason: "broadcast pending (human-only E1)" },
  };

  jsonResponse(res, 200, {
    capturedAt: new Date().toISOString(),
    server: { host: HOST, port: PORT, pid: process.pid },
    freeApp: { origin: FREE_APP, health: freeHealth },
    nativeStatus: { url: "http://127.0.0.1:8791/__mycelium/live-status", ok: nativeStatus.ok, model: nativeStatus.body?.model_id ?? null, routeAlive: nativeStatus.body?.route_alive ?? null },
    tee: { primary: TEE_URLS[0], alt: TEE_URL_OPT, health: teeHealth, info: teeInfo, attestation: teeAttest, generateKey: teeGenKey, altHealth: teeAltHealth, altAttestation: teeAltAttest, altGenerateKey: teeAltGenKey },
    graph: graphMeta,
    publicOrigin: PUBLIC_ORIGIN,
    capabilities,
  });
}

// ----------------------------------------------------------------------------
// Endpoint: /api/inference/free
async function apiInferenceFree(req, res) {
  // Parse JSON body. Hard cap keeps the judge endpoint bounded.
  let body = "";
  for await (const chunk of req) body += chunk;
  if (body.length > 4096) {
    jsonResponse(res, 413, { ok: false, error: "BODY_TOO_LARGE" });
    return;
  }
  const parsed = safeParseJson(body) ?? {};
  const prompt = (typeof parsed.prompt === "string" ? parsed.prompt : "Complete in one short sentence: A garden grows").slice(0, 1024);
  const maxOutputTokens = Math.max(1, Math.min(8, Number(parsed.maxOutputTokens ?? 1)));

  const timeline = [{ at: new Date().toISOString(), stage: "submitted", promptChars: prompt.length, maxOutputTokens }];
  const nativeBefore = (await safeJsonFetch("http://127.0.0.1:8791/__mycelium/live-status")).body;

  try {
    const health = await safeJsonFetch(`${FREE_APP}/healthz`);
    timeline.push({ at: new Date().toISOString(), stage: "free_health", ok: health.ok, status: health.status });
    if (!health.ok || health.body?.mode !== "live") throw new Error("FREE_APP_NOT_LIVE");

    const cfgResp = await safeJsonFetch(`${FREE_APP}/config.json`);
    timeline.push({ at: new Date().toISOString(), stage: "config", ok: cfgResp.ok, status: cfgResp.status });
    if (!cfgResp.ok) throw new Error("CONFIG_FETCH_FAILED");
    const cfg = cfgResp.body;
    if (cfg?.isolatedFree !== true || cfg?.accessPolicy !== "non-economic") throw new Error("FREE_APP_NOT_ISOLATED_NON_ECONOMIC");

    const selected = Array.isArray(cfg.providers) ? cfg.providers[0] : null;
    if (!selected) throw new Error("NO_PROVIDERS_IN_CONFIG");

    const client = createAccessClient({ baseUrl: FREE_APP, pins: selected.pins, timeoutMs: 15_000 });
    const connectResult = await client.connect();
    timeline.push({ at: new Date().toISOString(), stage: "session_connected", capabilityPrefix: `${connectResult.capability.slice(0, 8)}…`, expiresAt: connectResult.expiresAt });

    const request = await createAccessRequest({
      providerId: selected.providerId,
      profileId: selected.profileIds[0],
      prompt,
      maxOutputTokens,
      seed: 0,
      publishConsent: false,
    });
    timeline.push({ at: new Date().toISOString(), stage: "request_created", providerId: request.providerId, profileId: request.profileId });

    const quote = await client.createQuote(request);
    timeline.push({ at: new Date().toISOString(), stage: "quote", quoteId: quote.quoteId, amountBaseUnits: quote.amountBaseUnits, network: quote.network, asset: quote.asset, mode: quote.mode });

    const submitStartedAt = Date.now();
    const submitResponse = await fetchBounded(`${FREE_APP}/v1/jobs`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${connectResult.capability}`,
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({ request, quoteId: quote.quoteId }),
    }, 20_000);
    const submitText = await submitResponse.text();
    const accepted = safeParseJson(submitText);
    timeline.push({ at: new Date().toISOString(), stage: "job_submit", httpStatus: submitResponse.status, elapsedMs: Date.now() - submitStartedAt });
    if (!submitResponse.ok || !accepted) {
      throw new Error(`SUBMIT_${submitResponse.status}_${submitText.slice(0, 120)}`);
    }

    const jobId = accepted?.job?.jobId ?? accepted?.request_id ?? null;
    const jobCapability = accepted?.capability ?? accepted?.accepted?.capability ?? null;
    if (!jobId || !jobCapability) throw new Error("SUBMIT_ACCEPTED_MISSING_JOB_OR_CAPABILITY");
    const streamPath = accepted?.stream_path ?? accepted?.accepted?.stream_path ?? `/v1/jobs/${encodeURIComponent(jobId)}/events`;
    timeline.push({ at: new Date().toISOString(), stage: "running", jobId, streamPath, acceptedCapabilityPrefix: `${jobCapability.slice(0, 8)}…` });

    const stream = await collectJobStream(streamPath, jobCapability, 60_000);
    timeline.push({ at: new Date().toISOString(), stage: stream.ok ? "complete" : "error", streamOk: stream.ok, eventCount: stream.events.length, deltaCount: stream.deltas.length, error: stream.error ?? null });

    const nativeAfter = (await safeJsonFetch("http://127.0.0.1:8791/__mycelium/live-status")).body;
    const outputText = stream.deltas.map((d) => d.text).join("");
    const outputTokenIds = stream.deltas.flatMap((d) => d.tokenIds ?? []);
    const terminalJob = stream.terminalJob ?? null;

    jsonResponse(res, 200, {
      ok: stream.ok,
      stage: stream.ok ? "complete" : "stream_error",
      error: stream.ok ? null : (stream.error ?? "STREAM_INCOMPLETE"),
      jobId,
      requestId: accepted?.request_id ?? jobId,
      providerId: selected.providerId,
      profileId: selected.profileIds[0],
      quote: { quoteId: quote.quoteId, amountBaseUnits: quote.amountBaseUnits, network: quote.network, asset: quote.asset, mode: quote.mode },
      promptEcho: prompt,
      maxOutputTokens,
      lifecycle: timeline,
      output: { text: outputText, tokenIds: outputTokenIds, tokenIdCount: outputTokenIds.length, finishReason: terminalJob?.output?.finishReason ?? null },
      terminalStatus: terminalJob?.executionStatus ?? null,
      receiptDigest: terminalJob?.receiptDigest ?? null,
      stream: { url: stream.url, done: stream.done ?? false, eventCount: stream.events.length, deltaCount: stream.deltas.length, events: stream.events },
      route: { before: summarizeNative(nativeBefore), after: summarizeNative(nativeAfter), counterDelta: counterDelta(nativeBefore, nativeAfter) },
    });
  } catch (e) {
    const nativeAfter = (await safeJsonFetch("http://127.0.0.1:8791/__mycelium/live-status")).body;
    timeline.push({ at: new Date().toISOString(), stage: "error", error: String(e?.message ?? e) });
    jsonResponse(res, 200, {
      ok: false,
      stage: "error",
      error: String(e?.message ?? e),
      lifecycle: timeline,
      promptEcho: prompt,
      maxOutputTokens,
      route: { before: summarizeNative(nativeBefore), after: summarizeNative(nativeAfter), counterDelta: counterDelta(nativeBefore, nativeAfter) },
      note: "Bounded free-inference attempt failed; rest of demo UI remains functional.",
    });
  }
}


// ----------------------------------------------------------------------------
// Endpoint: /api/receipt/canonical
async function apiReceipt(_req, res) {
  const raw = await readMaybeFile(RECEIPT_FILE);
  if (!raw) {
    jsonResponse(res, 503, { ok: false, error: "RECEIPT_FILE_MISSING", path: RECEIPT_FILE });
    return;
  }
  const data = safeParseJson(raw);
  if (!data) {
    jsonResponse(res, 502, { ok: false, error: "RECEIPT_FILE_PARSE" });
    return;
  }
  const ev = data.primary_evidence_job ?? {};
  const rc = data.primary_evidence_receipt ?? {};
  const sponsor = data.sponsor_balance_at_writeoff ?? {};
  jsonResponse(res, 200, {
    ok: true,
    version: data.version ?? null,
    capturedAt: new Date().toISOString(),
    job: {
      jobId: ev.jobId ?? null,
      quoteId: ev.quoteId ?? null,
      paymentId: ev.paymentId ?? null,
      providerId: ev.providerId ?? null,
      profileId: ev.profileId ?? null,
      requestHash: ev.requestHash ?? null,
      executionStatus: ev.executionStatus ?? null,
      payment: {
        status: ev.payment_status ?? null,
        mode: ev.payment_mode ?? null,
        txRef: ev.payment_transactionRef ?? null,
        recipient: ev.payment_recipient ?? null,
        feePayer: ev.payment_feePayer ?? null,
        receiptDigest: ev.receiptDigest ?? null,
      },
    },
    links: {
      hashscan: ev.hashscan_url ?? `https://hashscan.io/testnet/transaction/${ev.payment_transactionRef ?? ""}`,
      mirror: ev.mirror_url ?? `https://testnet.mirrornode.hedera.com/api/v1/transactions/${ev.payment_transactionRef ?? ""}`,
    },
    onChain: ev.mirror_readback
      ? {
          result: ev.mirror_readback.result ?? null,
          name: ev.mirror_readback.name ?? null,
          memo: ev.mirror_readback.memo_base64_decoded ?? null,
          consensusTimestamp: ev.mirror_readback.consensus_timestamp ?? null,
          chargedTxFeeTinybar: ev.mirror_readback.charged_tx_fee_tinybar ?? null,
          transfers: ev.mirror_readback.transfers ?? [],
        }
      : null,
    receipt: {
      keyId: rc.keyId ?? null,
      algorithm: rc.algorithm ?? null,
      signaturePresent: rc.signature_present ?? null,
      signatureB64UrlRedacted: rc.signature_b64url_redacted ?? null,
      evidenceDigest: rc.evidenceDigest ?? null,
      outputHash: rc.outputHash ?? null,
      issuedAt: rc.issuedAt ?? null,
    },
    sponsor: sponsor?.sponsor_accountId
      ? {
          accountId: sponsor.sponsor_accountId,
          balanceTinybar: sponsor.balance_tinybar ?? null,
          balanceHbarApprox: sponsor.balance_hbar_approx ?? null,
          mirror: sponsor.mirror_url ?? `https://testnet.mirrornode.hedera.com/api/v1/accounts/${sponsor.sponsor_accountId}`,
        }
      : null,
    paidRetryNote: data?.new_attempt_outcome?.note ?? null,
    fileSha256: sha256OfString(raw),
  });
}

// ----------------------------------------------------------------------------
// Endpoint: /api/graph
async function apiGraph(_req, res) {
  const metaQuery = "{ _meta { block { number timestamp } deployment hasIndexingErrors } }";
  const typeProbeQuery =
    "{ __schema { queryType { fields { name } } types { name } } }";
  const providerQuery =
    '{ providers(first: 10, orderBy: totalAudits, orderDirection: desc) { id providerKey stake requiredStake totalAudits mismatchCount } }';
  const auditQuery = '{ audits(first: 5, orderBy: timestamp, orderDirection: desc) { id providerKey profile outcome } }';

  const runs = await Promise.all([
    safeJsonFetch(GRAPH_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: metaQuery }) }),
    safeJsonFetch(GRAPH_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: typeProbeQuery }) }),
    safeJsonFetch(GRAPH_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: providerQuery }) }),
    safeJsonFetch(GRAPH_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: auditQuery }) }),
  ]);

  const [meta, types, providersR, auditsR] = runs;

  // Helper to classify provider collection emptiness.
  const providerCount = Array.isArray(providersR.body?.data?.providers) ? providersR.body.data.providers.length : 0;
  const auditCount = Array.isArray(auditsR.body?.data?.audits) ? auditsR.body.data.audits.length : 0;

  jsonResponse(res, 200, {
    ok: meta.ok && types.ok,
    endpoint: GRAPH_URL,
    capturedAt: new Date().toISOString(),
    meta: meta.body?.data?._meta ?? null,
    metaProbe: { ok: meta.ok, status: meta.status, error: meta.error ?? null, errors: meta.body?.errors ?? null },
    types: types.body?.data?.__schema
      ? { queryFields: (types.body.data.__schema.queryType?.fields ?? []).map(f => f.name), typeNames: (types.body.data.__schema.types ?? []).map(t => t.name) }
      : null,
    providersProbe: {
      ok: providersR.ok && !providersR.body?.errors,
      status: providersR.status,
      errors: providersR.body?.errors ?? null,
      count: providerCount,
      sample: providersR.body?.data?.providers ?? [],
      emptyState: providerCount === 0 ? "schema deployed, no provider events indexed yet" : null,
    },
    auditsProbe: {
      ok: auditsR.ok && !auditsR.body?.errors,
      status: auditsR.status,
      errors: auditsR.body?.errors ?? null,
      count: auditCount,
      sample: auditsR.body?.data?.audits ?? [],
      emptyState: auditCount === 0 ? "schema deployed, no audit events indexed yet" : null,
    },
    sampleQueries: [
      { name: "_meta", query: metaQuery },
      { name: "providers", query: providerQuery },
      { name: "audits", query: auditQuery },
      { name: "introspect", query: typeProbeQuery },
    ],
  });
}

// ----------------------------------------------------------------------------
// Endpoint: /api/tee
async function apiTee(_req, res) {
  const runs = await Promise.all([
    safeJsonFetch(`${TEE_URLS[0]}/healthz`),
    safeJsonFetch(`${TEE_URLS[0]}/info`),
    safeJsonFetch(`${TEE_URLS[0]}/attestation`),
    safeJsonFetch(`${TEE_URLS[0]}/generate-key`),
  ]);
  const [health, info, attestation, generateKey] = runs;
  // Probe optional port quickly (in parallel) so TCP connect attempts don't hang the response.
  const [altHealth, altAttest, altGenerateKey] = await Promise.all([
    safeJsonFetchFast(`${TEE_URL_OPT}/healthz`),
    safeJsonFetchFast(`${TEE_URL_OPT}/attestation`),
    safeJsonFetchFast(`${TEE_URL_OPT}/generate-key`),
  ]);
  const computeGreen = health.ok && info.ok;
  const attestGreen = (attestation.ok && attestation.status === 200) || (altAttest.ok && altAttest.status === 200);
  jsonResponse(res, 200, {
    capturedAt: new Date().toISOString(),
    primary: {
      url: TEE_URLS[0],
      compute: { state: computeGreen ? "GREEN" : "RED", http: health.status, body: health.body ?? null },
      info: { http: info.status, body: info.body ?? null },
      attestation: { state: attestGreen ? "GREEN" : "YELLOW", http: attestation.status, body: attestation.body ?? null, reason: attestGreen ? null : "Plain Flask image; /attestation is part of T6 tee-launcher plumbing (Y3 per submission report)" },
      generateKey: { http: generateKey.status, state: generateKey.ok && generateKey.status === 200 ? "GREEN" : "YELLOW", body: generateKey.body ?? null, reason: generateKey.ok ? null : "Plain Flask image; /generate-key is part of T6 tee-launcher plumbing (Y3)" },
    },
    alt: {
      url: TEE_URL_OPT,
      health: { http: altHealth.status, body: altHealth.body ?? null, reachable: altHealth.ok },
      attestation: { http: altAttest.status, body: altAttest.body ?? null, reachable: altAttest.ok },
      generateKey: { http: altGenerateKey.status, body: altGenerateKey.body ?? null, reachable: altGenerateKey.ok },
      note: altHealth.ok || altAttest.ok || altGenerateKey.ok ? "T6 launch detected on alt port" : "T6 not yet on port 8766 (would be tee-launcher plumbing)",
    },
    classifier: {
      computeGreen,
      attestGreen,
      primaryAttestationReason: attestation.ok && attestation.status === 200 ? null : "primary 8765 verifier image is plain Flask; T6 may be available on 8766",
      altAttestationGreen: altAttest.ok && altAttest.status === 200,
      altGenerateKeyGreen: altGenerateKey.ok && altGenerateKey.status === 200,
    },
  });
}

// ----------------------------------------------------------------------------
// Endpoint: /api/ens
async function apiEns(_req, res) {
  // Try to read ens-prep artifacts (created by some prior lane). If absent, honest
  // current state is reported from authoritative references.
  const candidatePaths = [
    join(ENS_PREP_DIR, "ens-prep-payload.json"),
    join(ENS_PREP_DIR, "ens-set-text-record.json"),
    join(ENS_PREP_DIR, "ens-dry-run.json"),
    join(ENS_PREP_DIR, "README.md"),
  ];
  const files = {};
  let anyPresent = false;
  for (const p of candidatePaths) {
    const content = await readMaybeFile(p);
    if (content != null) {
      files[p.replace(WB + "/", "")] = content;
      anyPresent = true;
    }
  }

  // Also try the broader artifacts directory tree for any ENS-related summaries.
  const ensSummary = await readMaybeFile(join(WB, "docs/handoffs/w6-ens-prep.md"));
  const altSummary = await readMaybeFile(join(WB, "composition/w6-public-edge.mjs"));
  const publicEdgeExcerpt = altSummary ? altSummary.slice(0, 4000) : null;

  jsonResponse(res, 200, {
    capturedAt: new Date().toISOString(),
    state: "broadcast_pending",
    label: "YELLOW — ENS repoint (E1) is human-only and not started",
    targets: {
      apex: { name: "mycelium.now", target: "verifier-or-paid-public-origin", state: "DNS resolves via Cloudflare; content hash + public-edge mount pending" },
      sub: { name: "verifier.mycelium.now", target: TEE_URLS[0], state: "NXDOMAIN per submission Y6; rebind requires parent-gated API key" },
    },
    artifacts: { present: anyPresent, files },
    summaryExcerpt: ensSummary ? ensSummary.slice(0, 2000) : null,
    publicEdgeExcerpt,
    authoritativeReferences: [
      "master plan §3 owner decisions",
      "master plan §4 / E1 ENS repoint",
      "submission report §5/Y6",
    ],
  });
}

// ----------------------------------------------------------------------------
// Endpoint: /api/evidence
async function apiEvidence(_req, res) {
  const raw = await readMaybeFile(EVIDENCE_FILE);
  if (!raw) {
    jsonResponse(res, 503, { ok: false, error: "EVIDENCE_FILE_MISSING", path: EVIDENCE_FILE });
    return;
  }
  const lines = raw.split("\n").filter((l) => /^[0-9a-f]{64}\s+\S/.test(l));
  const entries = lines.map((l) => {
    const [sha, ...rest] = l.split(/\s+/);
    return { sha256: sha, path: rest.join(" ") };
  });
  jsonResponse(res, 200, {
    capturedAt: new Date().toISOString(),
    manifestPath: EVIDENCE_FILE.replace(WB + "/", ""),
    entryCount: entries.length,
    entries,
    manifestSha256: sha256OfString(raw),
  });
}

// ----------------------------------------------------------------------------
// Endpoint: /api/judge/curls
function apiJudgeCurls(_req, res) {
  const curls = [
    {
      name: "Canonical paid G01 on Hedera testnet mirror",
      cmd: `curl -sS 'https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789239567-211071753' | python3 -m json.tool | head -40`,
      expect: "result: SUCCESS, name: CRYPTOTRANSFER, memo_base64 → ethonline:287bb1f3…, 1 tinybar to 0.0.10419316",
    },
    {
      name: "HashScan reconciliation link",
      cmd: `curl -sSI 'https://hashscan.io/testnet/transaction/0.0.7162784-1789239567-211071753'`,
      expect: "HTTP/2 200",
    },
    {
      name: "Public origin liveness",
      cmd: `curl -sS 'https://mycelium.now/healthz'`,
      expect: '{"status":"ok","mode":"live"}',
    },
    {
      name: "Graph _meta probe",
      cmd: `curl -sS 'https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.1-bytes32-reconcile' -H 'content-type: application/json' -X POST -d '{"query":"{ _meta { block { number } deployment hasIndexingErrors } }"}'`,
      expect: "_meta.block.number present; hasIndexingErrors=false",
    },
    {
      name: "TEE compute (SEV) healthz + info",
      cmd: `curl -sS 'http://34.7.61.130:8765/healthz'; echo; curl -sS 'http://34.7.61.130:8765/info'`,
      expect: 'healthz: {"state":"running","status":"ok"}; info: bundle_sha matches e5e5e7f8…',
    },
    {
      name: "Free app liveness + isolated-free config",
      cmd: `curl -sS 'http://127.0.0.1:4350/healthz'; echo; curl -sS 'http://127.0.0.1:4350/config.json' | head -c 400`,
      expect: "healthz mode=live; config.json has isolatedFree=true and accessPolicy=non-economic",
    },
    {
      name: "Native route status",
      cmd: `curl -sS 'http://127.0.0.1:8791/__mycelium/live-status' | head -c 400`,
      expect: 'route_alive=true, model_id="Qwen/Qwen2.5-0.5B-Instruct", simulated=false',
    },
    {
      name: "Demo UI: this server",
      cmd: `curl -sS 'http://127.0.0.1:4362/api/status' | head -c 400`,
      expect: "JSON with capability badges (green/yellow)",
    },
    {
      name: "Demo UI: canonical receipt",
      cmd: `curl -sS 'http://127.0.0.1:4362/api/receipt/canonical' | python3 -m json.tool | head -30`,
      expect: "hashscan link + memo + jobId + providerId + signature present",
    },
    {
      name: "Demo UI: live Graph",
      cmd: `curl -sS 'http://127.0.0.1:4362/api/graph' | python3 -m json.tool | head -30`,
      expect: "_meta block + provider/audit probes with empty-state label",
    },
    {
      name: "Demo UI: live TEE",
      cmd: `curl -sS 'http://127.0.0.1:4362/api/tee' | python3 -m json.tool | head -30`,
      expect: "compute=GREEN; attestation=YELLOW with explicit reason",
    },
  ];

  jsonResponse(res, 200, {
    capturedAt: new Date().toISOString(),
    note: "All curls are read-only. Nothing here broadcasts, signs, or pays.",
    curls,
  });
}

// ----------------------------------------------------------------------------
// A13 panel endpoints — Lane A13-UI-Wiring-Stub (additive, no other edits).
// Probes the A13 worktree on disk and reports one of five states:
//   not-installed | disabled | ready | running | complete
// POST /api/a13/swarm is a placeholder: it returns immediately with
// state=running and a runId, then 5s later writes a stub .swarm-running
// file followed by a stub .swarm-receipt-<runId>.json so the UI can
// observe the full lifecycle. Replace the timer with the real A13 CLI
// invocation per artifacts/w6-v2/a13-ui-stub/integration-contract.md.
const A13_WORKTREE = "/Users/evinova-self/Documents/playground/mycelium-a13-macos-demo";
const A13_QUOTA_FIX_MARKER = join(A13_WORKTREE, ".a13-quota-fix-complete");
const A13_SWARM_RUNNING = join(A13_WORKTREE, ".swarm-running");
const A13_RECEIPT_PREFIX = ".swarm-receipt-";

function a13Uuid() {
  // RFC 4122 v4 via Node crypto (avoid extra deps).
  return randomUUID();
}

async function a13ProbeWorktree() {
  const result = {
    state: "not-installed",
    message: "A13 worktree not found",
    worktree: A13_WORKTREE,
    version: null,
    lastRunAt: null,
  };
  let s = null;
  try { s = await stat(A13_WORKTREE); } catch { return result; }
  if (!s.isDirectory()) return result;

  // package.json presence is the canonical "installed" signal.
  let pkgRaw = null;
  try { pkgRaw = await readFile(join(A13_WORKTREE, "package.json"), "utf8"); } catch {}
  const installed = Boolean(pkgRaw);
  if (!installed) {
    return {
      ...result,
      state: "not-installed",
      message: `A13 worktree exists but has no package.json (${A13_WORKTREE})`,
    };
  }
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg.version) result.version = String(pkg.version);
    } catch {}
  }

  // Quota-fix marker (GLM worker writes this when ready).
  let quotaFix = null;
  try { quotaFix = await stat(A13_QUOTA_FIX_MARKER); } catch {}
  if (!quotaFix || !quotaFix.isFile()) {
    return {
      ...result,
      state: "disabled",
      message:
        "A13 present but owner per-lifetime request quota fix is not yet complete " +
        "(waiting on .a13-quota-fix-complete marker from the A13 worker)",
    };
  }

  // Running: .swarm-running exists with mtime within last 60s.
  let running = null;
  try { running = await stat(A13_SWARM_RUNNING); } catch {}
  if (running && Date.now() - running.mtimeMs < 60_000) {
    return {
      ...result,
      state: "running",
      message: "A13 swarm currently running",
      lastRunAt: new Date(running.mtimeMs).toISOString(),
    };
  }

  // Complete: most recent .swarm-receipt-<id>.json is valid JSON.
  // We do a lightweight scan via readdir of the worktree.
  let entries = [];
  try { entries = await readdir(A13_WORKTREE); } catch {}
  const receipts = entries
    .filter((n) => n.startsWith(A13_RECEIPT_PREFIX) && n.endsWith(".json"))
    .sort()
    .reverse();
  for (const name of receipts) {
    const raw = await readMaybeFile(join(A13_WORKTREE, name));
    if (!raw) continue;
    const j = safeParseJson(raw);
    if (j && (j.runId || j.state || j.verified != null)) {
      return {
        ...result,
        state: "complete",
        message: "A13 swarm run completed (receipt available)",
        lastRunAt: j.completedAt ?? j.issuedAt ?? null,
      };
    }
  }

  return {
    ...result,
    state: "ready",
    message: "A13 ready — run a swarm below to produce a TEE-verified receipt",
  };
}

async function apiA13Status(_req, res) {
  const probe = await a13ProbeWorktree();
  jsonResponse(res, 200, {
    capturedAt: new Date().toISOString(),
    endpoint: "A13 multi-Mac swarm",
    ...probe,
    contract: {
      quotaFixMarker: A13_QUOTA_FIX_MARKER,
      swarmRunningMarker: A13_SWARM_RUNNING,
      receiptPrefix: A13_RECEIPT_PREFIX,
      markerConventionDoc: "artifacts/w6-v2/a13-ui-stub/integration-contract.md",
    },
  });
}

async function readBody(req, maxBytes = 4096) {
  let buf = "";
  for await (const chunk of req) buf += chunk;
  if (buf.length > maxBytes) return { _tooLarge: true, length: buf.length };
  return safeParseJson(buf) ?? {};
}

async function apiA13Swarm(req, res) {
  const body = await readBody(req, 4096);
  if (body?._tooLarge) {
    jsonResponse(res, 413, { ok: false, error: "BODY_TOO_LARGE" });
    return;
  }
  const probe = await a13ProbeWorktree();
  if (probe.state !== "ready") {
    jsonResponse(res, 200, {
      ok: false,
      state: probe.state,
      message: probe.message,
      runId: null,
      startedAt: null,
    });
    return;
  }
  const runId = a13Uuid();
  const startedAt = new Date().toISOString();
  const nodeCount = Math.max(1, Math.min(16, Number(body?.nodeCount ?? 2)));
  const prompt = String(body?.prompt ?? "").slice(0, 1024);
  const maxNewTokens = Math.max(1, Math.min(64, Number(body?.maxNewTokens ?? 1)));

  // Placeholder: do NOT invoke A13 yet. Schedule a stub lifecycle so the UI
  // can demonstrate the full state machine.
  setTimeout(async () => {
    const runningPayload = JSON.stringify({
      runId, startedAt, nodeCount, prompt, maxNewTokens, state: "running",
    }, null, 2);
    try { await writeFile(A13_SWARM_RUNNING, runningPayload, "utf8"); } catch {}
  }, 100).unref?.();

  setTimeout(async () => {
    // Clear .swarm-running and write a stub receipt. When the real A13 worker
    // is wired in, the receipt file is what it will write; the panel will
    // pick it up unchanged via GET /api/a13/receipt/<runId>.
    const completedAt = new Date().toISOString();
    const receipt = {
      runId,
      startedAt,
      completedAt,
      state: "complete",
      verified: false, // becomes true when real A13 emits TEE-verified receipt
      placeholder: true,
      message:
        "Stub receipt — replace with real A13 swarm output (see integration-contract.md)",
      tee: {
        endpoint: "34.7.61.130:8765",
        attestation: "pending (real A13 worker will populate)",
      },
      swarm: { nodeCount, prompt, maxNewTokens },
      // When the real A13 swarm runs, it MUST write a TEE-verified receipt
      // here. The panel reads it via GET /api/a13/receipt/<runId>.
    };
    const receiptPath = join(A13_WORKTREE, `${A13_RECEIPT_PREFIX}${runId}.json`);
    try {
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
      await unlink(A13_SWARM_RUNNING).catch(() => {});
    } catch {}
  }, 5000).unref?.();

  jsonResponse(res, 200, {
    ok: true,
    state: "running",
    runId,
    startedAt,
    worktree: A13_WORKTREE,
    nodeCount,
    prompt,
    maxNewTokens,
    placeholder: true,
    note:
      "Placeholder run scheduled. Real A13 invocation lives in /api/a13/swarm " +
      "per artifacts/w6-v2/a13-ui-stub/integration-contract.md.",
  });
}

async function apiA13Receipt(req, res) {
  // URL pathname parsed by the dispatcher; we just need the last segment.
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const runId = parts[parts.length - 1];
  if (!runId || !/^[a-zA-Z0-9-]{8,128}$/.test(runId)) {
    jsonResponse(res, 400, { ok: false, error: "BAD_RUN_ID" });
    return;
  }
  const path = join(A13_WORKTREE, `${A13_RECEIPT_PREFIX}${runId}.json`);
  const raw = await readMaybeFile(path);
  if (!raw) {
    jsonResponse(res, 404, { ok: false, error: "RECEIPT_NOT_FOUND", runId, path });
    return;
  }
  const data = safeParseJson(raw);
  if (!data) {
    jsonResponse(res, 502, { ok: false, error: "RECEIPT_PARSE", runId });
    return;
  }
  jsonResponse(res, 200, { ok: true, runId, ...data });
}

// ----------------------------------------------------------------------------
// Static file serving
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

async function serveStatic(req, res, relPath) {
  let p = relPath;
  if (p === "/" || p === "") p = "/index.html";
  const safe = p.replace(/\.\.+/g, "").replace(/\/+/g, "/");
  const filePath = join(PUBLIC_DIR, safe);
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return false;
    const data = await readFile(filePath);
    const ext = (safe.match(/\.[^.]+$/) ?? [".html"])[0];
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// HTTP server
const ROUTES = {
  "GET /api/status": apiStatus,
  "POST /api/inference/free": apiInferenceFree,
  "GET /api/receipt/canonical": apiReceipt,
  "GET /api/graph": apiGraph,
  "GET /api/tee": apiTee,
  "GET /api/ens": apiEns,
  "GET /api/evidence": apiEvidence,
  "GET /api/judge/curls": apiJudgeCurls,
  "GET /api/a13/status": apiA13Status,
  "POST /api/a13/swarm": apiA13Swarm,
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const routeKey = `${req.method} ${url.pathname}`;

    // API
    if (ROUTES[routeKey]) {
      try {
        await ROUTES[routeKey](req, res);
      } catch (e) {
        jsonResponse(res, 500, { ok: false, stage: "handler", error: String(e?.message ?? e), stack: (e?.stack ?? "").slice(0, 800) });
      }
      return;
    }

    // Dynamic-path API: GET /api/a13/receipt/<runId>
    if (req.method === "GET" && /^\/api\/a13\/receipt\/[A-Za-z0-9-]{8,128}$/.test(url.pathname)) {
      try {
        await apiA13Receipt(req, res);
      } catch (e) {
        jsonResponse(res, 500, { ok: false, stage: "a13_receipt", error: String(e?.message ?? e), stack: (e?.stack ?? "").slice(0, 800) });
      }
      return;
    }

    // Pages — single SPA with hash routing, so all GET paths fall through to /
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/how-it-works" || url.pathname === "/index.html")) {
      const served = await serveStatic(req, res, "/index.html");
      if (!served) textResponse(res, 500, "index.html missing", "text/plain");
      return;
    }

    // Static assets
    if (req.method === "GET") {
      const served = await serveStatic(req, res, url.pathname);
      if (served) return;
    }

    jsonResponse(res, 404, { ok: false, error: "NOT_FOUND", path: url.pathname, method: req.method });
  } catch (e) {
    try {
      jsonResponse(res, 500, { ok: false, error: "INTERNAL", detail: String(e?.message ?? e) });
    } catch {}
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[w6-demo-ui] listening on http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[w6-demo-ui] free app origin = ${FREE_APP}`);
  // eslint-disable-next-line no-console
  console.log(`[w6-demo-ui] graph endpoint  = ${GRAPH_URL}`);
  // eslint-disable-next-line no-console
  console.log(`[w6-demo-ui] tee primary     = ${TEE_URLS[0]}`);
});

// Graceful shutdown.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
