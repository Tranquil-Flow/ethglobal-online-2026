import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SettlementOutbox,
  consumeVerdictJsonl,
  parseVerdictJsonlLine,
  checkMirrorConfirmation,
  createNonceReplayProtector,
  signVerdict,
  verifyVerdictSignature,
  verdictDigest,
  buildHederaSettleConstruct,
  buildHederaSlashConstruct,
  buildSepoliaLedgerRecordConstruct,
  publishHcsDigest,
  runJanitor,
  EVENT_TYPES,
  ethers,
} from "../src/index.mjs";

const ESCROW = "0x0000000000000000000000000000000000000e5c";
const LEDGER = "0x0000000000000000000000000000000000001ed9";
const PROVIDER = "0x000000000000000000000000000000000000beef";
const OPERATOR = "0x000000000000000000000000000000000000cafe";

function b32(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function json(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function verdict(overrides = {}) {
  return {
    verdictId: "verdict-" + (overrides.nonce ?? 1n).toString(),
    action: "settle",
    hederaRef: "0.0.123@1700000000.000000001",
    subjectId: b32("payment-" + (overrides.nonce ?? 1n).toString()),
    providerKey: PROVIDER,
    profile: b32("qwen-0.5b-int8"),
    epoch: 7,
    outcome: 0,
    evidenceDigest: b32("evidence"),
    policyVersion: b32("policy-v1"),
    nonce: overrides.nonce ?? 1n,
    expiry: overrides.expiry ?? 4_102_444_800n,
    ...overrides,
  };
}

function auditPayload(overrides = {}) {
  return {
    auditId: b32("audit"),
    providerKey: PROVIDER,
    profile: b32("qwen-0.5b-int8"),
    epoch: 7,
    reason: 2,
    outcome: 0,
    evidenceDigest: b32("evidence"),
    hederaRef: b32("hedera"),
    ...overrides,
  };
}

async function tempOutbox(clock = () => 1_700_000_000_000) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "w6-relayer-test-"));
  return {
    dir,
    dbPath: path.join(dir, "nested", "outbox.sqlite"),
    outbox: new SettlementOutbox({
      dbPath: path.join(dir, "nested", "outbox.sqlite"),
      now: clock,
    }),
  };
}

test("testOutboxInsertAndFindPending", async () => {
  const { outbox, dbPath } = await tempOutbox();
  const inserted = outbox.append("settle", { verdictId: "v1", subjectId: b32("payment") });
  assert.equal(inserted.status, "pending");
  assert.equal(inserted.type, "settle");
  assert.equal(outbox.findPending().length, 1);
  assert.equal(outbox.findPending()[0].payload.verdictId, "v1");
  assert.equal(outbox.journalMode().toLowerCase(), "wal");
  assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
  outbox.close();
});

test("testOutboxIdempotencySameId", async () => {
  const { outbox } = await tempOutbox();
  const first = outbox.append("settle", { verdictId: "same", value: 1 });
  const second = outbox.append("settle", { verdictId: "same", value: 2 });
  assert.equal(first.id, second.id);
  assert.equal(second.payload.value, 1);
  assert.equal(outbox.countRows(), 1);
  outbox.close();
});

test("testOutboxRetryAfterFailure", async () => {
  const { outbox } = await tempOutbox();
  const row = outbox.append("ledgerEvent", { idempotencyKey: "e1" });
  const inFlight = outbox.markInFlight(row.id);
  assert.equal(inFlight.attempts, 1);
  const failed = outbox.markFailure(row.id, new Error("temporary RPC failure"), { maxAttempts: 3 });
  assert.equal(failed.status, "pending");
  assert.match(failed.error, /temporary RPC failure/);
  const pending = outbox.findPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  outbox.close();
});

test("testOutboxMaxRetries", async () => {
  const { outbox } = await tempOutbox();
  const row = outbox.append("settle", { verdictId: "retry-limit" });
  for (let i = 0; i < 3; i += 1) {
    outbox.markInFlight(row.id);
    outbox.markFailure(row.id, "still failing", { maxAttempts: 3 });
  }
  assert.equal(outbox.get(row.id).status, "failed");
  assert.equal(outbox.findPending({ maxAttempts: 3 }).length, 0);
  outbox.close();
});

test("testVerdictConsumerDedupeByVerdictId", async () => {
  const { outbox, dir } = await tempOutbox();
  const jsonl = path.join(dir, "verdicts.jsonl");
  const v = verdict({ verdictId: "dedupe", nonce: 10n });
  await writeFile(jsonl, `${json({ type: "Verdict", ...v })}\n${json({ type: "Verdict", ...v })}\n`);
  const result = await consumeVerdictJsonl({ logPath: jsonl, outbox });
  assert.equal(result.parsed, 2);
  assert.equal(result.enqueued, 1);
  assert.equal(outbox.countRows({ type: "settle" }), 1);
  assert.equal(outbox.countRows({ type: "ledgerEvent" }), 1);
  outbox.close();
});

test("testVerdictConsumerParseValidShape", () => {
  const parsed = parseVerdictJsonlLine(json({ type: "Verdict", ...verdict({ verdictId: "shape", nonce: 12n }) }));
  assert.equal(parsed.verdictId, "shape");
  assert.equal(parsed.hederaRef, "0.0.123@1700000000.000000001");
  assert.equal(parsed.providerKey, ethers.getAddress(PROVIDER));
  assert.equal(parsed.nonce, "12");
  assert.equal(parsed.action, "settle");
});

test("testMirrorNodeConfirmation", async () => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ transactions: [{ result: "SUCCESS", confirmations: url.includes("low") ? 11 : 12 }] }),
    };
  };
  const low = await checkMirrorConfirmation({ txId: "low", fetch });
  const high = await checkMirrorConfirmation({ txId: "high", fetch });
  assert.equal(low.confirmed, false);
  assert.equal(high.confirmed, true);
  assert.equal(high.confirmations, 12);
  assert.ok(seen.every((url) => url.startsWith("https://testnet.mirrornode.hedera.com/api/v1/transactions/")));
});

test("testEIP712VerifyValid", async () => {
  const wallet = ethers.Wallet.createRandom();
  const v = verdict({ nonce: 77n });
  const signature = await signVerdict({ verdict: v, signer: wallet, verifyingContract: ESCROW, chainId: 296 });
  const consumed = createNonceReplayProtector();
  const result = verifyVerdictSignature({
    verdict: v,
    signature,
    expectedSigner: wallet.address,
    verifyingContract: ESCROW,
    chainId: 296,
    consumed,
  });
  assert.equal(result.signer, wallet.address);
  assert.equal(result.digest, verdictDigest({ verdict: v, verifyingContract: ESCROW, chainId: 296 }));
  assert.equal(consumed.has(v.nonce), true);
});

test("testEIP712VerifyReplay", async () => {
  const wallet = ethers.Wallet.createRandom();
  const v = verdict({ nonce: 88n });
  const signature = await signVerdict({ verdict: v, signer: wallet, verifyingContract: ESCROW, chainId: 296 });
  const consumed = createNonceReplayProtector();
  verifyVerdictSignature({ verdict: v, signature, expectedSigner: wallet.address, verifyingContract: ESCROW, chainId: 296, consumed });
  assert.throws(
    () => verifyVerdictSignature({ verdict: v, signature, expectedSigner: wallet.address, verifyingContract: ESCROW, chainId: 296, consumed }),
    /NONCE_REPLAY/,
  );
});

test("testHederaSettleConstruct", async () => {
  const verifierSigner = ethers.Wallet.createRandom();
  const built = await buildHederaSettleConstruct({
    escrowAddress: ESCROW,
    verdicts: [verdict({ nonce: 91n })],
    verifierSigner,
    operatorPayer: { accountId: "0.0.10419268", address: OPERATOR },
    chainId: 296,
  });
  assert.equal(built.method, "settle");
  assert.equal(built.broadcast, false);
  assert.equal(built.operatorPayer.accountId, "0.0.10419268");
  assert.equal(built.verifierSigner, verifierSigner.address);
  assert.equal(built.calldata.slice(0, 10), built.interface.getFunction("settle").selector);
  assert.equal(built.signatures.length, 1);
});

test("testHederaSlashConstruct", async () => {
  const slashId = b32("slash-id");
  const built = await buildHederaSlashConstruct({
    escrowAddress: ESCROW,
    slashId,
    now: 2_000,
    challengeWindowEndsAt: 1_999,
    guardianClient: { checkSlash: async (id) => ({ slashId: id, vetoed: false, challengeWindowEnded: true }) },
  });
  assert.equal(built.method, "executeSlash");
  assert.equal(built.guardianCheck.vetoed, false);
  assert.equal(built.guardianCheck.checked, true);
  assert.equal(built.calldata.slice(0, 10), built.interface.getFunction("executeSlash").selector);
});

test("testSepoliaLedgerRecordConstruct", async () => {
  const signer = ethers.Wallet.createRandom();
  const built = await buildSepoliaLedgerRecordConstruct({
    ledgerAddress: LEDGER,
    eventType: "AuditRecorded",
    payload: auditPayload(),
    signer,
    chainId: 11155111,
  });
  const decoded = built.interface.decodeFunctionData("record", built.calldata);
  assert.equal(decoded[0], EVENT_TYPES.AuditRecorded);
  assert.equal(decoded[0].slice(0, 4), EVENT_TYPES.AuditRecorded.slice(0, 4));
  assert.equal(built.eventType, EVENT_TYPES.AuditRecorded);
  assert.equal(built.author, signer.address);
  assert.equal(built.broadcast, false);
});

test("testHcsPublishStub", async () => {
  const result = await publishHcsDigest({ digest: b32("digest") });
  assert.deepEqual(result, { skipped: true, reason: "HCS_TOPIC_NOT_CONFIGURED" });
});

test("testJanitorSkipsInFlight", async () => {
  let clock = 10_000_000;
  const { outbox } = await tempOutbox(() => clock);
  const confirmed = outbox.append("ledgerEvent", { idempotencyKey: "old-confirmed" });
  outbox.markConfirmed(confirmed.id, "0xabc", { at: 1_000 });
  const active = outbox.append("settle", { verdictId: "inflight-kept" });
  outbox.markInFlight(active.id, { at: 1_000 });
  const cleanup = runJanitor({ outbox, now: () => clock, confirmedTtlMs: 3_600_000 });
  assert.equal(cleanup.deletedConfirmed, 1);
  assert.equal(outbox.get(confirmed.id), null);
  assert.equal(outbox.get(active.id).status, "in_flight");
  outbox.close();
});

test("testRestartSafety", async () => {
  const { dbPath, outbox } = await tempOutbox();
  const row = outbox.append("settle", { verdictId: "restart-safe" });
  outbox.close();
  const reopened = new SettlementOutbox({ dbPath, now: () => 1_700_000_001_000 });
  const pending = reopened.findPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, row.id);
  assert.equal(pending[0].payload.verdictId, "restart-safe");
  reopened.close();
});
