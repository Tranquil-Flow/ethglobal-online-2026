import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { safeUrl, safeGet, publicAddress } from "../src/url-policy.mjs";
import { createDiscovery } from "../src/index.mjs";
test("URL policy rejects credentials, schemes, private IPs and bypass spellings", () => {
  for (const url of [
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "http://example.com",
    "https://10.0.0.1",
    "https://169.254.169.254",
    "https://127.1",
    "https://2130706433",
    "https://[::ffff:127.0.0.1]",
    "https://[fc00::1]",
    "https://localhost",
    "https://example.local",
    "https://example.com?token=synthetic",
    "https://example.com/#fragment",
  ])
    assert.throws(() => safeUrl(url, { mode: "live" }), { code: "UNSAFE_URL" });
  assert.equal(
    safeUrl("https://example.com", { mode: "live" }).protocol,
    "https:",
  );
  assert.throws(() =>
    safeUrl("http://10.0.0.1", { mode: "development", allowLoopback: true }),
  );
  for (const ip of [
    "10.0.0.1",
    "0.0.0.0",
    "127.0.0.1",
    "169.254.1.2",
    "100.64.0.1",
    "192.168.1.1",
    "::1",
    "::ffff:10.0.0.1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
});
test("actual consuming HTTP fetch: no credentials, redirects blocked, body/deadline/abort bounded", async () => {
  let requests = 0,
    headers;
  const server = http.createServer((req, res) => {
    requests++;
    headers = req.headers;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/forbidden" }).end();
    } else if (req.url === "/large") {
      res.end("x".repeat(100));
    } else if (req.url === "/slow") {
    } else res.end('{"mode":"development"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`,
    options = { mode: "development", allowLoopback: true };
  try {
    assert.equal(
      (await safeGet(base, options)).toString(),
      '{"mode":"development"}',
    );
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    const before = requests;
    await assert.rejects(safeGet(base + "/redirect", options), {
      code: "HTTP_REJECTED",
    });
    assert.equal(requests, before + 1);
    await assert.rejects(
      safeGet(base + "/large", { ...options, maxBytes: 10 }),
      { code: "LIMIT" },
    );
    await assert.rejects(
      safeGet(base + "/slow", { ...options, timeoutMs: 20 }),
      { code: "TIMEOUT" },
    );
    const ac = new AbortController();
    const request = safeGet(base + "/slow", { ...options, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(request, { code: "ABORTED" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("DNS private/mixed answers blocked before connection, never re-resolved for socket", async () => {
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 }],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
  ]) {
    let calls = 0;
    await assert.rejects(
      safeGet("https://example.com", {
        mode: "live",
        lookup: async () => {
          calls++;
          return addresses;
        },
      }),
      { code: "UNSAFE_ADDRESS" },
    );
    assert.equal(calls, 1);
  }
});
test("no constructor side effects, explicit mode and live route; raw errors do not leak", async () => {
  let reads = 0;
  const resolver = {
    resolve: async () => {
      reads++;
      throw new Error("SYNTHETIC_PRIVATE_CANARY");
    },
  };
  assert.throws(() => createDiscovery({ resolver }), {
    code: "EXPLICIT_MODE_REQUIRED",
  });
  assert.throws(() => createDiscovery({ config: { mode: "live" }, resolver }), {
    code: "UNSUPPORTED_ROUTE",
  });
  const d = createDiscovery({ config: { mode: "development" }, resolver });
  assert.equal(reads, 0);
  const result = await d.list({ names: ["worker.example.eth"] });
  assert.equal(reads, 1);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_CANARY"));
});
