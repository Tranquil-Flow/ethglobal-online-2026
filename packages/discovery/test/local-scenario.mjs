import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
async function cli(config, names) {
  const dir = await mkdtemp(new URL("../.tmp-", import.meta.url).pathname);
  try {
    const path = dir + "/config.json";
    await writeFile(path, JSON.stringify(config));
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          new URL("../src/cli.mjs", import.meta.url).pathname,
          "list",
          path,
          ...names,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let timer = setTimeout(() => {
        child.kill();
        reject(new Error("CLI timeout"));
      }, 10000);
      child.stdout.on("data", (b) => {
        out += b;
        if (out.length > 65536) {
          child.kill();
          reject(new Error("CLI bounds"));
        }
      });
      child.stderr.resume();
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error("CLI failed"));
        else resolve(JSON.parse(out));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

import { namehash, toHex } from "viem";
import { packetToBytes } from "viem/ens";
import { localChain } from "./local-chain.mjs";
import { createEnsV2Resolver } from "../src/ensv2.mjs";
import { createDiscovery } from "../src/index.mjs";
import { digestOf } from "../../contracts/index.mjs";
const name = "worker.example.eth",
  profile = digestOf("synthetic-profile");
export async function exerciseLocal() {
  const env = await localChain();
  try {
    const { write, resolver, delegate, accounts } = env;
    const records = {
      "ethonline.endpoint": "http://127.0.0.1:4330",
      "ethonline.profiles": JSON.stringify([profile]),
      "ethonline.payment.network": "hedera:testnet",
      "ethonline.payment.asset": "HBAR",
      "ethonline.payment.receiver": "0.0.123",
    };
    for (const [k, v] of Object.entries(records))
      await write(resolver, "PermissionedResolverImpl", "setText", [
        namehash(name),
        k,
        v,
      ]);
    const adapter = createEnsV2Resolver({
      rpcUrl: env.url,
      mode: "development",
      universal: env.universal,
      root: env.root,
      ttlMs: 1000,
    });
    const port = createDiscovery({
      config: { mode: "development", allowLoopback: true },
      resolver: adapter,
    });
    const before = await port.list({ names: [name] });
    assert.equal(before.providers.length, 1, JSON.stringify(before.errors));
    const cliResult = await cli(
      {
        rpcUrl: env.url,
        mode: "development",
        allowLoopback: true,
        universal: env.universal,
        root: env.root,
      },
      [name],
    );
    assert.equal(cliResult.providers[0]?.paymentReceiver, "0.0.123");
    const p = before.providers[0];
    assert.equal(p.paymentReceiver, "0.0.123");
    assert.equal(p.source.chainId, "31337");
    assert.match(p.source.blockHash, /^0x[0-9a-f]{64}$/);
    const quote = {
      version: "1",
      quoteId: "local-q",
      requestHash: digestOf("synthetic-request"),
      providerId: name,
      profileId: profile,
      amountBaseUnits: "9",
      asset: "HBAR",
      network: "hedera:testnet",
      receiver: "0.0.123",
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      mode: "development",
    };
    const select = (providers) =>
      port.select({
        providers,
        quotes: [quote],
        profileId: profile,
        maxAmountBaseUnits: "10",
        network: "hedera:testnet",
        asset: "HBAR",
      });
    assert.equal((await select(before.providers)).selected.name, name);
    for (const k of ["ethonline.endpoint", "ethonline.profiles"])
      await write(resolver, "PermissionedResolverImpl", "authorizeTextRoles", [
        toHex(packetToBytes(name)),
        k,
        accounts[1],
        true,
      ]);
    for (const k of [
      "ethonline.payment.receiver",
      "ethonline.payment.network",
      "ethonline.payment.asset",
    ])
      await assert.rejects(
        write(
          resolver,
          "PermissionedResolverImpl",
          "setText",
          [namehash(name), k, "attacker"],
          delegate,
        ),
        { code: "LOCAL_REVERT" },
      );
    await write(
      resolver,
      "PermissionedResolverImpl",
      "setText",
      [
        namehash(name),
        "ethonline.profiles",
        JSON.stringify([digestOf("other-profile")]),
      ],
      delegate,
    );
    port.invalidate(name);
    const after = await port.list({ names: [name] });
    assert.equal(after.providers.length, 1);
    assert.equal((await select(after.providers)).selected, null);
    for (const k of ["ethonline.endpoint", "ethonline.profiles"])
      await write(resolver, "PermissionedResolverImpl", "authorizeTextRoles", [
        toHex(packetToBytes(name)),
        k,
        accounts[1],
        false,
      ]);
    await assert.rejects(
      write(
        resolver,
        "PermissionedResolverImpl",
        "setText",
        [namehash(name), "ethonline.endpoint", "https://example.com"],
        delegate,
      ),
      { code: "LOCAL_REVERT" },
    );
    // A name-level or root grant is never given to the service delegate.
    await assert.rejects(
      write(
        resolver,
        "PermissionedResolverImpl",
        "authorizeTextRoles",
        [
          toHex(packetToBytes(name)),
          "ethonline.payment.receiver",
          accounts[1],
          true,
        ],
        delegate,
      ),
      { code: "LOCAL_REVERT" },
    );
    const snapshot = await env.client.request({ method: "evm_snapshot" });
    await write(resolver, "PermissionedResolverImpl", "setText", [
      namehash(name),
      "ethonline.endpoint",
      "http://127.0.0.1:4331",
    ]);
    port.invalidate();
    assert.equal(
      (await port.list({ names: [name] })).providers[0]?.endpoint,
      "http://127.0.0.1:4331",
    );
    assert.equal(
      await env.client.request({ method: "evm_revert", params: [snapshot] }),
      true,
    );
    assert.equal(
      (await port.list({ names: [name] })).providers[0]?.endpoint,
      "http://127.0.0.1:4330",
    );
    await write(resolver, "PermissionedResolverImpl", "setAlias", [
      toHex(packetToBytes(name)),
      toHex(packetToBytes("other.example.eth")),
    ]);
    port.invalidate();
    assert.equal(
      (await port.list({ names: [name] })).errors[0]?.code,
      "ALIAS_UNSUPPORTED",
    );
    await write(resolver, "PermissionedResolverImpl", "setAlias", [
      toHex(packetToBytes(name)),
      "0x",
    ]);
    await write(resolver, "PermissionedResolverImpl", "setText", [
      namehash(name),
      "ethonline.profiles",
      "malformed",
    ]);
    port.invalidate();
    assert.equal((await port.list({ names: [name] })).providers.length, 0);
    await write(resolver, "PermissionedResolverImpl", "setText", [
      namehash(name),
      "ethonline.profiles",
      JSON.stringify([profile]),
    ]);
    await write(resolver, "PermissionedResolverImpl", "setText", [
      namehash(name),
      "ethonline.endpoint",
      "https://169.254.169.254",
    ]);
    port.invalidate();
    assert.equal(
      (await port.list({ names: [name] })).errors[0]?.code,
      "UNSAFE_URL",
    );
    await env.client.request({ method: "evm_increaseTime", params: [3601] });
    await env.client.request({ method: "evm_mine" });
    const expiredBlock = await env.client.getBlock(),
      expiredClock = () => new Date(Number(expiredBlock.timestamp) * 1000);
    const expiredPort = createDiscovery({
      config: { mode: "development", allowLoopback: true },
      clock: expiredClock,
      resolver: createEnsV2Resolver({
        rpcUrl: env.url,
        mode: "development",
        universal: env.universal,
        root: env.root,
        clock: expiredClock,
      }),
    });
    const expired = await expiredPort.list({ names: [name] });
    assert.equal(expired.providers.length, 0);
    assert.equal(expired.errors[0]?.code, "NONCANONICAL_NAME");
    return {
      unsafeOnchainEndpointRejected: true,
      reorgInvalidated: true,
      aliasRejected: true,
      expiredParentRejected: true,
      mode: "development",
      contracts: "official pinned ENSv2 bytecode on local Anvil",
      blockBefore: p.source.blockNumber,
      blockAfter: after.providers[0].source.blockNumber,
      blockHash: p.source.blockHash,
      cliRpcRead: true,
      delegatedServiceUpdate: true,
      paymentEditsRejected: 3,
      revocationRejected: true,
      selectionChanged: true,
      malformedRejected: true,
    };
  } finally {
    await env.close();
  }
}
