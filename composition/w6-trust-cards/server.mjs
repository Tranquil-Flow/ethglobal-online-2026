import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const HOST = process.env.W6_TRUST_CARDS_HOST ?? "127.0.0.1";
const PORT = Number(process.env.W6_TRUST_CARDS_PORT ?? 4361);
const GRAPH_ENDPOINT = process.env.W6_GRAPH_ENDPOINT
  ?? "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.0-verification-ledger";
const STUDIO_URL = "https://thegraph.com/studio/subgraph/ethonline-sepolia-receipts";
const SEPOLIA_RPC_URLS = (process.env.SEPOLIA_RPC_URLS
  ? process.env.SEPOLIA_RPC_URLS.split(",")
  : ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"])
  .map((url) => url.trim())
  .filter(Boolean);

const ENS_UNIVERSAL_RESOLVER_SEPOLIA = "0x4a1817d13e9cf196f471725176355c1234b63c70";

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function safeNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function graphTimestampToIso(value) {
  const seconds = safeNumber(value);
  if (!seconds || seconds < 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function toBigIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  try { return BigInt(String(value)); } catch { return null; }
}

function compareUintStrings(a, b) {
  const left = toBigIntOrNull(a);
  const right = toBigIntOrNull(b);
  if (left === null || right === null) return null;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, payload, status = 200) {
  send(res, status, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(payload));
}

async function sendStatic(res, filePath, contentType) {
  const body = await readFile(new URL(filePath, import.meta.url));
  send(res, 200, { "content-type": `${contentType}; charset=utf-8` }, body);
}

async function postGraph(query, variables = {}) {
  const timeout = withTimeout(10_000);
  try {
    const response = await fetch(GRAPH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: timeout.signal,
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { throw Error(`Graph Studio returned non-JSON status ${response.status}`); }
    if (!response.ok) throw Error(`Graph Studio HTTP ${response.status}`);
    if (body.errors?.length) throw Error(body.errors.map((error) => error.message).join("; "));
    return body.data;
  } finally {
    timeout.done();
  }
}

async function jsonRpc(url, method, params = []) {
  const timeout = withTimeout(5_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: timeout.signal,
    });
    if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw Error(body.error.message || "RPC error");
    return body.result;
  } finally {
    timeout.done();
  }
}

async function sepoliaHeadNumber() {
  for (const url of SEPOLIA_RPC_URLS) {
    try {
      const hex = await jsonRpc(url, "eth_blockNumber");
      const number = Number.parseInt(String(hex), 16);
      if (Number.isFinite(number)) return { number, rpcUrl: url };
    } catch {
      // Try the next public read-only RPC. Failure is reported as unknown provenance below.
    }
  }
  return { number: null, rpcUrl: null };
}

function unavailableGraphPayload(kind, error) {
  const base = {
    available: false,
    source: GRAPH_ENDPOINT,
    studioUrl: STUDIO_URL,
    lastUpdated: new Date().toISOString(),
    error: "Graph Studio unavailable",
    detail: String(error?.message ?? error ?? "unknown error"),
  };
  if (kind === "stats") {
    return { ...base, blockNumber: null, lag: null, confirmations: null, providerCount: null, auditCount: null };
  }
  return {
    ...base,
    swarm: "hosted 0.5B swarm",
    empty: true,
    message: "no providers registered yet — demo data fixtures pending.",
    providers: [],
    providerCount: 0,
    auditCount: 0,
  };
}

async function graphStats() {
  try {
    const data = await postGraph(`{
      _meta { block { number hash timestamp } hasIndexingErrors deployment }
      providers(first: 1000) { id }
      audits(first: 1000) { id }
    }`);
    const blockNumber = safeNumber(data?._meta?.block?.number);
    const head = await sepoliaHeadNumber();
    const delta = head.number !== null && blockNumber !== null ? Math.max(0, head.number - blockNumber) : null;
    return {
      available: true,
      source: GRAPH_ENDPOINT,
      studioUrl: STUDIO_URL,
      blockNumber,
      blockHash: data?._meta?.block?.hash ?? null,
      blockTimestamp: graphTimestampToIso(data?._meta?.block?.timestamp),
      chainHead: head.number,
      chainHeadRpc: head.rpcUrl,
      lag: delta,
      confirmations: delta,
      providerCount: Array.isArray(data?.providers) ? data.providers.length : 0,
      auditCount: Array.isArray(data?.audits) ? data.audits.length : 0,
      hasIndexingErrors: data?._meta?.hasIndexingErrors ?? null,
      deployment: data?._meta?.deployment ?? null,
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    return unavailableGraphPayload("stats", error);
  }
}

function auditOutcomeCounts(audits) {
  const counts = {};
  for (const audit of audits) {
    const key = String(audit.outcome ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function deriveProviderStatus({ provider, stake, requiredStake, slashes }) {
  const activeSlash = slashes.find((slash) => !["resolved", "expired", "0"].includes(String(slash.status ?? "").toLowerCase()));
  if (activeSlash) return "slashed";
  const comparison = compareUintStrings(stake, requiredStake);
  if (comparison !== null && comparison < 0) return "under-staked";
  const declared = String(provider.status ?? "").toLowerCase();
  if (["slashed", "under-staked", "under_staked", "unbonding", "eligible"].includes(declared)) {
    return declared.replace("_", "-");
  }
  if (comparison !== null && comparison >= 0) return "eligible";
  return declared || "unknown";
}

async function providerTrust() {
  try {
    const data = await postGraph(`{
      _meta { block { number hash timestamp } hasIndexingErrors deployment }
      providers(first: 1000) { id address profileId operator registeredAt status }
      providerProfiles(first: 1000) {
        id profileHash requiredStake statsBlock auditsTotal mismatchesTotal inconclusiveTotal
        unavailableTotal assessmentsTotal suspiciousTotal escrowsReleased escrowsRefunded
        escrowsReleasedUnverified slashCount canaryMismatches
      }
      audits(first: 1000) { id provider profile epoch reason outcome evidenceDigest hederaRef blockNumber timestamp }
      requiredStakes(first: 1000) { id profile amount P q d alpha lambda statsBlock }
      stakeEvents(first: 1000) { id provider profile delta newBalance hederaRef blockNumber timestamp }
      slashes(first: 1000) { id provider profile slashId amount evidenceDigest status expiry hederaRef }
    }`);

    const providers = Array.isArray(data?.providers) ? data.providers : [];
    const profiles = Array.isArray(data?.providerProfiles) ? data.providerProfiles : [];
    const requiredStakes = Array.isArray(data?.requiredStakes) ? data.requiredStakes : [];
    const audits = Array.isArray(data?.audits) ? data.audits : [];
    const stakeEvents = Array.isArray(data?.stakeEvents) ? data.stakeEvents : [];
    const slashes = Array.isArray(data?.slashes) ? data.slashes : [];

    const profileByKey = new Map();
    for (const profile of profiles) {
      profileByKey.set(profile.id, profile);
      if (profile.profileHash) profileByKey.set(profile.profileHash, profile);
    }
    const requiredByProfile = new Map();
    for (const required of requiredStakes) {
      requiredByProfile.set(required.profile, required);
      requiredByProfile.set(required.id, required);
    }

    if (providers.length === 0) {
      return {
        available: true,
        source: GRAPH_ENDPOINT,
        studioUrl: STUDIO_URL,
        swarm: "hosted 0.5B swarm",
        empty: true,
        message: "no providers registered yet — demo data fixtures pending.",
        providers: [],
        providerCount: 0,
        auditCount: audits.length,
        requiredStakeCount: requiredStakes.length,
        blockNumber: safeNumber(data?._meta?.block?.number),
        blockHash: data?._meta?.block?.hash ?? null,
        blockTimestamp: graphTimestampToIso(data?._meta?.block?.timestamp),
        hasIndexingErrors: data?._meta?.hasIndexingErrors ?? null,
        deployment: data?._meta?.deployment ?? null,
        lastUpdated: new Date().toISOString(),
      };
    }

    const rows = providers.map((provider) => {
      const providerAudits = audits.filter((audit) => audit.provider === provider.id)
        .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0));
      const providerSlashes = slashes.filter((slash) => slash.provider === provider.id);
      const profile = profileByKey.get(provider.profileId) ?? null;
      const required = requiredByProfile.get(provider.profileId)
        ?? (profile ? requiredByProfile.get(profile.id) ?? requiredByProfile.get(profile.profileHash) : null)
        ?? null;
      const latestStakeEvent = stakeEvents
        .filter((event) => event.provider === provider.id && (!provider.profileId || event.profile === provider.profileId || event.profile === profile?.id || event.profile === profile?.profileHash))
        .sort((a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0))[0] ?? null;
      const stake = latestStakeEvent?.newBalance ?? null;
      const requiredStake = profile?.requiredStake ?? required?.amount ?? null;
      return {
        id: provider.id,
        address: provider.address ?? null,
        operator: provider.operator ?? null,
        profileId: provider.profileId ?? null,
        registeredAt: graphTimestampToIso(provider.registeredAt),
        stake,
        requiredStake,
        auditCounts: auditOutcomeCounts(providerAudits),
        auditCount: providerAudits.length,
        lastAudit: providerAudits[0]
          ? {
              id: providerAudits[0].id,
              outcome: providerAudits[0].outcome ?? null,
              reason: providerAudits[0].reason ?? null,
              timestamp: graphTimestampToIso(providerAudits[0].timestamp),
              blockNumber: safeNumber(providerAudits[0].blockNumber),
            }
          : null,
        status: deriveProviderStatus({ provider, stake, requiredStake, slashes: providerSlashes }),
        declaredStatus: provider.status ?? null,
        slashCount: providerSlashes.length,
        profile: profile
          ? {
              id: profile.id,
              profileHash: profile.profileHash,
              auditsTotal: profile.auditsTotal,
              mismatchesTotal: profile.mismatchesTotal,
              inconclusiveTotal: profile.inconclusiveTotal,
              unavailableTotal: profile.unavailableTotal,
              canaryMismatches: profile.canaryMismatches,
            }
          : null,
      };
    });

    return {
      available: true,
      source: GRAPH_ENDPOINT,
      studioUrl: STUDIO_URL,
      swarm: "hosted 0.5B swarm",
      empty: false,
      providers: rows,
      providerCount: rows.length,
      auditCount: audits.length,
      requiredStakeCount: requiredStakes.length,
      blockNumber: safeNumber(data?._meta?.block?.number),
      blockHash: data?._meta?.block?.hash ?? null,
      blockTimestamp: graphTimestampToIso(data?._meta?.block?.timestamp),
      hasIndexingErrors: data?._meta?.hasIndexingErrors ?? null,
      deployment: data?._meta?.deployment ?? null,
      lastUpdated: new Date().toISOString(),
    };
  } catch (error) {
    return unavailableGraphPayload("providers", error);
  }
}

function ensInfo() {
  const pendingBadge = "TBD: ENS broadcast pending";
  return {
    available: true,
    chainId: 11155111,
    network: "sepolia",
    apex: {
      name: "mycelium.now",
      parent: "ethonline.eth",
      endpoint: "https://mycelium.now",
      contentHash: pendingBadge,
      resolver: ENS_UNIVERSAL_RESOLVER_SEPOLIA,
      badge: pendingBadge,
    },
    verifier: {
      name: "verifier.mycelium.now",
      parent: "mycelium.now",
      endpoint: "https://verifier.mycelium.now/attestation",
      contentHash: pendingBadge,
      resolver: null,
      badge: pendingBadge,
      tbd: "broadcast pending",
    },
    gateway: {
      name: "gateway.mycelium.now",
      parent: "mycelium.now",
      endpoint: "https://mycelium.now/v1/jobs",
      contentHash: pendingBadge,
      resolver: null,
      badge: pendingBadge,
      tbd: "broadcast pending",
    },
    notes: "ENS records not yet broadcast — content hashes prepared, transactions pending parent authorization.",
    parentGateRequired: true,
    owner: "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE",
    lastUpdated: new Date().toISOString(),
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    const pathname = url.pathname;
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, { code: "METHOD_NOT_ALLOWED" }, 405);
      return;
    }
    const headOnly = req.method === "HEAD";
    if (headOnly) {
      res.writeHead(200, SECURITY_HEADERS);
      res.end();
      return;
    }
    if (pathname === "/healthz") {
      sendJson(res, { status: "ok", service: "w6-trust-cards" });
      return;
    }
    if (pathname === "/" || pathname === "/trust-cards" || pathname === "/trust-cards/") {
      await sendStatic(res, "./public/index.html", "text/html");
      return;
    }
    if (pathname === "/trust-cards.js") {
      await sendStatic(res, "./public/trust-cards.js", "text/javascript");
      return;
    }
    if (pathname === "/trust-cards.css") {
      await sendStatic(res, "./public/trust-cards.css", "text/css");
      return;
    }
    if (pathname === "/api/graph-stats") {
      sendJson(res, await graphStats());
      return;
    }
    if (pathname === "/api/ens-info") {
      sendJson(res, ensInfo());
      return;
    }
    if (pathname === "/api/provider-trust") {
      sendJson(res, await providerTrust());
      return;
    }
    sendJson(res, { code: "NOT_FOUND" }, 404);
  } catch (error) {
    sendJson(res, { code: "INTERNAL_ERROR", message: "trust cards server failed", detail: String(error?.message ?? error) }, 500);
  }
});

server.headersTimeout = 5000;
server.requestTimeout = 15000;
server.maxConnections = 128;
server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ status: "w6-trust-cards-ready", url: `http://${HOST}:${PORT}`, graphEndpoint: GRAPH_ENDPOINT }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
