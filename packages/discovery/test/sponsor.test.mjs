import { test } from "node:test";
import assert from "node:assert/strict";
import { namehash } from "viem";
import { digestOf } from "../../contracts/index.mjs";
import {
  collectEnsV2Config,
  createEnsV2Discovery,
  preflightEnsV2,
} from "../src/index.mjs";
import { localChain } from "./local-chain.mjs";

function inputs(env, overrides = {}) {
  return {
    mode: "development",
    rpcUrl: env.url,
    universal: env.universal,
    root: env.root,
    names: ["worker.example.eth"],
    allowLoopback: true,
    ...overrides,
  };
}

test("ENSv2 collector rejects secrets, unsafe live RPC and ambiguous names", async () => {
  assert.throws(
    () =>
      collectEnsV2Config({
        mode: "live",
        rpcUrl: "http://127.0.0.1:8545",
        names: ["worker.example.eth"],
      }),
    { code: "UNSAFE_URL" },
  );
  assert.throws(
    () =>
      collectEnsV2Config({
        mode: "live",
        rpcUrl: "https://rpc.example",
        names: ["worker.example.eth"],
        privateKey: "secret",
      }),
    { code: "UNEXPECTED_CONFIG_FIELD" },
  );
  assert.throws(
    () =>
      collectEnsV2Config({
        mode: "live",
        rpcUrl: "https://rpc.example",
        names: ["Worker.Example.eth", "worker.example.eth"],
      }),
    { code: "DUPLICATE_NAME" },
  );
});

test(
  "ENSv2 factory and no-broadcast preflight collect current records and unsigned preview",
  { timeout: 60000 },
  async () => {
    const env = await localChain();
    try {
      const records = {
        "ethonline.endpoint": "http://127.0.0.1:4330",
        "ethonline.profiles": JSON.stringify([digestOf("sponsor-profile")]),
        "ethonline.payment.network": "hedera:testnet",
        "ethonline.payment.asset": "HBAR",
        "ethonline.payment.receiver": "0.0.1002",
      };
      for (const [key, value] of Object.entries(records))
        await env.write(env.resolver, "PermissionedResolverImpl", "setText", [
          namehash("worker.example.eth"),
          key,
          value,
        ]);
      const collected = collectEnsV2Config(
        inputs(env, {
          operator: {
            operation: "grant",
            name: "worker.example.eth",
            owner: env.accounts[0],
            delegate: env.accounts[1],
          },
        }),
      );
      assert.ok(Object.isFrozen(collected));
      const discovery = createEnsV2Discovery({ inputs: collected });
      const listed = await discovery.list({ names: collected.names });
      assert.equal(
        listed.providers[0]?.providerId,
        "worker.example.eth",
        JSON.stringify(listed),
      );
      const before = await env.client.getBlockNumber({ cacheTime: 0 });
      const report = await preflightEnsV2({ inputs: collected });
      assert.equal(report.providers[0].providerId, "worker.example.eth");
      assert.equal(report.preview.transactions.length, 2);
      assert.equal(report.broadcast, false);
      assert.equal(report.walletInvoked, false);
      assert.equal(await env.client.getBlockNumber({ cacheTime: 0 }), before);
    } finally {
      await env.close();
    }
  },
);
