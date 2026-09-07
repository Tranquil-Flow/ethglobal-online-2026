import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createApp,
  createDevelopmentPayments,
  createSigner,
  createStore,
  developmentProfile,
  verifyEvidence,
} from "../packages/core/src/index.mjs";
import { digestOf, requestHash } from "../packages/contracts/index.mjs";

const providerId = "conformance.invalid";
const profileId = digestOf(developmentProfile);
const terminalStates = new Set(["succeeded", "failed", "cancelled"]);

function requestFor(suffix, overrides = {}) {
  return {
    version: "1",
    nonce: suffix.padStart(64, suffix[0] || "0").slice(0, 64),
    providerId,
    profileId,
    prompt: "BOUND",
    maxOutputTokens: 8,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
    ...overrides,
  };
}

async function fixture(executor, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "executor-conformance-"));
  const store = createStore({ path: join(dir, "core.sqlite") });
  const signer = createSigner({
    privateKey: generateKeyPairSync("ed25519").privateKey,
    keyId: "executor-conformance-key",
  });
  const app = createApp({
    config: {
      mode: "development",
      profiles: [developmentProfile],
      providerIds: [providerId],
      maintenanceMs: 10,
      jobDeadlineMs: 100,
      maxOutputBytes: 64,
      ...config,
    },
    store,
    signer,
    payments: createDevelopmentPayments({ store }),
    executor,
  });
  const { url } = await app.listen({ host: "127.0.0.1", port: 0 });
  async function call(path, { method = "GET", body, cap, key } = {}) {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cap ? { authorization: `Bearer ${cap}` } : {}),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const eventStream = response.headers
      .get("content-type")
      ?.startsWith("text/event-stream");
    return {
      status: response.status,
      body: text ? (eventStream ? text : JSON.parse(text)) : undefined,
    };
  }
  const cap = (await call("/v1/sessions", { method: "POST", body: {} })).body
    .capability;
  async function submit(request, key) {
    const quote = await call("/v1/quotes", {
      method: "POST",
      body: { request },
      cap,
    });
    assert.equal(quote.status, 201);
    const reply = await call("/v1/jobs", {
      method: "POST",
      body: { request, quoteId: quote.body.quoteId },
      cap,
      key,
    });
    assert.equal(reply.status, 202);
    return reply.body.job.jobId;
  }
  async function waitFor(jobId) {
    for (let n = 0; n < 200; n++) {
      const reply = await call(`/v1/jobs/${jobId}`, { cap });
      if (terminalStates.has(reply.body?.executionStatus)) return reply.body;
      await delay(5);
    }
    throw new Error("conformance job did not terminate");
  }
  return {
    call,
    cap,
    signer,
    submit,
    waitFor,
    async close() {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function completion(request, profile, text = request.prompt) {
  const tokenIds = Array.from(text, (character) => character.codePointAt(0));
  return {
    output: { text, tokenIds, finishReason: "stop" },
    profileId: digestOf(profile),
  };
}

/**
 * Exercise an ExecutorPort through the real core HTTP/job/receipt path.
 * factory({scenario, observe}) must return a fresh deterministic ExecutorPort.
 * This is local contract evidence, not live runtime or inference qualification.
 */
export async function runExecutorPortConformance({ factory }) {
  if (typeof factory !== "function") throw new TypeError("factory is required");
  const passed = [];
  async function check(name, scenario, body, config) {
    const observed = [];
    const h = await fixture(factory({ scenario, observed }), config);
    try {
      await body(h, observed);
      passed.push(name);
    } finally {
      await h.close();
    }
  }

  await check("binding-stream-receipt", "success", async (h, observed) => {
    const request = requestFor("1");
    const id = await h.submit(request, "binding");
    const job = await h.waitFor(id);
    assert.equal(job.executionStatus, "succeeded");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].jobId, id);
    assert.deepEqual(observed[0].request, request);
    assert.deepEqual(observed[0].profile, developmentProfile);
    assert.equal(observed[0].signal instanceof AbortSignal, true);
    const events = await h.call(`/v1/jobs/${id}/events`, { cap: h.cap });
    assert.equal(events.status, 200);
    const deltas = [...events.body.matchAll(/event: delta\ndata: (.+)/g)].map(
      (match) => JSON.parse(match[1]),
    );
    assert.equal(deltas.map((event) => event.text).join(""), request.prompt);
    assert.deepEqual(
      deltas.flatMap((event) => event.tokenIds),
      Array.from(request.prompt, (character) => character.codePointAt(0)),
    );
    assert.match(events.body, /event: done/);
    // The retained export binds accumulated output and the receipt through the
    // production core path.
    const evidence = await h.call(`/v1/jobs/${id}/evidence`, { cap: h.cap });
    assert.equal(evidence.status, 200);
    assert.equal(evidence.body.output.text, request.prompt);
    assert.equal(h.signer.verify(evidence.body.receipt), true);
    assert.equal(
      verifyEvidence(evidence.body, {
        trustedKeys: {
          [evidence.body.receipt.keyId]: h.signer.publicKey(
            evidence.body.receipt.keyId,
          ).publicKeyJwk,
        },
      }),
      true,
    );
    assert.equal(
      evidence.body.receipt.payload.requestHash,
      requestHash(request),
    );
    assert.equal(evidence.body.receipt.payload.profileId, profileId);
    assert.equal(evidence.body.receipt.payload.providerId, providerId);
    assert.equal(
      evidence.body.receipt.payload.outputHash,
      digestOf(evidence.body.output),
    );
  });

  await check("output-token-bound", "overflow-token", async (h) => {
    const id = await h.submit(
      requestFor("2", { maxOutputTokens: 1 }),
      "overflow",
    );
    const job = await h.waitFor(id);
    assert.equal(job.executionStatus, "failed");
    assert.equal(job.failureCode, "OUTPUT_LIMIT");
    assert.equal(
      (await h.call(`/v1/jobs/${id}/receipt`, { cap: h.cap })).status,
      409,
    );
  });

  await check(
    "output-byte-bound",
    "overflow-bytes",
    async (h) => {
      const id = await h.submit(
        requestFor("7", { prompt: "é" }),
        "byte-overflow",
      );
      const job = await h.waitFor(id);
      assert.equal(job.executionStatus, "failed");
      assert.equal(job.failureCode, "OUTPUT_LIMIT");
      assert.equal(
        (await h.call(`/v1/jobs/${id}/receipt`, { cap: h.cap })).status,
        409,
      );
    },
    { maxOutputBytes: 1 },
  );

  await check("profile-mismatch", "profile-mismatch", async (h) => {
    const id = await h.submit(requestFor("3"), "profile");
    const job = await h.waitFor(id);
    assert.equal(job.failureCode, "EXECUTION_MISMATCH");
    assert.equal(
      (await h.call(`/v1/jobs/${id}/receipt`, { cap: h.cap })).status,
      409,
    );
  });

  await check("failure", "failure", async (h) => {
    const id = await h.submit(requestFor("4"), "failure");
    const job = await h.waitFor(id);
    assert.equal(job.failureCode, "EXECUTION_FAILED");
    assert.equal(
      (await h.call(`/v1/jobs/${id}/receipt`, { cap: h.cap })).status,
      409,
    );
  });

  await check(
    "timeout-aborts",
    "timeout",
    async (h, observed) => {
      const id = await h.submit(requestFor("5"), "timeout");
      const job = await h.waitFor(id);
      assert.equal(job.failureCode, "EXECUTION_DEADLINE");
      assert.equal(observed.at(-1).aborted, true);
      assert.equal(
        (await h.call(`/v1/jobs/${id}/receipt`, { cap: h.cap })).status,
        409,
      );
    },
    { jobDeadlineMs: 30 },
  );

  await check("cancellation-aborts", "cancel", async (h, observed) => {
    const id = await h.submit(requestFor("6"), "cancel");
    for (let n = 0; n < 100 && observed.length === 0; n++) await delay(2);
    assert.equal(
      (
        await h.call(`/v1/jobs/${id}/cancel`, {
          method: "POST",
          body: {},
          cap: h.cap,
        })
      ).body.executionStatus,
      "cancelled",
    );
    await delay(10);
    assert.equal(observed.at(-1).aborted, true);
    assert.equal(
      (await h.call(`/v1/jobs/${id}/receipt`, { cap: h.cap })).status,
      409,
    );
  });

  return Object.freeze(passed);
}

export function createDeterministicTestExecutor({ scenario, observed }) {
  return {
    mode: "development",
    async *execute(args) {
      observed.push(args);
      if (scenario === "failure")
        throw new Error("deterministic fixture failure");
      if (scenario === "timeout" || scenario === "cancel") {
        try {
          await delay(10_000, undefined, { signal: args.signal });
        } catch {
          observed.push({ aborted: args.signal.aborted });
        }
        return;
      }
      if (scenario === "overflow-token") {
        yield { type: "delta", text: "AB", tokenIds: [65, 66] };
        return;
      }
      if (scenario === "overflow-bytes") {
        yield { type: "delta", text: "é", tokenIds: [233] };
        return;
      }
      const complete = completion(args.request, args.profile);
      for (let i = 0; i < complete.output.tokenIds.length; i++) {
        yield {
          type: "delta",
          text: Array.from(complete.output.text)[i],
          tokenIds: [complete.output.tokenIds[i]],
        };
      }
      yield {
        type: "completed",
        ...complete,
        ...(scenario === "profile-mismatch"
          ? { profileId: `sha256:${"0".repeat(64)}` }
          : {}),
      };
    },
  };
}
