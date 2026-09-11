import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { inspectManagedPayments } from "../application-payments.mjs";
import {
  createSqliteStore,
  PROTOCOL,
} from "../../packages/payments/src/index.mjs";
import {
  facilitatorFixture,
  proof,
  request as fixtureRequest,
} from "../../packages/payments/test/fixture.mjs";

const require = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
);
const { decodePaymentRequiredHeader } = require("@x402/core/http");

const providerId = "alpha.local";
const profileId = "sha256:" + "a".repeat(64);
const secondProfileId = "sha256:" + "b".repeat(64);
const profileIds = [profileId, secondProfileId];

const hasCode = (expected) => (error) =>
  error?.code === expected && error.message === expected;

function hostPolicy(config) {
  return {
    version: "1",
    purpose: "managed-x402-host-allowlist",
    resourceOrigin: new URL(config.resourceUrl).origin,
    facilitatorOrigin: new URL(config.facilitatorUrl).origin,
    mirrorOrigin: new URL(config.mirrorUrl).origin,
  };
}

function developmentConfig(overrides = {}) {
  return {
    mode: "development",
    network: PROTOCOL.network,
    asset: PROTOCOL.asset,
    receiver: "0.0.1002",
    feePayer: "0.0.7162784",
    providerId,
    profileIds,
    facilitatorUrl: "http://127.0.0.1:41001",
    mirrorUrl: "http://127.0.0.1:41002",
    resourceUrl: "http://127.0.0.1:41003/v1/jobs",
    baseAmountBaseUnits: "100",
    perOutputTokenBaseUnits: "10",
    maxAmountBaseUnits: "1000",
    maxTotalAmountBaseUnits: "2000",
    quoteTtlMs: 60000,
    timeoutMs: 5000,
    maxQuotesPerPrincipal: 10,
    maxQuotes: 100,
    ...overrides,
  };
}

function liveConfig(overrides = {}) {
  return developmentConfig({
    mode: "live",
    facilitatorUrl: PROTOCOL.facilitatorUrl,
    mirrorUrl: PROTOCOL.mirrorUrl,
    resourceUrl: "https://alpha.example/v1/jobs",
    allowLiveSettlement: true,
    ...overrides,
  });
}

function x402Spec(config = developmentConfig(), overrides = {}) {
  return {
    version: "1",
    policy: "ordinary-paid-x402",
    hostPolicy: hostPolicy(config),
    config,
    ...overrides,
  };
}

function mapStore() {
  const namespaces = new Map();
  const namespace = (name) => {
    if (!namespaces.has(name)) namespaces.set(name, new Map());
    return namespaces.get(name);
  };
  return {
    get: (name, id) => namespace(name).get(id),
    set: (name, id, value) => namespace(name).set(id, structuredClone(value)),
    list: (name) =>
      [...namespace(name)].map(([id, value]) => ({
        id,
        ...structuredClone(value),
      })),
    delete: (name, id) => namespace(name).delete(id),
  };
}

function constructorStore(onTouch = () => {}) {
  const metadata = new Map();
  const touch =
    (name, value) =>
    (...args) => {
      onTouch(name);
      return typeof value === "function" ? value(...args) : value;
    };
  return {
    transaction: touch("transaction", (fn) => fn()),
    getMetadata: touch("getMetadata", (key) => metadata.get(key)),
    setMetadata: touch("setMetadata", (key, value) => metadata.set(key, value)),
    countQuotes: touch("countQuotes", 0),
    putQuote: touch("putQuote"),
    getQuote: touch("getQuote", null),
    getPayment: touch("getPayment", null),
    byQuote: touch("byQuote", null),
    byKey: touch("byKey", null),
    byRequest: touch("byRequest", null),
    byTransaction: touch("byTransaction", null),
    listPayments: touch("listPayments", []),
    insertPayment: touch("insertPayment"),
    savePayment: touch("savePayment"),
    getJob: touch("getJob", null),
    putJob: touch("putJob"),
    close: touch("close"),
  };
}

function authorityDecision(context, overrides = {}) {
  const now = Date.now();
  return {
    version: "1",
    decision: "authorized",
    purpose: "ordinary-paid-live-unchecked-v1",
    decisionId: "synthetic-authority-fixture-not-owner-approval",
    binding: context.binding,
    decidedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
}

test("inspection defaults only to explicit non-economic access and is offline/deferred", () => {
  const implicit = inspectManagedPayments({
    mode: "live",
    providerId,
    profileIds,
  });
  const explicit = inspectManagedPayments({
    spec: { version: "1", policy: "non-economic" },
    mode: "live",
    providerId,
    profileIds,
  });
  assert.deepEqual(Object.keys(implicit).sort(), [
    "create",
    "description",
    "offerTerms",
  ]);
  assert.deepEqual(implicit.offerTerms, {
    network: "non-economic",
    asset: "none",
    receiver: providerId,
    mode: "live",
  });
  assert.deepEqual(explicit.offerTerms, implicit.offerTerms);
  assert.equal(Object.isFrozen(implicit), true);
  assert.equal(Object.isFrozen(implicit.offerTerms), true);
  assert.match(implicit.description, /zero-value|non-economic/i);

  const inspected = inspectManagedPayments({
    spec: x402Spec(),
    mode: "development",
    providerId,
    profileIds,
  });
  assert.deepEqual(inspected.offerTerms, {
    network: PROTOCOL.network,
    asset: PROTOCOL.asset,
    receiver: "0.0.1002",
    mode: "development",
  });
  assert.match(inspected.description, /synthetic.*no external calls/i);
});

test("strict policies preserve the protected-payment boundary", () => {
  for (const spec of [
    {},
    { version: "1" },
    { version: "1", policy: "paid" },
    { version: "1", policy: "non-economic", unexpected: true },
    { version: "2", policy: "non-economic" },
    { version: "1", policy: "ordinary-paid-x402" },
  ])
    assert.throws(
      () =>
        inspectManagedPayments({ spec, mode: "live", providerId, profileIds }),
      hasCode("INVALID_MANAGED_PAYMENT_POLICY"),
    );

  assert.throws(
    () =>
      inspectManagedPayments({
        spec: { version: "1", policy: "protected-verifier-contingent" },
        mode: "live",
        providerId,
        profileIds,
      }),
    hasCode("PROTECTED_PAYMENT_UNAVAILABLE"),
  );
});

test("context, x402 config, receiver, and host policy are bound exactly", () => {
  assert.throws(
    () => inspectManagedPayments({ mode: "staging", providerId, profileIds }),
    hasCode("INVALID_MANAGED_PAYMENT_CONTEXT"),
  );
  assert.throws(
    () =>
      inspectManagedPayments({ mode: "live", providerId: "UPPER", profileIds }),
    hasCode("INVALID_MANAGED_PAYMENT_CONTEXT"),
  );
  assert.throws(
    () =>
      inspectManagedPayments({
        mode: "live",
        providerId,
        profileIds: [profileId, profileId],
      }),
    hasCode("INVALID_MANAGED_PAYMENT_CONTEXT"),
  );

  const cases = [
    [
      developmentConfig({ mode: "live", allowLiveSettlement: true }),
      "development",
      "PAYMENT_MODE_MISMATCH",
    ],
    [
      developmentConfig({ providerId: "beta.local" }),
      "development",
      "PAYMENT_PROVIDER_MISMATCH",
    ],
    [
      developmentConfig({ profileIds: [profileId] }),
      "development",
      "PAYMENT_PROFILE_MISMATCH",
    ],
    [developmentConfig({ receiver: "0.0.0" }), "development", "INVALID_CONFIG"],
    [
      developmentConfig({ receiver: "0.0.7162784" }),
      "development",
      "INVALID_CONFIG",
    ],
    [
      developmentConfig({ privateKey: "must-not-be-config" }),
      "development",
      "INVALID_MANAGED_PAYMENT_CONFIG",
    ],
  ];
  for (const [config, mode, code] of cases)
    assert.throws(
      () =>
        inspectManagedPayments({
          spec: x402Spec(config),
          mode,
          providerId,
          profileIds,
        }),
      hasCode(code),
      code,
    );

  const config = developmentConfig();
  assert.throws(
    () =>
      inspectManagedPayments({
        spec: x402Spec(config, {
          hostPolicy: {
            ...hostPolicy(config),
            resourceOrigin: "http://127.0.0.1:49999",
          },
        }),
        mode: "development",
        providerId,
        profileIds,
      }),
    hasCode("PAYMENT_HOST_POLICY_MISMATCH"),
  );
  assert.throws(
    () =>
      inspectManagedPayments({
        spec: x402Spec(config, {
          hostPolicy: { ...hostPolicy(config), extra: true },
        }),
        mode: "development",
        providerId,
        profileIds,
      }),
    hasCode("INVALID_MANAGED_PAYMENT_POLICY"),
  );
});

test("source constructor validates staged x402 config without store or network effects", () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("network must remain unreachable during inspection");
  };
  try {
    assert.throws(
      () =>
        inspectManagedPayments({
          spec: x402Spec(developmentConfig({ baseAmountBaseUnits: "01" })),
          mode: "development",
          providerId,
          profileIds,
        }),
      hasCode("INVALID_AMOUNT"),
    );
    assert.doesNotThrow(() =>
      inspectManagedPayments({
        spec: x402Spec(),
        mode: "development",
        providerId,
        profileIds,
      }),
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("non-economic descriptor creates the existing zero-value provider-bound port", async () => {
  const descriptor = inspectManagedPayments({
    spec: {
      version: "1",
      policy: "non-economic",
      maxRecords: 10,
      quoteTtlMs: 60_000,
    },
    mode: "development",
    providerId,
    profileIds,
  });
  const payments = descriptor.create({ store: mapStore() });
  const request = {
    ...fixtureRequest,
    providerId,
    profileId,
  };
  const quote = await payments.quote({ request, principalId: "buyer" });
  assert.equal(quote.amountBaseUnits, "0");
  assert.equal(quote.receiver, providerId);
  assert.equal(quote.network, "non-economic");
  const result = await payments.authorize({
    request,
    quoteId: quote.quoteId,
    principalId: "buyer",
    idempotencyKey: "attempt-1",
    paymentHeaders: {},
  });
  assert.equal(result.kind, "authorized");
  assert.equal(result.payment.status, "authorized");
  await payments.close();
});

test("development x402 composes the real port and official SDK codecs over local synthetic fixtures", async (t) => {
  const fixture = await facilitatorFixture();
  t.after(fixture.close);
  const dir = await mkdtemp(join(tmpdir(), "managed-payment-x402-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    ...fixture.config,
    providerId,
    profileIds,
  };
  const descriptor = inspectManagedPayments({
    spec: x402Spec(config),
    mode: "development",
    providerId,
    profileIds,
  });
  const payments = descriptor.create({
    store: createSqliteStore({ path: join(dir, "payments.sqlite") }),
  });
  t.after(() => payments.close());
  const request = { ...fixtureRequest, providerId, profileId };
  const quote = await payments.quote({ request, principalId: "buyer" });
  assert.equal(quote.providerId, providerId);
  assert.equal(quote.profileId, profileId);
  assert.equal(quote.receiver, config.receiver);
  const args = {
    request,
    quoteId: quote.quoteId,
    principalId: "buyer",
    idempotencyKey: "attempt-1",
    paymentHeaders: {},
  };
  const challenge = await payments.authorize(args);
  assert.equal(challenge.kind, "required");
  assert.equal(challenge.status, 402);
  assert.deepEqual(
    decodePaymentRequiredHeader(challenge.headers["payment-required"]),
    challenge.body,
  );
  const signed = fixture.register(await proof(challenge.body));
  const result = await payments.authorize({
    ...args,
    paymentHeaders: signed.headers,
  });
  assert.equal(result.kind, "authorized");
  assert.equal(result.payment.status, "settled");
  assert.equal(fixture.state.verify, 1);
  assert.equal(fixture.state.settle, 1);
  assert.equal(fixture.state.mirror, 1);
});

test("live x402 refuses before effects without current ordinary-paid host authority", () => {
  const descriptor = inspectManagedPayments({
    spec: x402Spec(liveConfig()),
    mode: "live",
    providerId,
    profileIds,
  });
  let storeEffects = 0;
  const store = new Proxy(
    {},
    {
      get() {
        storeEffects++;
        throw new Error("store touched before authority");
      },
    },
  );
  assert.throws(
    () => descriptor.create({ store }),
    hasCode("ORDINARY_PAID_AUTHORITY_REQUIRED"),
  );
  assert.equal(storeEffects, 0);
});

test("live construction accepts only a fresh decision bound to exact offer and host policy", () => {
  const descriptor = inspectManagedPayments({
    spec: x402Spec(liveConfig()),
    mode: "live",
    providerId,
    profileIds,
  });
  let touches = 0;
  const store = constructorStore(() => touches++);
  const badAuthority = {
    assertOrdinaryPaidLiveAuthorized(context) {
      return authorityDecision(context, {
        binding: "sha256:" + "0".repeat(64),
      });
    },
  };
  assert.throws(
    () => descriptor.create({ store, ordinaryPaidAuthority: badAuthority }),
    hasCode("INVALID_ORDINARY_PAID_AUTHORITY"),
  );
  assert.equal(touches, 0);

  let observed;
  const ordinaryPaidAuthority = {
    assertOrdinaryPaidLiveAuthorized(context) {
      observed = context;
      assert.equal(Object.isFrozen(context), true);
      assert.equal(Object.isFrozen(context.hostPolicy), true);
      return authorityDecision(context);
    },
  };
  const payments = descriptor.create({ store, ordinaryPaidAuthority });
  assert.equal(observed.providerId, providerId);
  assert.deepEqual(observed.profileIds, profileIds);
  assert.equal(observed.offerTerms.receiver, "0.0.1002");
  assert.equal(observed.maxTotalAmountBaseUnits, "2000");
  assert.ok(touches > 0);
  payments.close();
});
