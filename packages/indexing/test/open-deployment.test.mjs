import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Contract, keccak256 } from "ethers";
import { compileAll } from "../scripts/compile.mjs";
import { localEvm } from "./local-evm.mjs";
import {
  inspectOpenRegistryDeployment,
  planOpenRegistryDeployment,
} from "../src/index.mjs";

function input(sender, nonce, overrides = {}) {
  return {
    mode: 0,
    chainId: 31337,
    sender,
    nonce,
    confirmations: 2,
    ...overrides,
  };
}

test("compiler metadata selection preserves legacy Registry and RegistryV2 template bytes", () => {
  const compiled = compileAll();
  assert.equal(
    keccak256("0x" + compiled.Registry.evm.bytecode.object),
    "0x184af2760ee7b5e72ac67c3e80b8e7189175fcb4ae09b7f55ddd11ae47b3af4f",
  );
  assert.equal(
    keccak256("0x" + compiled.Registry.evm.deployedBytecode.object),
    "0x8980ec604dd3f6886188d04c11fd81c2e5e5a3aeb46507dd6e1f9b2616034db7",
  );
  assert.equal(
    keccak256("0x" + compiled.RegistryV2.evm.bytecode.object),
    "0xd7ead0be9fbd5398b4152aedf1d241e1e02d9cfebac7b258ac7d23ecac83911b",
  );
  assert.equal(
    keccak256("0x" + compiled.RegistryV2.evm.deployedBytecode.object),
    "0xad6e4ca98c1ddcf32ee6a1054c0d49423df7af90203510bfb8bd51b2b086f496",
  );
});

test("--open-plan is an explicit offline CLI branch", () => {
  const directory = mkdtempSync(join(tmpdir(), "open-plan-"));
  try {
    const path = join(directory, "plan.json");
    writeFileSync(
      path,
      JSON.stringify(input("0x" + "11".repeat(20), 7, { confirmations: 12 })),
    );
    const result = spawnSync(
      process.execPath,
      [
        new URL("../scripts/deploy.mjs", import.meta.url).pathname,
        "--open-plan",
        path,
      ],
      {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schema, "mycelium.open-registry-deployment-plan/v1");
    assert.equal(plan.broadcast, false);
    assert.equal(plan.nonce, 7);
    assert.equal(plan.confirmations, 12);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("open deployment input fails before provider access", async () => {
  let accesses = 0;
  const provider = new Proxy(
    {},
    {
      get() {
        accesses += 1;
        throw new Error("PROVIDER_ACCESSED");
      },
    },
  );
  await assert.rejects(
    inspectOpenRegistryDeployment({
      provider,
      transactionHash: undefined,
      plan: {
        mode: 0,
        chainId: 31337,
        sender: "bad",
        nonce: 0,
        confirmations: 1,
      },
    }),
    /OPEN_DEPLOYMENT_INVALID/,
  );
  assert.equal(accesses, 0);
  for (const bad of [NaN, Infinity, -1, 1.5]) {
    assert.throws(
      () => planOpenRegistryDeployment(input("0x" + "11".repeat(20), bad)),
      /OPEN_DEPLOYMENT_INVALID/,
    );
  }
});

test("planned RegistryV2 calldata deploys exact immutable runtime and inspection verifies receipt", async (t) => {
  const evm = await localEvm();
  try {
    const nonce = await evm.provider.getTransactionCount(evm.signer.address);
    const plan = planOpenRegistryDeployment(input(evm.signer.address, nonce));
    assert.equal(plan.schema, "mycelium.open-registry-deployment-plan/v1");
    assert.equal(plan.broadcast, false);
    assert.equal(plan.contract, "RegistryV2");
    assert.match(plan.creationData, /^0x[0-9a-f]+$/);
    assert.equal(keccak256(plan.creationData), plan.creationDataHash);
    assert.equal(keccak256(plan.expectedRuntime), plan.expectedRuntimeHash);
    assert.deepEqual(Object.keys(plan.immutableValues).sort(), [
      "DOMAIN_SEPARATOR",
      "deploymentMode",
    ]);
    assert.match(plan.compiler.metadataHash, /^0x[0-9a-f]{64}$/);
    assert.match(plan.sources["RegistryV2.sol"], /^0x[0-9a-f]{64}$/);

    const transaction = await evm.signer.sendTransaction({
      data: plan.creationData,
      nonce,
      value: 0,
    });
    const receipt = await transaction.wait();
    assert.equal(
      receipt.contractAddress.toLowerCase(),
      plan.predictedAddress.toLowerCase(),
    );
    await assert.rejects(
      inspectOpenRegistryDeployment({
        provider: evm.provider,
        transactionHash: transaction.hash,
        plan: input(evm.signer.address, nonce),
      }),
      /OPEN_DEPLOYMENT_PENDING/,
    );
    await evm.provider.send("evm_mine", []);

    const inspection = await inspectOpenRegistryDeployment({
      provider: evm.provider,
      transactionHash: transaction.hash,
      plan: input(evm.signer.address, nonce),
    });
    assert.equal(
      inspection.schema,
      "mycelium.open-registry-deployment-inspection/v1",
    );
    assert.equal(inspection.verified, true);
    assert.equal(inspection.transactionHash, transaction.hash);
    assert.equal(inspection.contractAddress, plan.predictedAddress);
    assert.equal(inspection.runtimeHash, plan.expectedRuntimeHash);
    assert.ok(inspection.confirmations >= 2);

    const deployed = new Contract(
      plan.predictedAddress,
      [
        "function deploymentMode() view returns(uint8)",
        "function DOMAIN_SEPARATOR() view returns(bytes32)",
      ],
      evm.provider,
    );
    assert.equal(await deployed.deploymentMode(), 0n);
    assert.equal(
      await deployed.DOMAIN_SEPARATOR(),
      plan.immutableValues.DOMAIN_SEPARATOR,
    );

    await assert.rejects(
      inspectOpenRegistryDeployment({
        provider: evm.provider,
        transactionHash: evm.openRegistry.deploymentTransaction().hash,
        plan: input(evm.signer.address, nonce),
      }),
      /OPEN_DEPLOYMENT_TRANSACTION_MISMATCH/,
    );

    const originalProvider = {
      getNetwork: (...a) => evm.provider.getNetwork(...a),
      getTransaction: (...a) => evm.provider.getTransaction(...a),
      getTransactionReceipt: (...a) => evm.provider.getTransactionReceipt(...a),
      getBlock: (...a) => evm.provider.getBlock(...a),
      getBlockNumber: (...a) => evm.provider.getBlockNumber(...a),
      getCode: (...a) => evm.provider.getCode(...a),
    };
    const wrongReceipt = {
      ...originalProvider,
      getTransactionReceipt: async (...a) => ({
        ...(await evm.provider.getTransactionReceipt(...a)),
        hash: "0x" + "00".repeat(32),
      }),
    };
    await assert.rejects(
      inspectOpenRegistryDeployment({
        provider: wrongReceipt,
        transactionHash: transaction.hash,
        plan,
      }),
      /OPEN_DEPLOYMENT_RECEIPT_MISMATCH/,
    );
    let blockReads = 0;
    const lateReorg = {
      ...originalProvider,
      getBlock: async (...a) =>
        ++blockReads === 1 ? evm.provider.getBlock(...a) : null,
    };
    await assert.rejects(
      inspectOpenRegistryDeployment({
        provider: lateReorg,
        transactionHash: transaction.hash,
        plan,
      }),
      /OPEN_DEPLOYMENT_REORGED/,
    );

    const wrongCodeProvider = {
      getNetwork: (...args) => evm.provider.getNetwork(...args),
      getTransaction: (...args) => evm.provider.getTransaction(...args),
      getTransactionReceipt: (...args) =>
        evm.provider.getTransactionReceipt(...args),
      getBlock: (...args) => evm.provider.getBlock(...args),
      getBlockNumber: (...args) => evm.provider.getBlockNumber(...args),
      getCode: async () => "0x00",
    };
    await assert.rejects(
      inspectOpenRegistryDeployment({
        provider: wrongCodeProvider,
        transactionHash: transaction.hash,
        plan: input(evm.signer.address, nonce),
      }),
      /OPEN_DEPLOYMENT_RUNTIME_MISMATCH/,
    );

    const snapshot = await evm.provider.send("evm_snapshot", []);
    const secondNonce = await evm.provider.getTransactionCount(
      evm.signer.address,
    );
    const secondPlan = planOpenRegistryDeployment(
      input(evm.signer.address, secondNonce, { confirmations: 1 }),
    );
    const orphan = await evm.signer.sendTransaction({
      data: secondPlan.creationData,
      nonce: secondNonce,
      value: 0,
    });
    await orphan.wait();
    await evm.provider.send("evm_revert", [snapshot]);
    await assert.rejects(
      inspectOpenRegistryDeployment({
        provider: evm.provider,
        transactionHash: orphan.hash,
        plan: input(evm.signer.address, secondNonce, { confirmations: 1 }),
      }),
      /OPEN_DEPLOYMENT_(UNKNOWN|PENDING|REORGED)/,
    );

    t.diagnostic(
      JSON.stringify({
        transactionHash: transaction.hash,
        receiptBlockHash: receipt.blockHash,
        contractAddress: plan.predictedAddress,
        runtimeHash: plan.expectedRuntimeHash,
        creationDataHash: plan.creationDataHash,
      }),
    );
  } finally {
    await evm.close();
  }
});

test("frozen plans reject altered derived bytes and unknown scope before provider access", async () => {
  const spec = input("0x" + "11".repeat(20), 0),
    plan = planOpenRegistryDeployment(spec);
  let accesses = 0;
  const provider = new Proxy(
    {},
    {
      get() {
        accesses++;
        throw Error("UNEXPECTED_PROVIDER");
      },
    },
  );
  await assert.rejects(
    inspectOpenRegistryDeployment({
      provider,
      transactionHash: "0x" + "12".repeat(32),
      plan: { ...plan, creationData: "0x00" },
    }),
    /OPEN_DEPLOYMENT_PLAN_MISMATCH/,
  );
  assert.equal(accesses, 0);
  for (const bad of [
    { ...spec, broadcast: true },
    { ...spec, sender: "0x" + "00".repeat(20) },
    { ...spec, confirmations: 257 },
    { ...spec, mode: 1, chainId: 11155111, confirmations: 1 },
  ])
    assert.throws(
      () => planOpenRegistryDeployment(bad),
      /OPEN_DEPLOYMENT_INVALID/,
    );
});
test("read-only deployment inspection bounds an unavailable RPC without broadcasting", async () => {
  const spec = input("0x" + "11".repeat(20), 0);
  let timer;
  const result = inspectOpenRegistryDeployment({
    provider: { getNetwork: () => new Promise(() => {}) },
    transactionHash: "0x" + "12".repeat(32),
    plan: spec,
    timeoutMs: 5,
  }).then(
    () => "ACCEPTED",
    (e) => e.code,
  );
  const value = await Promise.race([
    result,
    new Promise((r) => {
      timer = setTimeout(() => r("UNBOUNDED"), 100);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(value, "ABORTED");
});

test("open deployment CLI rejects oversized otherwise valid plans before parsing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-plan-bound-"));
  try {
    const path = join(dir, "oversized.json");
    writeFileSync(
      path,
      " ".repeat(65537) + JSON.stringify(input("0x" + "11".repeat(20), 0)),
    );
    const c = spawnSync(
      process.execPath,
      [
        new URL("../scripts/deploy.mjs", import.meta.url).pathname,
        "--open-plan",
        path,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(c.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary indexing runtime import does not load the deployment-only compiler", () => {
  const url = new URL("../src/index.mjs", import.meta.url).href;
  const source = `import {registerHooks} from 'node:module';registerHooks({resolve(spec,ctx,next){if(spec==='solc')throw Error('BUILD_COMPILER_MUST_NOT_LOAD');return next(spec,ctx);}});const m=await import(${JSON.stringify(url)});if(typeof m.createHistory!=='function')throw Error('NO_HISTORY');console.log('RUNTIME_IMPORT_OK');`;
  const c = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /RUNTIME_IMPORT_OK/);
});
