import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repoint from "../ens-wave6-repoint.mjs";
import { localChain } from "../../packages/discovery/test/local-chain.mjs";
const { Interface, namehash, JsonRpcProvider, Contract } = createRequire(
  new URL("../../packages/indexing/package.json", import.meta.url),
)("ethers");
const abi = new Interface([
  "function setText(bytes32 node,string key,string value)",
]);
const records = {
  "ethonline.endpoint": "https://m4pro.tail53d0d3.ts.net",
  "ethonline.profiles": JSON.stringify(["sha256:" + "a".repeat(64)]),
  "ethonline.payment.network": "hedera:testnet",
  "ethonline.payment.asset": "0.0.0",
  "ethonline.payment.receiver": "0.0.1001",
  "ethonline.history": "https://example.org/history",
};
const snapshot = (
  name = "service.ethonline-node-a.eth",
  resolver = "0x1111111111111111111111111111111111111111",
) => ({
  name,
  mode: "live",
  chainId: "11155111",
  blockNumber: "12",
  blockHash: "0x" + "b".repeat(64),
  records: Object.fromEntries(Object.keys(records).map((k) => [k, "old"])),
  verification: { resolver },
});
test("explicit public-DNS lookup is used but private answers still fail closed", async () => {
  let called = false;
  await assert.rejects(
    repoint.probeWave6PublicOrigin("https://example.org", {
      lookup: async () => {
        called = true;
        return [{ address: "100.84.252.4", family: 4 }];
      },
    }),
    { code: "PUBLIC_ORIGIN_UNREACHABLE" },
  );
  assert.equal(called, true);
});
test("six existing-name records encode exact owner setText calls to the resolver proxy, never provision", () => {
  const before = snapshot();
  const p = repoint.buildWave6RecordUpdate(before, records);
  assert.equal(p.operation, "update");
  assert.equal(p.transactions.length, 6);
  assert.equal(p.blockNumber, "12");
  assert.equal(p.blockHash, before.blockHash);
  for (const [i, [key, value]] of Object.entries(records).entries()) {
    const tx = p.transactions[i];
    assert.equal(tx.to, before.verification.resolver);
    assert.equal(tx.value, "0");
    const decoded = abi.parseTransaction({ data: tx.data });
    assert.equal(decoded.name, "setText");
    assert.deepEqual([...decoded.args], [namehash(before.name), key, value]);
  }
});
test("unchanged names produce zero transactions, partial drift produces only exact changed record", () => {
  const before = { ...snapshot(), records: { ...records } };
  const none = repoint.buildWave6RecordUpdate(before, records);
  assert.deepEqual(none.transactions, []);
  assert.equal(none.skip, true);
  const changed = repoint.buildWave6RecordUpdate(before, {
    ...records,
    "ethonline.payment.network": "hedera:other",
  });
  assert.equal(changed.transactions.length, 1);
  assert.equal(
    abi.parseTransaction({ data: changed.transactions[0].data }).args[1],
    "ethonline.payment.network",
  );
});
test(
  "real local EVM executes all six generated calls and repeated readback has no new writes",
  { timeout: 90000 },
  async () => {
    let chain, provider;
    const directory = await mkdtemp(join(tmpdir(), "w6-six-records-"));
    try {
      chain = await localChain();
      provider = new JsonRpcProvider(chain.url, undefined, {
        cacheTimeout: -1,
      });
      const name = "worker.example.eth",
        before = snapshot(name, chain.resolver);
      const p = repoint.buildWave6RecordUpdate(before, records);
      const intents = p.intents;
      assert.deepEqual(
        intents.map(({ to, data, value }) => ({ to, data, value })),
        p.transactions,
      );
      const signer = await provider.getSigner(chain.accounts[0]);
      let signatures = 0;
      const wallet = {
        address: chain.accounts[0],
        signTransaction: (tx) => {
          signatures++;
          return signer.signTransaction(tx);
        },
      };
      const options = {
        provider,
        wallet,
        journalDirectory: join(directory, "journal"),
        planDigest: "sha256:" + "c".repeat(64),
        intents,
        chainId: 31337,
        confirmations: 1,
        perTransactionLimitWei: 10n ** 17n,
        totalLimitWei: 10n ** 18n,
        maximumGasPriceWei: 100n * 10n ** 9n,
      };
      const result = await repoint.executeJournaledTransactions(options);
      assert.equal(result.transactions.length, 6);
      assert(result.transactions.every((t) => t.status === "confirmed"));
      const contract = new Contract(
        chain.resolver,
        ["function text(bytes32 node,string key) view returns (string)"],
        provider,
      );
      const actual = {};
      for (const key of Object.keys(records))
        actual[key] = await contract.text(namehash(name), key);
      assert.deepEqual(actual, records);
      assert.deepEqual(
        repoint.buildWave6RecordUpdate({ ...before, records: actual }, records)
          .transactions,
        [],
      );
      const noChanges = repoint.buildWave6RecordUpdate(
        { ...before, records: actual },
        records,
      );
      const skipped = await repoint.executeJournaledTransactions({
        ...options,
        journalDirectory: join(directory, "already-current"),
        intents: noChanges.intents,
      });
      assert(skipped.transactions.every((t) => t.status === "unchanged"));
      assert.equal(signatures, 6, "a fully unchanged target must never sign");
      const resumed = await repoint.executeJournaledTransactions({
        ...options,
        intents: noChanges.intents,
      });
      assert.equal(signatures, 6);
      assert.equal(resumed.transactions.length, 6);
      assert.deepEqual(
        resumed.transactions.map((t) => t.transactionHash),
        result.transactions.map((t) => t.transactionHash),
      );
    } finally {
      provider?.destroy();
      await chain?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
