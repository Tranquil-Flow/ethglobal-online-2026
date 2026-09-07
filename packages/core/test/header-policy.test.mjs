import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { digestOf } from "../../contracts/index.mjs";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import {
  createApp,
  createStore,
  createSigner,
  createDevelopmentExecutor,
  createDevelopmentPayments,
  developmentProfile,
} from "../src/index.mjs";

test("reviewed PaymentsPort policy rejects privileged, hop-by-hop, duplicate, uppercase and absent policy at construction", () => {
  for (const name of [
    "authorization",
    "cookie",
    "set-cookie",
    "host",
    "proxy-authorization",
    "proxy-authenticate",
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])
    for (const direction of ["request", "response"])
      assert.throws(
        () =>
          createApp({
            config: { mode: "development" },
            store: {},
            payments: {
              headerPolicy: { request: [], response: [], [direction]: [name] },
            },
          }),
        /header|policy/i,
      );
  for (const policy of [
    undefined,
    { request: ["PAYMENT-SIGNATURE"], response: [] },
    { request: ["payment-signature", "payment-signature"], response: [] },
    { request: "payment-signature", response: [] },
  ])
    assert.throws(
      () =>
        createApp({
          config: { mode: "development" },
          store: {},
          payments: { headerPolicy: policy },
        }),
      /header|policy/i,
    );
});

test("raw HTTP header boundary strips bearer/cookies, preserves SDK bytes, rejects duplicates and response injection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "core-policy-")),
    store = createStore({ path: join(dir, "db") });
  const base = createDevelopmentPayments();
  let seen,
    calls = 0,
    malicious = false;
  const required = {
    x402Version: 2,
    resource: {
      url: "https://development.invalid/v1/jobs",
      mimeType: "application/json",
    },
    accepts: [],
  };
  const encoded = encodePaymentRequiredHeader(required);
  const policy = {
    request: ["payment-signature"],
    response: ["payment-required"],
  };
  const payments = {
    ...base,
    headerPolicy: policy,
    async authorize(args) {
      seen = args.paymentHeaders;
      calls++;
      return {
        kind: "required",
        status: 402,
        headers: malicious
          ? { "payment-required": encoded, "set-cookie": "forbidden" }
          : { "payment-required": encoded },
        body: {},
      };
    },
  };
  const app = createApp({
    config: {
      mode: "development",
      profiles: [developmentProfile],
      providerIds: ["development.invalid"],
    },
    store,
    payments,
    executor: createDevelopmentExecutor(),
    signer: createSigner({
      privateKey: generateKeyPairSync("ed25519").privateKey,
      keyId: "test",
    }),
  });
  try {
    const { url } = await app.listen({ port: 0 });
    const post = async (path, body, headers = {}) => {
      const r = await fetch(url + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json(), headers: r.headers };
    };
    const cap = (await post("/v1/sessions", {})).body.capability;
    const auth = { authorization: ["Bearer", cap].join(" ") };
    const request = {
      version: "1",
      nonce: "4".repeat(64),
      providerId: "development.invalid",
      profileId: digestOf(developmentProfile),
      prompt: "SYNTHETIC",
      maxOutputTokens: 32,
      seed: 0,
      sampling: "greedy",
      publishConsent: false,
    };
    const q = (await post("/v1/quotes", { request }, auth)).body;
    const body = { request, quoteId: q.quoteId };
    policy.request.push("cookie"); // Constructor must snapshot its validated policy.
    const r = await post("/v1/jobs", body, {
      ...auth,
      cookie: "synthetic-cookie",
      "payment-signature": "synthetic-proof==",
      "x-private": "synthetic-extra",
      "idempotency-key": "policy",
    });
    assert.equal(r.status, 402);
    assert.equal(r.headers.get("payment-required"), encoded);
    assert.deepEqual(seen, { "payment-signature": "synthetic-proof==" });
    const raw = async (headers) =>
      new Promise((resolve, reject) => {
        const req = http.request(
          url + "/v1/jobs",
          {
            method: "POST",
            headers: [
              "content-type",
              "application/json",
              "authorization",
              auth.authorization,
              "idempotency-key",
              "policy",
              ...headers,
            ],
          },
          (res) => {
            let text = "";
            res.on("data", (b) => (text += b));
            res.on("end", () => resolve({ status: res.statusCode, text }));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    assert.equal(
      (await raw(["payment-signature", "one", "Payment-Signature", "two"]))
        .status,
      400,
    );
    assert.equal(calls, 1);
    malicious = true;
    assert.equal(
      (await post("/v1/jobs", body, { ...auth, "idempotency-key": "policy" }))
        .status,
      503,
    );
    assert.equal(store.list("jobs").length, 0);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
