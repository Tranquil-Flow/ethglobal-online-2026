import test from "node:test";
import assert from "node:assert/strict";
import { digestOf } from "../../packages/contracts/index.mjs";
import { createNativeMyceliumExecutor } from "../mycelium-livhttp.mjs";
import { startNativeConformanceGateway } from "../conformance-gateway.mjs";

import { fixtureProfile, optionsFor, argsFor } from "./fixtures/w6-native.mjs";
const collect = async (iterator) => { const out = []; for await (const e of iterator) out.push(e); return out; };

function createExecutorWithMutatedTokenIds(options, mutate) {
  const directFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await directFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : input);
    if (!url.pathname.endsWith("/events") || !response.body) return response;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    let pending = "";
    const inject = (frame) => frame.split("\n").map((line) => {
      if (!line.startsWith("data: ")) return line;
      const event = JSON.parse(line.slice(6));
      if (event.type === "token") mutate(event);
      return `data: ${JSON.stringify(event)}`;
    }).join("\n");
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = pending.indexOf("\n\n")) !== -1) {
          controller.enqueue(encoder.encode(inject(pending.slice(0, end)) + "\n\n"));
          pending = pending.slice(end + 2);
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(pending));
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  try { return createNativeMyceliumExecutor(options); }
  finally { globalThis.fetch = directFetch; }
}

test("native v2 conformance fixture and adapter round-trip stable gateway token ids", async () => {
  const s = await startNativeConformanceGateway();
  try {
    const o = optionsFor(s); const e = createNativeMyceliumExecutor(o);
    const events = await collect(e.execute(argsFor(o.profile)));
    assert.equal(events.filter(e => e.type === "completed").length, 1);
    const last = events.at(-1);
    assert.deepEqual(last.output, { text: "Hello from the fixture.", tokenIds: [55603, 31176], finishReason: "stop" });
    assert.equal(last.profileId, digestOf(o.profile));
    assert.deepEqual(events.slice(0,-1).map(e => e.tokenIds), [[55603], [31176]]);
    assert.equal(e.status().tokenIdsAvailable, true);
    assert.match(last.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(last.evidenceDigest, s.binding.qualification_digest);
    assert.deepEqual(s.stats().bodies[0].qualification, s.binding);
    assert.equal(s.stats().bodies[0].protocol, "mycelium.request_gateway.v2");
    assert.equal(s.stats().bodies[0].workload_profile_id, "interactive_chat_v1");
    assert.ok(s.stats().qualifications >= 2);
    assert.ok(!JSON.stringify(e).includes(s.bearerToken));
  } finally { await s.close(); }
});
for (const [fault, code] of [["generation","GENERATION_CHANGED"],["order","EVENT_ORDER"],["eof","MISSING_TERMINAL"],["after-terminal","AFTER_TERMINAL"],["drift","QUALIFICATION_CHANGED"],["stale","STALE_QUALIFICATION"],["unavailable","ROUTE_UNAVAILABLE"]]) {
  test(`native ${fault} never emits a completed result`, async () => {
    const s = await startNativeConformanceGateway({ fault });
    try { const o = optionsFor(s); const e = createNativeMyceliumExecutor(o); const events = [];
      await assert.rejects(async () => { for await (const row of e.execute(argsFor(o.profile))) events.push(row); }, new RegExp(code));
      assert.ok(!events.some(e => e.type === "completed"));
    } finally { await s.close(); }
  });
}
test("cancellation sends native DELETE, observes cancellation, no completion or second POST", async () => {
  const s = await startNativeConformanceGateway({ fault: "slow" });
  try { const o = optionsFor(s); const e = createNativeMyceliumExecutor(o); const a = argsFor(o.profile); const c = new AbortController(); a.signal = c.signal; const events = [];
    await assert.rejects(async () => { for await (const row of e.execute(a)) { events.push(row); c.abort(); } }, /EXECUTION_CANCELLED|ABORTED/);
    assert.equal(s.stats().cancellations, 1); assert.equal(s.stats().submissions, 1);
    assert.ok(!events.some(e => e.type === "completed"));
  } finally { await s.close(); }
});
for (const [label, makeExecutor] of [
  ["missing", (options) => createExecutorWithMutatedTokenIds(options, (event) => { delete event.token_id; })],
  ["invalid", (options) => createExecutorWithMutatedTokenIds(options, (event) => { event.token_id = true; })],
]) {
  test(`native ${label} token id fails closed without a completed result`, async () => {
    const s = await startNativeConformanceGateway();
    try {
      const o = optionsFor(s); const e = makeExecutor(o); const events = [];
      await assert.rejects(async () => { for await (const row of e.execute(argsFor(o.profile))) events.push(row); }, /MISSING_NATIVE_TOKEN_ID/);
      assert.ok(!events.some((row) => row.type === "completed"));
      assert.equal(e.status().tokenIdsAvailable, false);
    } finally { await s.close(); }
  });
}
test("caller cannot replace pinned model profile or supply qualification before submit", async () => {
  const s = await startNativeConformanceGateway();
  try { const o=optionsFor(s); const e=await createNativeMyceliumExecutor(o);
    const bad=argsFor(o.profile, {profileId:digestOf("forged")});
    await assert.rejects(async () => collect(e.execute(bad)), /PROFILE_MISMATCH/); assert.equal(s.stats().submissions,0);
    assert.throws(() => createNativeMyceliumExecutor({...o, qualification:s.binding}), /INVALID_NATIVE_OPTIONS/);
  } finally { await s.close(); }
});
