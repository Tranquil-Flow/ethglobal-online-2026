import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, namehash } from "viem";
import { localChain } from "./local-chain.mjs";
import { artifact } from "../src/artifacts.mjs";
import { digestOf } from "../../contracts/index.mjs";
import { createEnsV2Resolver } from "../src/ensv2.mjs";
import { createDiscovery } from "../src/index.mjs";
import { previewOperation } from "../src/operator.mjs";
test("dry-run exact calldata grants/revokes only service keys and is executable locally", async () => {
  const env = await localChain();
  try {
    const options = {
      mode: "development",
      rpcUrl: env.url,
      universal: env.universal,
      root: env.root,
      name: "worker.example.eth",
      owner: env.accounts[0],
      delegate: env.accounts[1],
      operation: "grant",
    };
    const before = await env.client.getBlockNumber({ cacheTime: 0 });
    const plan = await previewOperation(options);
    assert.equal(plan.transactions.length, 2);
    assert.equal(await env.client.getBlockNumber({ cacheTime: 0 }), before);
    assert.equal(plan.broadcast, false);
    for (const tx of plan.transactions) {
      const decoded = decodeFunctionData({
        abi: artifact("PermissionedResolverImpl").abi,
        data: tx.data,
      });
      assert.equal(decoded.functionName, "authorizeTextRoles");
      assert.ok(
        ["ethonline.endpoint", "ethonline.profiles"].includes(decoded.args[1]),
      );
      assert.equal(tx.to.toLowerCase(), env.resolver.toLowerCase());
      assert.equal(tx.value, "0");
      const hash = await env.wallet.sendTransaction({ ...tx, value: 0n });
      assert.equal(
        (await env.client.waitForTransactionReceipt({ hash })).status,
        "success",
      );
    }
    const serviceUpdate = await previewOperation({
      ...options,
      operation: "update",
      actor: env.accounts[1],
      records: { "ethonline.endpoint": "http://127.0.0.1:4330" },
    });
    assert.equal(serviceUpdate.from, env.accounts[1]);
    for (const tx of serviceUpdate.transactions)
      await env.client.waitForTransactionReceipt({
        hash: await env.delegate.sendTransaction({ ...tx, value: 0n }),
      });
    const revoked = await previewOperation({ ...options, operation: "revoke" });
    for (const tx of revoked.transactions)
      await env.client.waitForTransactionReceipt({
        hash: await env.wallet.sendTransaction({ ...tx, value: 0n }),
      });
    await assert.rejects(
      env.write(
        env.resolver,
        "PermissionedResolverImpl",
        "setText",
        [namehash(options.name), "ethonline.endpoint", "http://127.0.0.1:4331"],
        env.delegate,
      ),
    );
    await assert.rejects(
      previewOperation({
        ...options,
        operation: "update",
        records: { "ethonline.payment.receiver": "attacker" },
      }),
      { code: "UNOWNED_RECORD" },
    );
    const records = {
      "ethonline.endpoint": "http://127.0.0.1:4330",
      "ethonline.profiles": JSON.stringify([digestOf("synthetic")]),
      "ethonline.payment.network": "test",
      "ethonline.payment.asset": "test",
      "ethonline.payment.receiver": "owner-payment",
    };
    const provision = await previewOperation({
      ...options,
      name: "new.example.eth",
      operation: "provision",
      factory: env.factory,
      implementation: env.implementation,
      salt: "1",
      expiry: String((await env.client.getBlock()).timestamp + 600n),
      records,
    });
    assert.equal(provision.transactions.length, 4);
    for (const tx of provision.transactions) {
      const hash = await env.wallet.sendTransaction({ ...tx, value: 0n });
      assert.equal(
        (await env.client.waitForTransactionReceipt({ hash })).status,
        "success",
      );
    }
    const port = createDiscovery({
      config: { mode: "development", allowLoopback: true },
      resolver: createEnsV2Resolver({ ...options }),
    });
    assert.equal(
      (await port.list({ names: ["new.example.eth"] })).providers[0]
        ?.paymentReceiver,
      "owner-payment",
    );
    const update = await previewOperation({
      ...options,
      name: "new.example.eth",
      operation: "update",
      records: { "ethonline.endpoint": "http://127.0.0.1:4331" },
    });
    for (const tx of update.transactions)
      await env.client.waitForTransactionReceipt({
        hash: await env.wallet.sendTransaction({ ...tx, value: 0n }),
      });
    port.invalidate();
    assert.equal(
      (await port.list({ names: ["new.example.eth"] })).providers[0]?.endpoint,
      "http://127.0.0.1:4331",
    );
  } finally {
    await env.close();
  }
});
