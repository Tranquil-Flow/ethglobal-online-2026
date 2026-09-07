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

test("authorization timeout and restart reconcile SAME key without another payment, even after quote cache expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "core-recovery-")),
    path = join(dir, "db");
  let store = createStore({ path }),
    app;
  const signer = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "key",
  });
  let calls = 0,
    executions = 0;
  const seen = [];
  const config = {
    mode: "development",
    profiles: [developmentProfile],
    providerIds: ["development.invalid"],
    portTimeoutMs: 20,
    maintenanceMs: 20,
  };
  async function start() {
    const base = createDevelopmentPayments({ store });
    app = createApp({
      config,
      store,
      signer,
      executor: {
        execute(args) {
          executions++;
          return createDevelopmentExecutor().execute(args);
        },
      },
      payments: {
        ...base,
        async authorize(args) {
          calls++;
          seen.push({
            principalId: args.principalId,
            key: args.idempotencyKey,
          });
          const result = await base.authorize(args);
          if (calls === 1) await delay(70);
          return result;
        },
      },
    });
    return (await app.listen({ port: 0 })).url;
  }
  try {
    let url = await start();
    const call = async (path, { body, cap, key } = {}) => {
      const r = await fetch(url + path, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          ...(cap ? { authorization: ["Bearer", cap].join(" ") } : {}),
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json() };
    };
    const cap = (await call("/v1/sessions", { body: {} })).body.capability;
    const request = {
      version: "1",
      nonce: "f".repeat(64),
      providerId: "development.invalid",
      profileId: digestOf(developmentProfile),
      prompt: "SYNTHETIC",
      maxOutputTokens: 32,
      seed: 0,
      sampling: "greedy",
      publishConsent: false,
    };
    const q = (await call("/v1/quotes", { body: { request }, cap })).body;
    const body = { request, quoteId: q.quoteId };
    assert.equal(
      (await call("/v1/jobs", { body, cap, key: "same-key" })).status,
      503,
    );
    assert.equal(store.list("development-payments").length, 1);
    await delay(80);
    await app.close();
    store.delete("quotes", q.quoteId);
    const devQuote = store.get("development-quotes", q.quoteId);
    devQuote.value.q.expiresAt = new Date(0).toISOString();
    store.set("development-quotes", q.quoteId, devQuote);
    store.close();
    store = createStore({ path });
    url = await start();
    const recovered = await call("/v1/jobs", { body, cap, key: "same-key" });
    assert.equal(recovered.status, 202);
    assert.equal(calls, 2);
    assert.deepEqual(seen[0], seen[1]);
    for (let i = 0; i < 100; i++) {
      const j = await call("/v1/jobs/" + recovered.body.job.jobId, { cap });
      if (j.body.executionStatus === "succeeded") break;
      await delay(10);
    }
    assert.equal(executions, 1);
    assert.equal(store.list("development-payments").length, 1);
    assert.equal(store.list("jobs").length, 1);
    const again = await call("/v1/jobs", { body, cap, key: "same-key" });
    assert.equal(again.body.job.jobId, recovered.body.job.jobId);
    assert.equal(calls, 2);
  } finally {
    await app?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
