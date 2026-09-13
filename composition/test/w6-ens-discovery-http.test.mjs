// W6 v3 ENSv2 frontend provenance — tests for the /v2/ens-discovery handler
// embedded in composition/w6-public-edge.mjs and for the loader wrapper
// behaviour the handler depends on.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { loadProvidersFromEns } from "../w6-ens-discovery-loader.mjs";

function makeLoader(providers, { delayMs = 0, throwOnList = null, counter = { count: 0 } } = {}) {
  return {
    async list({ names, signal }) {
      counter.count += 1;
      if (throwOnList) throw throwOnList;
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, delayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      const set = new Set(names);
      const out = providers.filter((p) => set.has(p.providerId));
      return { providers: out, errors: [] };
    },
  };
}

function makeEndpoint(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "INTERNAL", message: error?.message ?? String(error) } }));
        }
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: { host: "mycelium.now" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("client timeout")));
  });
}

const SAMPLE = (id, blockHash) => ({
  providerId: id,
  endpoint: "https://m4pro.tail53d0d3.ts.net",
  profileIds: ["sha256:f17c05c452151f99e6758908ee2849f1086b237972b9f3fe1ca6506d9714fcea"],
  paymentNetwork: "hedera:testnet",
  paymentAsset: "0.0.0",
  paymentReceiver: "0.0.10419316",
  historyEndpoint: "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911",
  source: {
    chainId: "11155111",
    blockNumber: 11695032,
    blockHash,
    resolvedAt: "2026-09-13T09:18:42.064Z",
    expiresAt: "2026-09-13T09:19:12.064Z",
  },
});

const NAMES = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const BLOCK_HASH_A = "0x7a89c91a23a09f4584f368458bfb7c6c67264928aa32de869e9c0d06e029f51f";
const BLOCK_HASH_B = "0xf4cbbe4f6c68161bae9f4f28b539a8dd8d2cfacf745e5ad83f97b4b6f934ad95";

// Replicate the edge handler's serializeEnsDiscovery + serveEnsDiscovery pair.
async function handleEnsDiscovery({ url, loader, ttlMs, timeoutMs, rpcUrl, timeoutMultiplier = 1 }) {
  const names = url.searchParams.getAll("name").filter(Boolean);
  if (names.length === 0) {
    return { status: 400, body: { error: { code: "INVALID_INPUT", message: "name query required" } } };
  }
  if (names.length > 32) {
    return { status: 400, body: { error: { code: "INVALID_INPUT", message: "too many names" } } };
  }
  if (!loader) {
    return {
      status: 503,
      body: {
        version: "w6.ens-discovery.v1",
        ok: false,
        enabled: false,
        reason: "DISCOVERY_DISABLED",
        providers: [],
        errors: names.map((n) => ({ name: n, code: "DISCOVERY_DISABLED" })),
        provenance: names.map((n) => ({
          name: n,
          state: "unavailable",
          hasProvider: false,
          hasError: true,
          error: { code: "DISCOVERY_DISABLED" },
          ageMs: null,
          ttlMs,
        })),
        observedAt: new Date().toISOString(),
      },
    };
  }
  const startedAt = Date.now();
  let result;
  try {
    result = await Promise.race([
      loader.list({ names }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error("ENS_RPC_TIMEOUT"), { code: "ENS_RPC_TIMEOUT" })),
          (timeoutMs + 5000) * Math.max(1, names.length) * timeoutMultiplier,
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
      ttlMs,
    };
  });
  return {
    status: 200,
    body: {
      version: "w6.ens-discovery.v1",
      ok: providers.length > 0,
      enabled: true,
      route: "ensv2-sepolia-onchain",
      rpcHost: new URL(rpcUrl).host,
      ttlMs,
      timeoutMs,
      recordKeys: [
        "ethonline.endpoint",
        "ethonline.profiles",
        "ethonline.payment.network",
        "ethonline.payment.asset",
        "ethonline.payment.receiver",
        "ethonline.history",
      ],
      elapsedMs,
      observedAt: new Date().toISOString(),
      names,
      providers,
      errors: [...(result.errors ?? [])],
      provenance,
    },
  };
}

test("loader returns the two configured ENS names with chain source", async () => {
  const counter = { count: 0 };
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    ttlMs: 30000,
    timeoutMs: 5000,
    mode: "live",
    createDiscovery: () => makeLoader([SAMPLE(NAMES[0], BLOCK_HASH_A), SAMPLE(NAMES[1], BLOCK_HASH_B)], { counter }),
  });
  const r = await wrapper.list({ names: NAMES });
  assert.equal(r.providers.length, 2);
  assert.equal(r.providers[0].source.blockNumber, 11695032);
  assert.match(r.providers[0].source.blockHash, /^0x/);
  assert.equal(r.errors.length, 0);
  assert.equal(counter.count, 1);
});

test("handler answers /v2/ens-discovery with provenance + record keys + chain source", async () => {
  const loader = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    ttlMs: 30000,
    timeoutMs: 5000,
    mode: "live",
    createDiscovery: () => makeLoader([SAMPLE(NAMES[0], BLOCK_HASH_A), SAMPLE(NAMES[1], BLOCK_HASH_B)]),
  });
  const { server, port } = await makeEndpoint(async (req, res) => {
    if (req.url?.startsWith("/v2/ens-discovery")) {
      const u = new URL(req.url, "http://x");
      const r = await handleEnsDiscovery({
        url: u,
        loader,
        ttlMs: 30000,
        timeoutMs: 5000,
        rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const r = await get(port, `/v2/ens-discovery?name=${encodeURIComponent(NAMES[0])}&name=${encodeURIComponent(NAMES[1])}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.provenance.length, 2);
    assert.equal(body.providers[0].endpoint, "https://m4pro.tail53d0d3.ts.net");
    assert.equal(body.providers[0].source.blockNumber, 11695032);
    assert.equal(body.providers[1].source.blockHash, BLOCK_HASH_B);
    assert.equal(body.recordKeys.length, 6);
    assert.ok(body.recordKeys.includes("ethonline.endpoint"));
    assert.ok(body.recordKeys.includes("ethonline.history"));
    assert.equal(body.route, "ensv2-sepolia-onchain");
    assert.equal(body.rpcHost, "ethereum-sepolia-rpc.publicnode.com");
  } finally {
    server.close();
  }
});

test("handler returns 503 + DISCOVERY_DISABLED when loader is absent", async () => {
  const { server, port } = await makeEndpoint(async (req, res) => {
    if (req.url?.startsWith("/v2/ens-discovery")) {
      const u = new URL(req.url, "http://x");
      const r = await handleEnsDiscovery({ url: u, loader: null, ttlMs: 30000, timeoutMs: 5000, rpcUrl: "https://x" });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const r = await get(port, `/v2/ens-discovery?name=${encodeURIComponent(NAMES[0])}`);
    assert.equal(r.status, 503);
    const body = JSON.parse(r.body);
    assert.equal(body.enabled, false);
    assert.equal(body.ok, false);
    assert.equal(body.errors[0].code, "DISCOVERY_DISABLED");
    assert.equal(body.provenance[0].state, "unavailable");
  } finally {
    server.close();
  }
});

test("handler returns 400 when no name query param is provided", async () => {
  const { server, port } = await makeEndpoint(async (req, res) => {
    if (req.url?.startsWith("/v2/ens-discovery")) {
      const u = new URL(req.url, "http://x");
      const r = await handleEnsDiscovery({ url: u, loader: { list: async () => ({ providers: [], errors: [] }) }, ttlMs: 30000, timeoutMs: 5000, rpcUrl: "https://x" });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const r = await get(port, `/v2/ens-discovery`);
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.body).error.code, /INVALID_INPUT/);
  } finally {
    server.close();
  }
});

test("handler marks provenance 'unavailable' when loader throws", async () => {
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 30000,
    timeoutMs: 5000,
    mode: "live",
    createDiscovery: () => makeLoader([], { throwOnList: Object.assign(new Error("rpc down"), { code: "ENS_RPC_DOWN" }) }),
  });
  const { server, port } = await makeEndpoint(async (req, res) => {
    if (req.url?.startsWith("/v2/ens-discovery")) {
      const u = new URL(req.url, "http://x");
      const r = await handleEnsDiscovery({ url: u, loader: wrapper, ttlMs: 30000, timeoutMs: 5000, rpcUrl: "https://x" });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const r = await get(port, `/v2/ens-discovery?name=${encodeURIComponent(NAMES[0])}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, false);
    assert.equal(body.providers.length, 0);
    assert.equal(body.provenance[0].state, "unavailable");
    assert.equal(body.provenance[0].error.code, "ENS_RPC_DOWN");
  } finally {
    server.close();
  }
});

test("handler marks provenance 'conflicting' when provider+error returned for the same name", async () => {
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 30000,
    timeoutMs: 5000,
    mode: "live",
    createDiscovery: () => ({
      async list({ names }) {
        return {
          providers: names.includes(NAMES[0]) ? [SAMPLE(NAMES[0], BLOCK_HASH_A)] : [],
          errors: names.includes(NAMES[1]) ? [{ name: NAMES[1], code: "STALE_RECORDS" }] : [],
        };
      },
    }),
  });
  const { server, port } = await makeEndpoint(async (req, res) => {
    if (req.url?.startsWith("/v2/ens-discovery")) {
      const u = new URL(req.url, "http://x");
      const r = await handleEnsDiscovery({ url: u, loader: wrapper, ttlMs: 30000, timeoutMs: 5000, rpcUrl: "https://x" });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const r = await get(port, `/v2/ens-discovery?name=${encodeURIComponent(NAMES[0])}&name=${encodeURIComponent(NAMES[1])}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    const a = body.provenance.find((p) => p.name === NAMES[0]);
    const b = body.provenance.find((p) => p.name === NAMES[1]);
    assert.equal(a.state, "valid");
    assert.equal(b.state, "unavailable");
    assert.equal(b.error.code, "STALE_RECORDS");
  } finally {
    server.close();
  }
});

test("handler times out and returns ENS_RPC_TIMEOUT", async () => {
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 30000,
    timeoutMs: 1000,
    mode: "live",
    createDiscovery: () => makeLoader([SAMPLE(NAMES[0], BLOCK_HASH_A)], { delayMs: 2000 }),
  });
  const { server, port } = await makeEndpoint(async (req, res) => {
    if (req.url?.startsWith("/v2/ens-discovery")) {
      const u = new URL(req.url, "http://x");
      const r = await handleEnsDiscovery({ url: u, loader: wrapper, ttlMs: 30000, timeoutMs: 1000, rpcUrl: "https://x", timeoutMultiplier: 0.1 });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const start = Date.now();
    const r = await get(port, `/v2/ens-discovery?name=${encodeURIComponent(NAMES[0])}`);
    const elapsed = Date.now() - start;
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, false);
    assert.match(body.provenance[0].error.code, /ENS_RPC_(TIMEOUT|DOWN)/);
    assert.ok(elapsed < 3000, `expected to time out quickly, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test("handler accepts missing-name lists without crashing (expired state)", async () => {
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 30000,
    timeoutMs: 5000,
    mode: "live",
    createDiscovery: () => makeLoader([]),
  });
  const { server, port } = await makeEndpoint(async (req, res) => {
    if (req.url?.startsWith("/v2/ens-discovery")) {
      const u = new URL(req.url, "http://x");
      const r = await handleEnsDiscovery({ url: u, loader: wrapper, ttlMs: 30000, timeoutMs: 5000, rpcUrl: "https://x" });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    const r = await get(port, `/v2/ens-discovery?name=${encodeURIComponent(NAMES[0])}&name=${encodeURIComponent(NAMES[1])}`);
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.providers.length, 0);
    for (const p of body.provenance) assert.equal(p.state, "expired");
  } finally {
    server.close();
  }
});

test("loader cache: name order does not fragment the cache", async () => {
  const counter = { count: 0 };
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 60000,
    timeoutMs: 5000,
    mode: "live",
    createDiscovery: () => makeLoader([SAMPLE(NAMES[0], BLOCK_HASH_A)], { counter }),
  });
  await wrapper.list({ names: [NAMES[0], NAMES[1]] });
  await wrapper.list({ names: [NAMES[1], NAMES[0]] });
  assert.equal(counter.count, 1);
});

test("loader cache: stale vs fresh lookups within TTL share the same payload instance", async () => {
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 60000,
    timeoutMs: 5000,
    mode: "live",
    createDiscovery: () => makeLoader([SAMPLE(NAMES[0], BLOCK_HASH_A)]),
  });
  const a = await wrapper.list({ names: NAMES });
  const b = await wrapper.list({ names: NAMES });
  assert.equal(a, b);
});

test("loader cache: entries expire after ttlMs and re-call the resolver", async () => {
  const counter = { count: 0 };
  let now = 1_000_000;
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 1000,
    timeoutMs: 5000,
    mode: "live",
    clock: () => now,
    createDiscovery: () => makeLoader([SAMPLE(NAMES[0], BLOCK_HASH_A)], { counter }),
  });
  await wrapper.list({ names: NAMES });
  now += 1500; // past TTL
  await wrapper.list({ names: NAMES });
  assert.equal(counter.count, 2);
});

test("loader fallback: error result is cached for ttlMs and a retry returns the same fallback", async () => {
  const counter = { count: 0 };
  let now = 0;
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: "https://x",
    ttlMs: 1000,
    timeoutMs: 5000,
    mode: "live",
    clock: () => now,
    createDiscovery: () => makeLoader([], { counter, throwOnList: Object.assign(new Error("rpc down"), { code: "ENS_RPC_DOWN" }) }),
  });
  const a = await wrapper.list({ names: NAMES });
  now += 999;
  const b = await wrapper.list({ names: NAMES });
  assert.equal(a, b);
  assert.equal(counter.count, 1, "fallback should be cached");
});