// P1-ENS-CENTRAL tests — exercise the cache wrapper + fallback path of
// composition/w6-ens-discovery-loader.mjs against an injected fake
// discovery so the test is offline and deterministic. Real-RPC
// integration is covered by packages/discovery/test/ensv2.test.mjs;
// this file owns the wrapper's contract.

import test from "node:test";
import assert from "node:assert/strict";
import {
  loadProvidersFromEns,
  DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
} from "../w6-ens-discovery-loader.mjs";

// In-memory fake of packages/discovery createEnsV2Discovery. The real
// resolver lives in packages/discovery/src/ensv2.mjs; we only need to
// verify the wrapper's cache + timeout + fallback behaviour, which is
// orthogonal to the resolver itself.
function fakeDiscovery({
  delayMs = 0,
  providers = [],
  errors = [],
  throwOnList = null,
  callCounter = null,
} = {}) {
  return {
    async list({ names, signal }) {
      callCounter && (callCounter.count += 1);
      if (throwOnList) throw throwOnList;
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      return { providers: providers.map((p) => ({ ...p })), errors };
    },
  };
}

const NAMES = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const RPC = "https://eth-sepolia.g.alchemy.com/v2/test";

test("rejects empty names array with TypeError", () => {
  assert.throws(
    () => loadProvidersFromEns({ names: [], rpcUrl: RPC }),
    /names must be a non-empty array/,
  );
});

test("rejects missing rpcUrl with TypeError", () => {
  assert.throws(
    () => loadProvidersFromEns({ names: NAMES }),
    /rpcUrl must be a non-empty string/,
  );
});

test("rejects non-array names with TypeError", () => {
  assert.throws(
    () => loadProvidersFromEns({ names: "not-an-array", rpcUrl: RPC }),
    /names must be a non-empty array/,
  );
});

test("exports the documented defaults (30s cache, 5s timeout)", () => {
  assert.equal(DEFAULT_TTL_MS, 30_000);
  assert.equal(DEFAULT_TIMEOUT_MS, 5_000);
});

test("successful discovery returns providers unchanged", async () => {
  const counter = { count: 0 };
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    createDiscovery: () =>
      fakeDiscovery({
        providers: [
          { name: NAMES[0], endpoint: "https://a.test/v1" },
          { name: NAMES[1], endpoint: "https://b.test/v1" },
        ],
        callCounter: counter,
      }),
  });
  const result = await wrapper.list({ names: NAMES });
  assert.equal(result.providers.length, 2);
  assert.equal(result.providers[0].endpoint, "https://a.test/v1");
  assert.equal(counter.count, 1, "resolver called once");
});

test("cache: repeated lookups within ttlMs do NOT call the resolver again", async () => {
  const counter = { count: 0 };
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    ttlMs: 60_000,
    createDiscovery: () =>
      fakeDiscovery({
        providers: [{ name: NAMES[0] }],
        callCounter: counter,
      }),
  });
  await wrapper.list({ names: NAMES });
  await wrapper.list({ names: NAMES });
  await wrapper.list({ names: NAMES });
  assert.equal(counter.count, 1, "second + third lookups served from cache");
});

test("cache: name order does not fragment the cache", async () => {
  const counter = { count: 0 };
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    ttlMs: 60_000,
    createDiscovery: () =>
      fakeDiscovery({
        providers: [{ name: NAMES[0] }],
        callCounter: counter,
      }),
  });
  await wrapper.list({ names: [NAMES[0], NAMES[1]] });
  await wrapper.list({ names: [NAMES[1], NAMES[0]] });
  assert.equal(counter.count, 1, "sorted key unifies name-order variants");
});

test("cache: entries expire after ttlMs", async () => {
  const counter = { count: 0 };
  let now = 1_000_000;
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    ttlMs: 1_000,
    clock: () => now,
    createDiscovery: () =>
      fakeDiscovery({
        providers: [{ name: NAMES[0] }],
        callCounter: counter,
      }),
  });
  await wrapper.list({ names: NAMES });
  now += 999;
  await wrapper.list({ names: NAMES }); // still in cache
  assert.equal(counter.count, 1);
  now += 2; // past ttl
  await wrapper.list({ names: NAMES }); // expired, resolver called again
  assert.equal(counter.count, 2);
});

test("fallback: ENS RPC error returns empty providers + structured error", async () => {
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    createDiscovery: () =>
      fakeDiscovery({
        throwOnList: Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
        }),
      }),
  });
  const result = await wrapper.list({ names: NAMES });
  assert.equal(result.providers.length, 0);
  assert.equal(result.errors.length, NAMES.length);
  for (const e of result.errors) {
    assert.equal(e.code, "ECONNREFUSED");
    assert.equal(NAMES.includes(e.name), true);
  }
});

test("fallback: timeout returns empty providers + propagates error code", async () => {
  // When the inner abort fires (timer-driven timeout), the underlying
  // error is a DOMException with a numeric code (DOMException.ABORT_ERR).
  // The wrapper must propagate whatever the resolver reported rather
  // than masking it with the synthetic ENS_RPC_UNAVAILABLE — callers
  // want the truth so they can distinguish "RPC timed out" (numeric 20)
  // from "RPC rejected" (string code like "ECONNREFUSED").
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    timeoutMs: 50,
    createDiscovery: () => fakeDiscovery({ delayMs: 5_000 }),
  });
  const t0 = Date.now();
  const result = await wrapper.list({ names: NAMES });
  const elapsed = Date.now() - t0;
  assert.equal(result.providers.length, 0);
  assert.ok(elapsed < 1_000, `expected fast timeout, took ${elapsed}ms`);
  for (const e of result.errors) {
    assert.ok(typeof e.code === "number" || typeof e.code === "string",
      `error.code must be the original (number or string), got ${typeof e.code}: ${e.code}`);
    // It must NOT have been replaced by the synthetic ENS_RPC_UNAVAILABLE
    // sentinel — propagating the real code is the contract.
    assert.notEqual(e.code, "ENS_RPC_UNAVAILABLE");
  }
});

test("fallback: failed lookup is cached for ttlMs to prevent retry storms", async () => {
  const counter = { count: 0 };
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    ttlMs: 60_000,
    createDiscovery: () =>
      fakeDiscovery({
        throwOnList: Object.assign(new Error("flaky"), { code: "ETIMEDOUT" }),
        callCounter: counter,
      }),
  });
  await wrapper.list({ names: NAMES });
  await wrapper.list({ names: NAMES });
  await wrapper.list({ names: NAMES });
  assert.equal(counter.count, 1, "subsequent calls served from failure cache");
});

test("clearCache forces the next call to invoke the resolver", async () => {
  const counter = { count: 0 };
  const wrapper = loadProvidersFromEns({
    names: NAMES,
    rpcUrl: RPC,
    ttlMs: 60_000,
    createDiscovery: () =>
      fakeDiscovery({
        providers: [],
        callCounter: counter,
      }),
  });
  await wrapper.list({ names: NAMES });
  wrapper.clearCache();
  await wrapper.list({ names: NAMES });
  assert.equal(counter.count, 2);
});
