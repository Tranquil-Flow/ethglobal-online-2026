import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import {
  preflightApplication,
  startApplicationWorkbench,
} from "../application-workbench.mjs";
import { setup } from "./fixtures/application.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(read, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(25);
  }
  throw last ?? Error("Timed out waiting for " + label);
}

async function complete(
  client,
  providerId,
  profileId,
  { consent, key, prompt },
) {
  const request = await createRequest({
    providerId,
    profileId,
    prompt,
    maxOutputTokens: 2,
    seed: 0,
    publishConsent: consent,
  });
  const quote = await client.createQuote(request);
  const submitted = await client.submitJob({
    request,
    quoteId: quote.quoteId,
    idempotencyKey: key,
    authorization: {
      maxAmountBaseUnits: "0",
      network: quote.network,
      asset: quote.asset,
    },
  });
  for await (const _event of client.streamJob(submitted.job.jobId)) {
    // The terminal event is the production completion boundary.
  }
  return { request, jobId: submitted.job.jobId };
}

test("application preflight accepts only a complete optional EventSink port", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "application-publisher-preflight-"),
  );
  try {
    for (const eventSink of [null, {}, { publish() {} }, { close() {} }]) {
      const fixture = setup(root);
      fixture.bindings.eventSink = eventSink;
      assert.throws(
        () => preflightApplication(fixture),
        /INVALID_EVENT_SINK_BINDING/,
      );
    }
    const fixture = setup(root);
    fixture.bindings.eventSink = { async publish() {}, async close() {} };
    assert.equal(preflightApplication(fixture).entries.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted EventSink ownership is released when workbench startup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "application-publisher-cleanup-"));
  const server = createServer();
  let closes = 0;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const fixture = setup(root);
    fixture.config.port = server.address().port;
    fixture.bindings.eventSink = {
      async publish() {
        return { status: "unavailable" };
      },
      async close() {
        closes++;
      },
    };
    await assert.rejects(
      startApplicationWorkbench(fixture),
      /PORT_UNAVAILABLE/,
    );
    assert.equal(closes, 1);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("managed EventSink is consent/outbox driven, private, restart-safe, and composition-owned", async () => {
  const parent = await mkdtemp(join(tmpdir(), "managed-publication-"));
  const root = join(parent, "state");
  const configFile = join(root, "application.json");
  const firstCalls = [];
  let firstCloses = 0;
  let app;
  try {
    await initializeApplication({
      dataDir: root,
      providerIds: ["alpha.local"],
    });
    const firstSink = {
      async publish(args) {
        firstCalls.push(
          structuredClone({
            event: args.event,
            idempotencyKey: args.idempotencyKey,
            aborted: args.signal?.aborted,
          }),
        );
        throw Error("private synthetic transport canary");
      },
      async close() {
        firstCloses++;
      },
    };
    app = await startManagedApplication({ configFile, eventSink: firstSink });
    const pins = app.pins["alpha.local"];
    const client = createClient({ baseUrl: app.url, pins });
    await client.connect();

    const silent = await complete(client, "alpha.local", app.profileIds[0], {
      consent: false,
      key: "managed-silent",
      prompt: "PRIVATE SILENT PROMPT",
    });
    await delay(250);
    assert.equal(firstCalls.length, 0);
    assert.deepEqual(await client.getPublication(silent.jobId), {
      version: "1",
      jobId: silent.jobId,
      consent: false,
      events: [],
    });

    const consented = await complete(client, "alpha.local", app.profileIds[0], {
      consent: true,
      key: "managed-consented",
      prompt: "PRIVATE CONSENTED PROMPT",
    });
    await waitFor(() => firstCalls.length > 0, "initial outbox delivery");
    const pending = await client.getPublication(consented.jobId);
    assert.equal(pending.consent, true);
    assert.equal(pending.events.length, 1);
    assert.equal(pending.events[0].kind, "receipt");
    assert.equal(pending.events[0].status, "pending");
    assert.equal(firstCalls[0].aborted, false);
    const exposed = JSON.stringify({ calls: firstCalls, pending });
    assert.equal(exposed.includes(consented.request.prompt), false);
    assert.equal(exposed.includes(consented.request.nonce), false);
    assert.equal(exposed.includes("transport canary"), false);

    const capability = client.capability;
    const firstDelivery = firstCalls[0];
    await app.close();
    await app.close();
    app = undefined;
    assert.equal(firstCloses, 1);

    const resumedCalls = [];
    let resumedCloses = 0;
    const resumedSink = {
      async publish(args) {
        resumedCalls.push(
          structuredClone({
            event: args.event,
            idempotencyKey: args.idempotencyKey,
            aborted: args.signal?.aborted,
          }),
        );
        return {
          status: "confirmed",
          transactionRef: "development:managed-publication-test",
        };
      },
      async close() {
        resumedCloses++;
      },
    };
    app = await startManagedApplication({ configFile, eventSink: resumedSink });
    const resumedClient = createClient({
      baseUrl: app.url,
      capability,
      pins: app.pins["alpha.local"],
    });
    const confirmed = await waitFor(async () => {
      const state = await resumedClient.getPublication(consented.jobId);
      return state.events[0]?.status === "confirmed" ? state : undefined;
    }, "restarted outbox confirmation");
    assert.equal(
      confirmed.events[0].transactionRef,
      "development:managed-publication-test",
    );
    assert.equal(resumedCalls.length, 1);
    assert.deepEqual(resumedCalls[0].event, firstDelivery.event);
    assert.equal(resumedCalls[0].idempotencyKey, firstDelivery.idempotencyKey);
    assert.equal(resumedCalls[0].aborted, false);

    await app.close();
    await app.close();
    app = undefined;
    assert.equal(resumedCloses, 1);
  } finally {
    await app?.close();
    await rm(parent, { recursive: true, force: true });
  }
});
