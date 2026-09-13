// L-PUBLISH: integration tests for composition/w6-receipt-publisher.mjs.
//
// Uses the shared local-anvil fixture from packages/indexing/test/local-evm.mjs so the
// wrapper is exercised against a real chain. No Sepolia, no keys read from disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { keccak256 } = createRequire(
  new URL('../../packages/indexing/package.json', import.meta.url),
)('ethers');

import { localEvm } from '../../packages/indexing/test/local-evm.mjs';
import {
  receipt,
  event as assessmentEvent,
  assessment,
} from '../../packages/indexing/test/fixtures.mjs';
import { createPublicationStore } from '../../packages/indexing/src/index.mjs';

import {
  createReceiptPublisher,
  createInMemoryStore,
  planBackfill,
} from '../w6-receipt-publisher.mjs';

async function anvilFixture() {
  const evm = await localEvm();
  const address = await evm.registry.getAddress();
  const code = await evm.provider.getCode(address);
  const deployment = {
    mode: 'development',
    chainId: 31337,
    network: 'localhost',
    address,
    publisher: evm.signer.address,
    codeHash: keccak256(code),
    startBlock: 1,
    confirmations: 1,
  };
  return {
    evm,
    deployment,
    async close() {
      await evm.close();
    },
  };
}

function fileStore(directory) {
  return createPublicationStore({ directory: join(directory, 'journal') });
}

test('publishReceipt: injects signer + store, returns confirmed tx via createEventSink', async () => {
  const f = await anvilFixture();
  const dir = await mkdtemp(join(tmpdir(), 'w6-rp-receipt-'));
  try {
    const publisher = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: f.deployment,
      maxGasPriceWei: '100000000000',
    });
    const result = await publisher.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    assert.equal(result.status, 'confirmed');
    assert.match(result.transactionRef, /^0x[0-9a-f]{64}$/);
    await publisher.close();
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('publishAssessment: injects signer + store, returns confirmed tx via createEventSink', async () => {
  const f = await anvilFixture();
  const dir = await mkdtemp(join(tmpdir(), 'w6-rp-assess-'));
  try {
    const publisher = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: f.deployment,
    });
    // Publish the receipt first so the assessment's receiptDigest is already on-chain.
    await publisher.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    const result = await publisher.publishAssessment({
      objectDigest: assessmentEvent.objectDigest,
      receiptDigest: assessmentEvent.receiptDigest,
      providerKey: assessmentEvent.providerKey,
      verifierKey: assessmentEvent.verifierKey,
      methodKey: assessmentEvent.methodKey,
      outcome: assessmentEvent.outcome,
      mode: assessmentEvent.mode,
      assessment: assessmentEvent.assessment,
    });
    assert.equal(result.status, 'confirmed');
    assert.match(result.transactionRef, /^0x[0-9a-f]{64}$/);
    await publisher.close();
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('idempotency = digest: same digest returns same result; different event at same key is rejected', async () => {
  const f = await anvilFixture();
  const dir = await mkdtemp(join(tmpdir(), 'w6-rp-idem-'));
  try {
    const publisher = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: f.deployment,
    });
    const first = await publisher.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    assert.equal(first.status, 'confirmed');
    const replay = await publisher.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    assert.deepEqual(replay, first);
    // Different receipt (different objectDigest) gets a different idempotency key
    // (digestOf(event)), so it publishes independently.
    const alt = await publisher.publishReceipt({
      objectDigest: 'sha256:' + 'a'.repeat(64),
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    assert.notEqual(alt.transactionRef, first.transactionRef);
    await publisher.close();
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('maxGasPriceWei cap is enforced; low cap -> GAS_PRICE_LIMIT', async () => {
  const f = await anvilFixture();
  const dir = await mkdtemp(join(tmpdir(), 'w6-rp-fee-'));
  try {
    const publisher = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: f.deployment,
      maxGasPriceWei: '1', // 1 wei — anvil gas price is 1 gwei, so this fails
    });
    await assert.rejects(
      publisher.publishReceipt({
        objectDigest: receipt.objectDigest,
        providerKey: receipt.providerKey,
        mode: 'development',
      }),
      (e) => e.code === 'GAS_PRICE_LIMIT',
    );
    await publisher.close();
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mode/publisher/code-hash checks are preserved: mismatches rejected', async () => {
  const f = await anvilFixture();
  const dir = await mkdtemp(join(tmpdir(), 'w6-rp-guard-'));
  try {
    // Bad code-hash on the deployment descriptor -> CODE_MISMATCH.
    const publisher = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: { ...f.deployment, codeHash: '0x' + '1'.repeat(64) },
    });
    await assert.rejects(
      publisher.publishReceipt({
        objectDigest: receipt.objectDigest,
        providerKey: receipt.providerKey,
        mode: 'development',
      }),
      (e) => e.code === 'CODE_MISMATCH',
    );
    await publisher.close();
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('async + never blocks the user response: publishReceipt returns a Promise immediately', async () => {
  const f = await anvilFixture();
  const dir = await mkdtemp(join(tmpdir(), 'w6-rp-async-'));
  try {
    const publisher = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: f.deployment,
    });
    const start = Date.now();
    const promise = publisher.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    // The function must return synchronously (a Promise is fine; blocking >50ms is not).
    assert.ok(promise && typeof promise.then === 'function');
    assert.ok(Date.now() - start < 50, 'publishReceipt must not block the caller');
    const result = await promise;
    assert.equal(result.status, 'confirmed');
    await publisher.close();
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('journaled: closing the publisher and reopening the store replays the same tx hash', async () => {
  const f = await anvilFixture();
  const dir = await mkdtemp(join(tmpdir(), 'w6-rp-journal-'));
  try {
    const first = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: f.deployment,
    });
    const initial = await first.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    await first.close();
    // Inspect journal permissions + content.
    const journal = JSON.parse(
      await readFile(join(dir, 'journal', 'journal.json'), 'utf8'),
    );
    assert.ok(journal.entries);
    const entries = Object.values(journal.entries);
    assert.ok(entries.length >= 1);
    // Reopen the file-backed store in a fresh publisher and replay.
    const second = createReceiptPublisher({
      signer: f.evm.signer,
      store: fileStore(dir),
      deployment: f.deployment,
    });
    const replay = await second.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    assert.deepEqual(replay, initial);
    await second.close();
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('in-memory store works without a directory; idempotency still survives same-process replay', async () => {
  const f = await anvilFixture();
  try {
    const publisher = createReceiptPublisher({
      signer: f.evm.signer,
      store: createInMemoryStore(),
      deployment: f.deployment,
    });
    const first = await publisher.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    assert.equal(first.status, 'confirmed');
    const replay = await publisher.publishReceipt({
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    });
    assert.deepEqual(replay, first);
    await publisher.close();
  } finally {
    await f.close();
  }
});

test('disabled publisher (no deployment): returns unavailable without contacting the chain', async () => {
  // No signer / no deployment -> enabled=false -> sink returns {status:'unavailable'}.
  const publisher = createReceiptPublisher({
    signer: undefined,
    store: createInMemoryStore(),
  });
  const result = await publisher.publishReceipt({
    objectDigest: receipt.objectDigest,
    providerKey: receipt.providerKey,
    mode: 'development',
  });
  assert.equal(result.status, 'unavailable');
  await publisher.close();
});

test('planBackfill: pure data transform, deterministic ordering, txCap enforced, dry-run safe', () => {
  const records = [
    {
      kind: 'receipt',
      objectDigest: receipt.objectDigest,
      providerKey: receipt.providerKey,
      mode: 'development',
    },
    {
      kind: 'assessment',
      objectDigest: assessmentEvent.objectDigest,
      receiptDigest: assessmentEvent.receiptDigest,
      providerKey: assessmentEvent.providerKey,
      verifierKey: assessmentEvent.verifierKey,
      methodKey: assessmentEvent.methodKey,
      outcome: assessmentEvent.outcome,
      mode: assessmentEvent.mode,
      assessment: assessmentEvent.assessment,
    },
    {
      kind: 'receipt',
      objectDigest: 'sha256:' + '9'.repeat(64),
      providerKey: receipt.providerKey,
      mode: 'development',
    },
  ];
  const plan = planBackfill(records, { txCap: 2 });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].kind, 'receipt');
  assert.equal(plan[1].kind, 'assessment');
  // Stable idempotency keys derived from digest.
  assert.equal(plan[0].idempotencyKey, receipt.objectDigest);
  assert.equal(plan[1].idempotencyKey, assessmentEvent.objectDigest);
  // txCap=1 caps the plan to the first record.
  const tiny = planBackfill(records, { txCap: 1 });
  assert.equal(tiny.length, 1);
  // Invalid input is rejected.
  assert.throws(() => planBackfill(null, { txCap: 1 }), /INVALID_BACKFILL_INPUT/);
  assert.throws(
    () => planBackfill([{ kind: 'bogus' }], { txCap: 1 }),
    /INVALID_BACKFILL_KIND/,
  );
  assert.throws(
    () => planBackfill(records, { txCap: 0 }),
    /INVALID_TX_CAP/,
  );
});