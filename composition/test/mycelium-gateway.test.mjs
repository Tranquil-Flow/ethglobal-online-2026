import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createGatewayTransport,
  parseGatewayEvents,
} from "../mycelium-gateway.mjs";

test("uncertain POST is not retried and errors do not echo private transport details", async () => {
  let calls = 0;
  const transport = createGatewayTransport({
    baseUrl: "http://127.0.0.1:1",
    bearerToken: "conformance-only",
    fetchImpl: async () => {
      calls++;
      throw Error("private-transport-marker");
    },
  });
  await assert.rejects(
    transport.submit({ prompt: "synthetic" }),
    (e) => e.message === "SUBMISSION_UNKNOWN",
  );
  assert.equal(calls, 1);
});

test("server-native SSE generation cursor, token ordering and terminal completeness", async () => {
  const events = [
    {
      protocol: "mycelium.request_event.v2",
      request_id: "r1",
      publisher_generation: 1,
      sequence: 0,
      type: "accepted",
    },
    {
      protocol: "mycelium.request_event.v2",
      request_id: "r1",
      publisher_generation: 1,
      sequence: 1,
      type: "token",
      token_index: 0,
      text: "x",
    },
    {
      protocol: "mycelium.request_event.v2",
      request_id: "r1",
      publisher_generation: 1,
      sequence: 2,
      type: "completed",
    },
  ];
  const encode = (e) =>
    `id: ${e.publisher_generation}:${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const body = events.map(encode).join("");
  async function* chunks(s) {
    const b = Buffer.from(s);
    for (let i = 0; i < b.length; i += 7) yield b.subarray(i, i + 7);
  }
  const collect = async (s) => {
    const out = [];
    for await (const e of parseGatewayEvents(chunks(s), { requestId: "r1" }))
      out.push(e);
    return out;
  };
  assert.deepEqual(await collect(body), events);
  await assert.rejects(
    collect(events.slice(0, 2).map(encode).join("")),
    /MISSING_TERMINAL/,
  );
  await assert.rejects(collect(body + encode(events[2])), /AFTER_TERMINAL/);
  await assert.rejects(
    collect(encode(events[0]) + encode({ ...events[1], sequence: 9 })),
    /EVENT_ORDER/,
  );
  await assert.rejects(
    collect(
      encode(events[0]) + encode({ ...events[1], publisher_generation: 2 }),
    ),
    /GENERATION_CHANGED/,
  );
  await assert.rejects(
    collect(encode({ ...events[0], request_id: "other" })),
    /REQUEST_MISMATCH/,
  );
  await assert.rejects(
    collect("data: " + "x".repeat(70000)),
    /EVENT_TOO_LARGE/,
  );
});

test("HTTP owner token handling, pinned paths, cancel, no redirect or POST retry", async (t) => {
  let posts = 0;
  const seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push({
      method: req.method,
      url: req.url,
      session: req.headers["x-mycelium-session"],
    });
    if (req.headers.authorization !== "Bearer conformance-only") {
      res.writeHead(401);
      res.end("{}");
      return;
    }
    if (req.method === "POST") {
      posts++;
      res.writeHead(202, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          request_id: "r1",
          stream_path: "/v1/inference/r1/events",
          cancel_path: "/v1/inference/r1",
          session_token: "local-conformance-owner-token-00000",
        }),
      );
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ request_id: "r1", status: "cancelling" }));
      return;
    }
    res.writeHead(302, { location: "http://127.0.0.1:1/private" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const client = createGatewayTransport({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    bearerToken: "conformance-only",
    timeoutMs: 500,
  });
  const session = await client.submit({
    protocol: "mycelium.request_gateway.v1",
  });
  assert.equal(session.requestId, "r1");
  assert.equal(JSON.stringify(session).includes("owner-token"), false);
  assert.equal(await session.cancel(), "cancelling");
  assert.equal(seen.at(-1).session, "local-conformance-owner-token-00000");
  await assert.rejects(client.qualification(), /HTTP_302/);
  assert.equal(posts, 1);
  assert.throws(
    () =>
      createGatewayTransport({
        baseUrl: "http://example.com",
        bearerToken: "x",
      }),
    /INSECURE_GATEWAY/,
  );
});
