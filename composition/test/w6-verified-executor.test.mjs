import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerifiedExecutor } from "../w6-verified-executor.mjs";

function fakeExecutor(events) {
  return {
    mode: "live",
    status: () => ({ status: "idle" }),
    async *executeInner() {},
    execute() {
      const self = this;
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}

test("wraps executor and enqueues observation after completed, non-blocking", async () => {
  const seen = [];
  const bridge = {
    enqueueCompletedJob(job) {
      seen.push(job);
      return { enqueued: true, completion: new Promise(() => {}) }; // never settles
    },
  };
  const exec = createVerifiedExecutor({
    executor: fakeExecutor([{ type: "delta", text: "a" }, { type: "completed", output: { text: "a" }, profileId: "p1" }]),
    bridge,
    providerId: "prov-1",
  });
  const out = [];
  for await (const e of exec.execute({ jobId: "job-9" })) out.push(e);
  assert.equal(out.length, 2);
  assert.equal(seen.length, 1, "exactly one observation enqueued");
  assert.equal(seen[0].requestId, "job-9");
  assert.equal(seen[0].providerId, "prov-1");
  assert.equal(seen[0].profileId, "p1");
  assert.equal(seen[0].executionStatus, "succeeded");
  // completed event still yielded downstream
  assert.equal(out[1].type, "completed");
});

test("no observation for failed/cancelled streams (no completed event)", async () => {
  const seen = [];
  const bridge = { enqueueCompletedJob(j) { seen.push(j); return { enqueued: false }; } };
  const exec = createVerifiedExecutor({
    executor: fakeExecutor([{ type: "delta", text: "x" }]),
    bridge,
    providerId: "p",
  });
  for await (const _ of exec.execute({ jobId: "j" })) { /* drain */ }
  assert.equal(seen.length, 0);
});

test("bridge enqueue throwing never breaks the served stream", async () => {
  const bridge = { enqueueCompletedJob() { throw new Error("boom"); } };
  const exec = createVerifiedExecutor({
    executor: fakeExecutor([{ type: "completed", output: { text: "ok" }, profileId: "p" }]),
    bridge,
    providerId: "p",
  });
  const out = [];
  for await (const e of exec.execute({ jobId: "j" })) out.push(e);
  assert.equal(out[0].type, "completed");
});

test("duplicate completed events enqueue once", async () => {
  const seen = [];
  const bridge = { enqueueCompletedJob(j) { seen.push(j); return { enqueued: true, completion: Promise.resolve(null) }; } };
  const exec = createVerifiedExecutor({
    executor: fakeExecutor([
      { type: "completed", output: { text: "1" }, profileId: "p" },
      { type: "completed", output: { text: "1" }, profileId: "p" },
    ]),
    bridge,
    providerId: "p",
  });
  for await (const _ of exec.execute({ jobId: "j" })) { /* drain */ }
  assert.equal(seen.length, 1);
});

test("validates constructor args", () => {
  assert.throws(() => createVerifiedExecutor({ executor: null, bridge: {}, providerId: "p" }), /EXECUTOR_REQUIRED/);
  assert.throws(() => createVerifiedExecutor({ executor: fakeExecutor([]), bridge: null, providerId: "p" }), /BRIDGE_REQUIRED/);
  assert.throws(() => createVerifiedExecutor({ executor: fakeExecutor([]), bridge: {}, providerId: "" }), /BRIDGE_REQUIRED|PROVIDER_ID_REQUIRED/);
});
