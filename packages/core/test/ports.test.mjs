import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf } from "../../contracts/index.mjs";
import {
  createApp,
  createStore,
  createSigner,
  developmentProfile,
  createDevelopmentExecutor,
  createDevelopmentPayments,
} from "../src/index.mjs";
import {
  encodePaymentRequiredHeader,
  decodePaymentRequiredHeader,
} from "@x402/core/http";
import { parsePaymentRequired } from "@x402/core/schemas";

async function setup(t, makePorts = () => ({}), config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "core-ports-")),
    path = join(dir, "db.sqlite");
  const store = createStore({ path }),
    payments = createDevelopmentPayments({ store });
  const signer = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "test-key",
  });
  const request = {
    version: "1",
    nonce: "9".repeat(64),
    providerId: "development.invalid",
    profileId: digestOf(developmentProfile),
    prompt: "SYNTHETIC",
    maxOutputTokens: 32,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const ports = makePorts({ payments, request, store });
  const app = createApp({
    config: {
      mode: "development",
      profiles: [developmentProfile],
      providerIds: [request.providerId],
      maintenanceMs: 20,
      ...config,
    },
    store,
    signer,
    payments,
    executor: createDevelopmentExecutor(),
    ...ports,
  });
  const { url } = await app.listen({ port: 0 });
  const call = async (
    path,
    { method = "GET", body, cap, key, headers = {} } = {},
  ) => {
    const r = await fetch(url + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cap ? { authorization: ["Bearer", cap].join(" ") } : {}),
        ...(key ? { "idempotency-key": key } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return {
      status: r.status,
      body: text ? JSON.parse(text) : undefined,
      headers: r.headers,
    };
  };
  const session = async () =>
    (await call("/v1/sessions", { method: "POST", body: {} })).body.capability;
  const quote = async (cap) =>
    (await call("/v1/quotes", { method: "POST", body: { request }, cap })).body;
  const job = async (cap, q, key = "job") =>
    call("/v1/jobs", {
      method: "POST",
      body: { request, quoteId: q.quoteId },
      cap,
      key,
    });
  const done = async (cap, id) => {
    for (let i = 0; i < 100; i++) {
      const r = await call("/v1/jobs/" + id, { cap });
      if (
        ["succeeded", "failed", "cancelled"].includes(r.body?.executionStatus)
      )
        return r.body;
      await delay(10);
    }
    throw Error("timeout");
  };
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, store, path, request, call, session, quote, job, done, signer };
}

test("actual x402 SDK header encoding survives raw HTTP challenge relay byte-for-byte, with no execution", async (t) => {
  // Synthetic SDK-shaped transport fixture only. No facilitator/wallet verification claim.
  const required = {
    x402Version: 2,
    resource: {
      url: "https://development.invalid/v1/jobs",
      description: "Synthetic transport test",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x0000000000000000000000000000000000000001",
        amount: "1",
        payTo: "0x0000000000000000000000000000000000000002",
        maxTimeoutSeconds: 60,
        extra: { name: "Synthetic", version: "1" },
      },
    ],
  };
  assert.equal(parsePaymentRequired(required).success, true);
  const encoded = encodePaymentRequiredHeader(required);
  let called = 0;
  const h = await setup(
    t,
    ({ payments }) => ({
      payments: {
        ...payments,
        headerPolicy: {
          request: ["payment-signature"],
          response: ["payment-required", "payment-response"],
        },
        async authorize() {
          called++;
          return {
            kind: "required",
            status: 402,
            headers: { "PAYMENT-REQUIRED": encoded },
            body: {},
          };
        },
      },
    }),
    {},
  );
  const cap = await h.session(),
    q = await h.quote(cap);
  const r = await h.job(cap, q);
  assert.equal(r.status, 402);
  assert.deepEqual(r.body, {});
  assert.equal(r.headers.get("payment-required"), encoded);
  assert.deepEqual(
    decodePaymentRequiredHeader(r.headers.get("payment-required")),
    required,
  );
  assert.equal(h.store.list("jobs").length, 0);
  assert.equal((await h.job(cap, q)).status, 402);
  assert.equal(called, 2);
});

test("unallowlisted payment headers and unsettled payment status fail closed", async (t) => {
  for (const kind of ["header", "pending", "mode", "binding"]) {
    const h = await setup(t, ({ payments }) => ({
      payments: {
        ...payments,
        async authorize(args) {
          const a = await payments.authorize(args);
          if (kind === "header")
            a.responseHeaders = { "set-cookie": "not-allowed" };
          if (kind === "pending") a.payment.status = "pending";
          if (kind === "mode") a.payment.mode = "live";
          if (kind === "binding") a.payment.requestHash = digestOf("different");
          return a;
        },
      },
    }));
    const cap = await h.session(),
      q = await h.quote(cap);
    assert.equal((await h.job(cap, q)).status, 503, kind);
    assert.equal(h.store.list("jobs").length, 0);
  }
});

test("one quote cannot be consumed under another idempotency key or principal", async (t) => {
  const h = await setup(t);
  const cap = await h.session(),
    other = await h.session(),
    q = await h.quote(cap);
  const r = await h.job(cap, q);
  assert.equal(r.status, 202);
  assert.equal((await h.job(cap, q, "another-key")).status, 409);
  assert.equal((await h.job(other, q)).status, 400);
  assert.equal(h.store.list("jobs").length, 1);
});

test("selection re-resolves providers and server-retained quotes; history is separately shaped", async (t) => {
  let provider,
    selected = 0;
  const h = await setup(t, ({ request }) => {
    provider = {
      version: "1",
      providerId: request.providerId,
      name: "development.invalid",
      endpoint: "https://development.invalid",
      profileIds: [request.profileId],
      paymentNetwork: "development-local",
      paymentAsset: "development-none",
      paymentReceiver: "development.invalid",
      mode: "development",
      source: {
        chainId: "development-local",
        blockNumber: 1,
        blockHash: "development-block",
        resolvedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    };
    return {
      discovery: {
        async list() {
          return { providers: [provider], errors: [] };
        },
        async select() {
          selected++;
          return {
            selected: provider,
            reasons: [
              { providerId: provider.providerId, eligible: true, codes: [] },
            ],
          };
        },
      },
      history: {
        async getHistory({ providerId }) {
          return {
            version: "1",
            providerId,
            observations: [],
            freshness: "unavailable",
            chainId: "development-local",
            observedAt: new Date().toISOString(),
            mode: "development",
          };
        },
      },
    };
  });
  const cap = await h.session(),
    q = await h.quote(cap);
  const b = {
    providers: [provider],
    quotes: [q],
    profileId: h.request.profileId,
    maxAmountBaseUnits: "0",
    network: q.network,
    asset: q.asset,
  };
  assert.equal(
    (await h.call("/v1/providers?name=development.invalid")).status,
    200,
  );
  assert.equal(
    (await h.call("/v1/providers/select", { method: "POST", body: b, cap }))
      .status,
    200,
  );
  assert.equal(selected, 1);
  assert.equal(
    (
      await h.call("/v1/providers/select", {
        method: "POST",
        body: { ...b, quotes: [{ ...q, amountBaseUnits: "99" }] },
        cap,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.call("/v1/providers/select", {
        method: "POST",
        body: {
          ...b,
          providers: [{ ...provider, endpoint: "http://127.0.0.1:1/private" }],
        },
        cap,
      })
    ).status,
    409,
  );
  assert.equal(selected, 1);
  const snapshot = structuredClone(provider);
  provider = {
    ...provider,
    source: {
      ...provider.source,
      resolvedAt: new Date(Date.now() + 1).toISOString(),
    },
  };
  assert.equal(
    (
      await h.call("/v1/providers/select", {
        method: "POST",
        body: { ...b, providers: [snapshot] },
        cap,
      })
    ).status,
    200,
    "same record set re-observed at a new time remains compatible",
  );
  assert.equal(
    (await h.call("/v1/providers/development.invalid/history")).body.freshness,
    "unavailable",
  );
});

test("assessment injection must bind trusted identity/evidence and deletion during assessment remains unavailable", async (t) => {
  let release, entered;
  const gate = new Promise((r) => (release = r)),
    started = new Promise((r) => (entered = r));
  const h = await setup(
    t,
    () => ({
      assessor: {
        async assess({ receipt, profile, evidenceRef }) {
          assert.ok(evidenceRef.startsWith("core-local:"));
          entered();
          await gate;
          return {
            version: "1",
            assessmentId: "test-assessment",
            receiptDigest: digestOf(receipt),
            method: "test-relation",
            profileId: digestOf(profile),
            verifierId: "configured-test-verifier",
            outcome: "passed",
            mode: "development",
            createdAt: new Date().toISOString(),
            evidenceDigest: digestOf("synthetic-assessment"),
          };
        },
      },
    }),
    {
      assessor: {
        method: "test-relation",
        verifierId: "configured-test-verifier",
      },
    },
  );
  const cap = await h.session(),
    q = await h.quote(cap),
    r = await h.job(cap, q);
  const id = r.body.job.jobId;
  await h.done(cap, id);
  const a = h.call("/v1/jobs/" + id + "/assessments", {
    method: "POST",
    body: { method: "test-relation" },
    cap,
    key: "a",
  });
  await started;
  await h.call("/v1/jobs/" + id + "/evidence", { method: "DELETE", cap });
  release();
  const result = await a;
  assert.equal(result.status, 202);
  assert.equal(result.body.outcome, "unavailable");
  assert.equal(result.body.reasonCode, "EVIDENCE_UNAVAILABLE");
});

test("pending publication survives app restart and preserves immutable receipt", async (t) => {
  const h = await setup(t, () => ({
    eventSink: {
      async publish() {
        throw Error("synthetic sink unavailable");
      },
    },
  }));
  h.request.publishConsent = true;
  const cap = await h.session(),
    q = await h.quote(cap),
    r = await h.job(cap, q);
  const id = r.body.job.jobId;
  await h.done(cap, id);
  const before = h.store.get("receipts", id);
  await h.app.close();
  assert.equal(h.store.list("outbox").length, 1);
  let event;
  const restarted = createApp({
    config: { mode: "development", maintenanceMs: 10 },
    store: h.store,
    signer: h.signer,
    eventSink: {
      async publish(args) {
        event = args.event;
        return { status: "confirmed" };
      },
    },
  });
  await restarted.listen({ port: 0 });
  try {
    for (
      let i = 0;
      i < 100 && h.store.list("outbox")[0].status !== "confirmed";
      i++
    )
      await delay(10);
    assert.equal(h.store.list("outbox")[0].status, "confirmed");
    assert.equal(event.receiptDigest, digestOf(before.receipt));
    assert.deepEqual(h.store.get("receipts", id), before);
  } finally {
    await restarted.close();
  }
});

test("all private mutations deny another principal and reject caller-chosen principals", async (t) => {
  const h = await setup(t),
    cap = await h.session(),
    other = await h.session(),
    q = await h.quote(cap),
    r = await h.job(cap, q);
  const id = r.body.job.jobId;
  for (const [action, method, body] of [
    ["cancel", "POST", {}],
    ["evidence", "DELETE", undefined],
    ["assessments", "POST", { method: "test" }],
  ])
    assert.equal(
      (
        await h.call("/v1/jobs/" + id + "/" + action, {
          method,
          body,
          cap: other,
          key: "not-owner",
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await h.call("/v1/sessions", {
        method: "POST",
        body: { principalId: "victim" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await h.call("/v1/quotes", {
        method: "POST",
        body: { request: h.request, principalId: "victim" },
        cap,
      })
    ).status,
    400,
  );
});

test("review regressions: false signer, extra discovery payload, and unbounded configuration fail closed", async (t) => {
  const pair = generateKeyPairSync("ed25519");
  const actual = createSigner({ privateKey: pair.privateKey, keyId: "test" });
  const h = await setup(t, () => ({
    signer: { ...actual, verify: () => false },
  }));
  const cap = await h.session(),
    q = await h.quote(cap),
    r = await h.job(cap, q);
  assert.equal((await h.done(cap, r.body.job.jobId)).executionStatus, "failed");
  const d = await setup(t, () => ({
    discovery: {
      async list() {
        return {
          providers: [],
          errors: [],
          privateSdkPayload: "SYNTHETIC-LEAK",
        };
      },
    },
  }));
  const reply = await d.call("/v1/providers?name=development.invalid");
  assert.equal(reply.status, 503);
  assert.ok(!JSON.stringify(reply.body).includes("SYNTHETIC-LEAK"));
  for (const key of [
    "maxQueue",
    "concurrency",
    "retentionMs",
    "evidenceRetentionMs",
    "sessionRate",
    "requestRate",
    "maintenanceMs",
  ])
    assert.throws(
      () =>
        createApp({
          store: {},
          config: { mode: "development", [key]: Number.MAX_SAFE_INTEGER },
        }),
      /ceiling/,
    );
});

test("database service owner excludes a second listener and mode cannot be relabelled", async (t) => {
  const h = await setup(t);
  const second = createStore({ path: h.path });
  t.after(() => second.close());
  const app = createApp({ config: { mode: "development" }, store: second });
  await assert.rejects(app.listen({ port: 0 }), /active service owner/);
  await h.app.close();
  const live = createApp({ config: { mode: "live" }, store: second });
  await assert.rejects(live.listen({ port: 0 }), /mode cannot be relabelled/);
});
