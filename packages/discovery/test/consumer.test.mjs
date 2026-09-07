import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createProviderReader } from "../src/consumer.mjs";
import { createDiscovery } from "../src/index.mjs";
import { digestOf } from "../../contracts/index.mjs";
test("consumer re-resolves and refuses tampered endpoint before actual HTTP", async () => {
  let requests = 0,
    reads = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.end("development");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const config = { mode: "development", allowLoopback: true };
    const discovery = createDiscovery({
      config,
      resolver: {
        resolve: async ({ name }) => {
          reads++;
          return {
            name,
            mode: "development",
            chainId: "31337",
            blockNumber: 1,
            blockHash: "0x" + "ab".repeat(32),
            resolvedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 10000).toISOString(),
            records: {
              "ethonline.endpoint": `http://127.0.0.1:${server.address().port}`,
              "ethonline.profiles": JSON.stringify([digestOf("profile")]),
              "ethonline.payment.network": "test",
              "ethonline.payment.asset": "test",
              "ethonline.payment.receiver": "test",
            },
          };
        },
      },
    });
    const {
      providers: [provider],
    } = await discovery.list({ names: ["worker.example.eth"] });
    const reader = createProviderReader({ discovery, config });
    assert.equal((await reader.get({ provider })).toString(), "development");
    assert.equal(reads, 2);
    assert.equal(requests, 1);
    await assert.rejects(
      reader.get({ provider: { ...provider, endpoint: "http://127.0.0.1:9" } }),
      { code: "PROVIDER_CHANGED" },
    );
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
