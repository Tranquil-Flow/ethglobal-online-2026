import { test } from "node:test";
import assert from "node:assert/strict";
import { ContractFactory, keccak256 } from "ethers";
import { localEvm } from "./local-evm.mjs";
import { providerId, receipt, assessment } from "./fixtures.mjs";
import {
  createOpenAssessmentStatement,
  openRegistryV2Abi,
} from "../src/index.mjs";
import { compileAll } from "../scripts/compile.mjs";

async function openFixture() {
  const c = compileAll().RegistryV2;
  assert.ok(
    c.abi.some(
      (entry) =>
        entry.type === "event" && entry.name === "OpenAssessmentPublished",
    ),
  );
  assert.ok(
    openRegistryV2Abi.some((fragment) => fragment.includes("publishStatement")),
  );
  const e = await localEvm();
  try {
    const registry = await new ContractFactory(
      c.abi,
      c.evm.bytecode.object,
      e.signer,
    ).deploy(0);
    await registry.waitForDeployment();
    return { ...e, registryV2: registry };
  } catch (error) {
    await e.close();
    throw error;
  }
}

test("open v2 registry accepts checker-signed statements from any relayer without prior receipt", async () => {
  const e = await openFixture();
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const statement = await createOpenAssessmentStatement({
      registryAddress: await e.registryV2.getAddress(),
      chainId: 31337,
      checker: e.stranger,
      providerId,
      receiptDigest: receipt.receiptDigest,
      assessment: { ...assessment, outcome: "mismatch" },
      mode: "development",
      expiresAt,
      nonce: "0x" + "11".repeat(32),
    });
    assert.equal(
      statement.author.toLowerCase(),
      e.stranger.address.toLowerCase(),
    );
    assert.equal(statement.linkage, "unresolved");
    assert.match(statement.payload.statementDigest, /^0x[0-9a-f]{64}$/);
    assert.equal(statement.safeProjection.includes("synthetic-receipt"), false);

    const receiptTx = await (
      await e.registryV2
        .connect(e.signer)
        .publishStatement(statement.payload, statement.signature)
    ).wait();
    assert.equal(receiptTx.logs.length, 1);
    const parsed = e.registryV2.interface.parseLog(receiptTx.logs[0]);
    assert.equal(parsed.name, "OpenAssessmentPublished");
    assert.equal(
      parsed.args.author.toLowerCase(),
      e.stranger.address.toLowerCase(),
    );
    assert.equal(
      parsed.args.relayer.toLowerCase(),
      e.signer.address.toLowerCase(),
    );
    assert.equal(parsed.args.linked, false);

    const replay = await (
      await e.registryV2
        .connect(e.stranger)
        .publishStatement(statement.payload, statement.signature)
    ).wait();
    assert.equal(replay.logs.length, 0, "exact duplicate replay is idempotent");

    const conflict = await createOpenAssessmentStatement({
      registryAddress: await e.registryV2.getAddress(),
      chainId: 31337,
      checker: e.stranger,
      providerId,
      receiptDigest: receipt.receiptDigest,
      assessment: { ...assessment, outcome: "passed" },
      mode: "development",
      expiresAt,
      nonce: statement.payload.nonce,
    });
    await assert.rejects(
      e.registryV2.publishStatement(conflict.payload, conflict.signature),
      /CONFLICTING_NONCE/,
    );

    const wrongDomain = await createOpenAssessmentStatement({
      registryAddress: e.signer.address,
      chainId: 31337,
      checker: e.stranger,
      providerId,
      receiptDigest: receipt.receiptDigest,
      assessment: { ...assessment, outcome: "inconclusive" },
      mode: "development",
      expiresAt,
      nonce: "0x" + "22".repeat(32),
    });
    await assert.rejects(
      e.registryV2.publishStatement(wrongDomain.payload, wrongDomain.signature),
      /INVALID_SIGNATURE|STATEMENT_DIGEST/,
    );

    const expired = await createOpenAssessmentStatement({
      registryAddress: await e.registryV2.getAddress(),
      chainId: 31337,
      checker: e.stranger,
      providerId,
      receiptDigest: receipt.receiptDigest,
      assessment: { ...assessment, outcome: "unavailable" },
      mode: "development",
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      nonce: "0x" + "33".repeat(32),
    });
    await assert.rejects(
      e.registryV2.publishStatement(expired.payload, expired.signature),
      /EXPIRED/,
    );
  } finally {
    await e.close();
  }
});

test("open statement helper rejects private projections and inconsistent bindings", async () => {
  const e = await openFixture();
  try {
    const common = {
      registryAddress: await e.registryV2.getAddress(),
      chainId: 31337,
      checker: e.stranger,
      providerId,
      receiptDigest: receipt.receiptDigest,
      mode: "development",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      nonce: "0x" + "44".repeat(32),
    };
    await assert.rejects(
      createOpenAssessmentStatement({
        ...common,
        assessment: { ...assessment, prompt: "private-canary" },
      }),
      /INVALID_OPEN_ASSESSMENT/,
    );
    await assert.rejects(
      createOpenAssessmentStatement({
        ...common,
        assessment: {
          ...assessment,
          receiptDigest: "sha256:" + "9".repeat(64),
        },
      }),
      /INVALID_OPEN_ASSESSMENT/,
    );
  } finally {
    await e.close();
  }
});
