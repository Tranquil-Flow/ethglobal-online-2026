import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { digestOf } from "../../packages/contracts/index.mjs";
import {
  createDiscovery,
  createEnsV2Resolver,
  createProviderReader,
  previewOperation,
} from "../../packages/discovery/src/index.mjs";
import { localChain } from "../../packages/discovery/test/local-chain.mjs";
import {
  executeJournaledTransactions,
  repointWave6Ens,
  validateWave6TargetRecords,
  WAVE6_ENS_NAMES,
  WAVE6_ENS_OWNER,
} from "../ens-wave6-repoint.mjs";

const { JsonRpcProvider, keccak256 } = createRequire(
    new URL("../../packages/indexing/package.json", import.meta.url),
  )("ethers"),
  { namehash } = createRequire(
    new URL("../../packages/discovery/package.json", import.meta.url),
  )("viem");

const profile = (letter) => `sha256:${letter.repeat(64)}`;
const syntheticTargetRecords = (endpoint = "https://gateway.ethonline.dev") =>
  Object.fromEntries(
    WAVE6_ENS_NAMES.map((name, index) => [
      name,
      {
        "ethonline.endpoint": endpoint,
        "ethonline.profiles": JSON.stringify([profile(index ? "b" : "a")]),
        "ethonline.payment.network": "hedera:testnet",
        "ethonline.payment.asset": "0.0.0",
        "ethonline.payment.receiver": index ? "0.0.1002" : "0.0.1001",
        "ethonline.history":
          "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911",
      },
    ]),
  );

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("Wave 6 target records are closed, exact, public, and never the retired route", () => {
  const target = syntheticTargetRecords();
  assert.deepEqual(validateWave6TargetRecords(target), target);

  assert.throws(
    () =>
      validateWave6TargetRecords({
        ...target,
        "attacker.eth": target[WAVE6_ENS_NAMES[0]],
      }),
    { code: "EXACT_WAVE6_NAMES_REQUIRED" },
  );
  assert.throws(
    () =>
      validateWave6TargetRecords({
        ...target,
        [WAVE6_ENS_NAMES[0]]: {
          ...target[WAVE6_ENS_NAMES[0]],
          extra: "not-a-record",
        },
      }),
    { code: "EXACT_TARGET_RECORDS_REQUIRED" },
  );
  // The former tailnet hostname now serves public HTTPS through Funnel.
  // Public reachability is still checked separately before any preview/write.
  assert.deepEqual(
    validateWave6TargetRecords(
      syntheticTargetRecords("https://m4pro.tail53d0d3.ts.net"),
    ),
    syntheticTargetRecords("https://m4pro.tail53d0d3.ts.net"),
  );
  assert.throws(
    () =>
      validateWave6TargetRecords(
        syntheticTargetRecords("https://placeholder.example.invalid"),
      ),
    { code: "PUBLIC_ORIGIN_REQUIRED" },
  );
  assert.throws(
    () =>
      validateWave6TargetRecords(
        syntheticTargetRecords("https://gateway.ethonline.dev/path"),
      ),
    { code: "PUBLIC_ORIGIN_REQUIRED" },
  );
  assert.throws(
    () => {
      const changed = syntheticTargetRecords();
      changed[WAVE6_ENS_NAMES[1]]["ethonline.endpoint"] =
        "https://other.ethonline.dev";
      validateWave6TargetRecords(changed);
    },
    { code: "SHARED_ORIGIN_REQUIRED" },
  );
  assert.throws(
    () => {
      const changed = syntheticTargetRecords();
      changed[WAVE6_ENS_NAMES[0]]["ethonline.profiles"] = "[]";
      validateWave6TargetRecords(changed);
    },
    { code: "PROFILE_DIGEST_REQUIRED" },
  );
});

test("execute approval fails before network, wallet, or journal access", async () => {
  await assert.rejects(
    repointWave6Ens({
      targetRecords: syntheticTargetRecords(),
      execute: true,
      approved: false,
      walletFile: "/must-not-read",
      journalDirectory: "/must-not-create",
    }),
    { code: "EXPLICIT_OWNER_APPROVAL_REQUIRED" },
  );
});

test("execution requires the exact preview digest and literal approval before any access", async () => {
  for (const options of [
    { approved: "true" },
    { approved: true },
    { approved: true, approvedTargetDigest: "sha256:" + "0".repeat(64) },
  ]) {
    await assert.rejects(
      repointWave6Ens({
        targetRecords: syntheticTargetRecords(),
        execute: true,
        walletFile: "/must-not-read",
        journalDirectory: "/must-not-create",
        ...options,
      }),
      (error) =>
        [
          "EXPLICIT_OWNER_APPROVAL_REQUIRED",
          "APPROVED_TARGET_DIGEST_REQUIRED",
        ].includes(error.code),
    );
  }
});

test(
  "actual local EVM journal resumes the same signed transaction and stale routing cannot fetch",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ens-wave6-repoint-"));
    const journalDirectory = join(directory, "journal");
    let chain;
    let oldServer;
    let newServer;
    let provider;
    try {
      let oldRequests = 0;
      let newRequests = 0;
      oldServer = await listen((_request, response) => {
        oldRequests++;
        response.end("retired");
      });
      newServer = await listen((_request, response) => {
        newRequests++;
        response.end("current");
      });
      chain = await localChain();
      const name = "worker.example.eth";
      const records = {
        "ethonline.endpoint": oldServer.url,
        "ethonline.profiles": JSON.stringify([profile("c")]),
        "ethonline.payment.network": "hedera:testnet",
        "ethonline.payment.asset": "0.0.0",
        "ethonline.payment.receiver": "0.0.1001",
        "ethonline.history": `${newServer.url}/history`,
      };
      for (const [key, value] of Object.entries(records))
        await chain.write(
          chain.resolver,
          "PermissionedResolverImpl",
          "setText",
          [namehash(name), key, value],
        );

      const resolver = createEnsV2Resolver({
        mode: "development",
        rpcUrl: chain.url,
        universal: chain.universal,
        root: chain.root,
        ttlMs: 30000,
        timeoutMs: 5000,
      });
      const discovery = createDiscovery({
        config: {
          mode: "development",
          allowLoopback: true,
          maxTtlMs: 60000,
        },
        resolver,
      });
      const beforeResolution = await resolver.resolve({ name });
      assert.equal(
        beforeResolution.verification.resolver.toLowerCase(),
        chain.resolver.toLowerCase(),
      );
      assert.equal(
        beforeResolution.verification.resolverImplementation.toLowerCase(),
        chain.implementation.toLowerCase(),
      );
      assert.equal(beforeResolution.verification.alias, "0x");
      assert.equal(beforeResolution.verification.canonicalRegistries.length, 3);
      assert.equal(
        beforeResolution.verification.postReadBlockHash,
        beforeResolution.blockHash,
      );

      const {
        providers: [staleProvider],
      } = await discovery.list({ names: [name] });
      assert.equal(staleProvider.endpoint, oldServer.url);

      const preview = await previewOperation({
        mode: "development",
        rpcUrl: chain.url,
        universal: chain.universal,
        root: chain.root,
        name,
        owner: chain.accounts[0],
        operation: "update",
        records: { "ethonline.endpoint": newServer.url },
      });
      assert.equal(preview.transactions.length, 1);

      provider = new JsonRpcProvider(chain.url, undefined, {
        cacheTimeout: -1,
      });
      const signer = await provider.getSigner(chain.accounts[0]);
      let signCalls = 0;
      const wallet = {
        address: chain.accounts[0],
        async signTransaction(transaction) {
          signCalls++;
          return signer.signTransaction(transaction);
        },
      };
      let loseAcknowledgement = true;
      const ambiguousProvider = new Proxy(provider, {
        get(target, property) {
          if (property === "broadcastTransaction")
            return async (raw) => {
              const response = await target.broadcastTransaction(raw);
              if (loseAcknowledgement) {
                loseAcknowledgement = false;
                throw Object.assign(
                  new Error("synthetic acknowledgement loss"),
                  {
                    code: "SYNTHETIC_ACK_LOST",
                  },
                );
              }
              return response;
            };
          const value = target[property];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const intent = {
        id: name,
        to: preview.transactions[0].to,
        data: preview.transactions[0].data,
        value: preview.transactions[0].value,
        skip: false,
      };
      const execution = {
        planDigest: digestOf({ name, endpoint: newServer.url }),
        journalDirectory,
        wallet,
        intents: [intent],
        chainId: 31337,
        confirmations: 1,
        perTransactionLimitWei: 10n ** 18n,
        totalLimitWei: 10n ** 18n,
        maximumGasPriceWei: 10n ** 12n,
        initialEvidence: { beforeResolution },
      };

      await assert.rejects(
        executeJournaledTransactions({
          ...execution,
          provider: ambiguousProvider,
        }),
        { code: "SYNTHETIC_ACK_LOST" },
      );
      assert.equal(signCalls, 1);
      const afterLoss = JSON.parse(
        await readFile(join(journalDirectory, "journal.json"), "utf8"),
      );
      assert.equal(
        afterLoss.entries[name].hash,
        keccak256(afterLoss.entries[name].raw),
      );
      assert.equal(afterLoss.failures.at(-1).code, "SYNTHETIC_ACK_LOST");
      assert.equal(
        (await stat(join(journalDirectory, "journal.json"))).mode & 0o777,
        0o600,
      );

      const resumed = await executeJournaledTransactions({
        ...execution,
        provider,
      });
      assert.equal(signCalls, 1, "resume must never create a second signature");
      assert.equal(resumed.transactions.length, 1);
      assert.equal(
        resumed.transactions[0].transactionHash,
        afterLoss.entries[name].hash,
      );
      assert.equal(resumed.transactions[0].status, "confirmed");
      assert.equal(Object.hasOwn(resumed.transactions[0], "raw"), false);
      assert.equal(Object.hasOwn(resumed.transactions[0], "data"), false);

      const differentData =
        intent.data.slice(0, -2) + (intent.data.endsWith("00") ? "01" : "00");
      await assert.rejects(
        executeJournaledTransactions({
          ...execution,
          provider,
          intents: [{ ...intent, data: differentData }],
        }),
        { code: "JOURNAL_CALL_MISMATCH" },
      );
      assert.equal(signCalls, 1, "journal mismatch must fail before signing");

      const reader = createProviderReader({
        discovery,
        config: { mode: "development", allowLoopback: true },
      });
      await assert.rejects(reader.get({ provider: staleProvider }), {
        code: "PROVIDER_CHANGED",
      });
      assert.equal(oldRequests, 0);
      assert.equal(newRequests, 0);

      const {
        providers: [currentProvider],
      } = await discovery.list({ names: [name] });
      assert.equal(currentProvider.endpoint, newServer.url);
      assert.equal(
        (await reader.get({ provider: currentProvider })).toString(),
        "current",
      );
      assert.equal(oldRequests, 0);
      assert.equal(newRequests, 1);

      const afterResolution = await resolver.resolve({ name });
      assert.equal(
        afterResolution.records["ethonline.endpoint"],
        newServer.url,
      );
      assert.equal(
        afterResolution.verification.postReadBlockHash,
        afterResolution.blockHash,
      );
    } finally {
      provider?.destroy();
      await chain?.close();
      await oldServer?.close();
      await newServer?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

assert.equal(WAVE6_ENS_OWNER, "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE");
