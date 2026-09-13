import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createVerifierServer } from "../w6-verifier-serve.mjs";

const execFileAsync = promisify(execFile);
const BEARER = "synthetic-test-bearer";
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const FAKE_WORKER = resolve("composition/test/fixtures/w6-fake-verifier-worker.py");
let temporaryDirectory;
let tlsKey;
let tlsCertificate;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "w6-verifier-serve-"));
  const privateKeyPath = join(temporaryDirectory, "tls-key.pem");
  const certificatePath = join(temporaryDirectory, "tls-cert.pem");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
  await execFileAsync("openssl", [
    "req",
    "-new",
    "-x509",
    "-key",
    privateKeyPath,
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-days",
    "1",
    "-out",
    certificatePath,
  ]);
  tlsKey = await readFile(privateKeyPath);
  tlsCertificate = await readFile(certificatePath);
});

after(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function withServer(run, options = {}) {
  const service = createVerifierServer({
    tlsKey,
    tlsCertificate,
    bearer: BEARER,
    workerCommand: [process.env.PYTHON ?? "python3", "-I", "-B", FAKE_WORKER],
    workerTimeoutMs: 1_000,
    ...options,
  });
  const address = await service.listen({ host: "127.0.0.1", port: 0 });
  try {
    return await run({ service, port: address.port });
  } finally {
    await service.close();
  }
}

function request(port, { method = "GET", path = "/", bearer, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = { accept: "application/json" };
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const outgoing = https.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            bytes,
            json: bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined,
          });
        });
      },
    );
    outgoing.setTimeout(2_000, () => outgoing.destroy(new Error("request timeout")));
    outgoing.on("error", rejectPromise);
    outgoing.end(body);
  });
}

function post(port, frame, bearer = BEARER) {
  return request(port, {
    method: "POST",
    path: "/v1/stdio",
    bearer,
    body: JSON.stringify(frame),
  });
}

test("GET /healthz reports the wire version without starting a worker", async () => {
  await withServer(async ({ port }) => {
    const response = await request(port, { path: "/healthz" });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^application\/json\b/);
    assert.deepEqual(response.json, { ok: true, version: 1 });
  });
});

test("POST /v1/stdio rejects missing and wrong bearers", async () => {
  await withServer(async ({ port }) => {
    const frame = JSON.stringify({ version: 1, op: "audits" });
    assert.equal((await request(port, { method: "POST", path: "/v1/stdio", body: frame })).status, 401);
    assert.equal((await post(port, { version: 1, op: "audits" }, "wrong")).status, 401);
  });
});

test("bearer authentication uses Node's constant-time primitive", async () => {
  const source = await readFile(resolve("composition/w6-verifier-serve.mjs"), "utf8");
  assert.match(source, /\btimingSafeEqual\s*\(/);
});

test("valid observe request round-trips through the long-lived worker", async () => {
  await withServer(async ({ port }) => {
    const responsePayload = {
      version: 1,
      kind: "ordinary",
      request_id: "synthetic-request",
    };
    const response = await post(port, {
      version: 1,
      op: "observe",
      response: responsePayload,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "application/json");
    assert.deepEqual(response.json, {
      version: 1,
      ok: true,
      result: { op: "observe", sequence: 1, response: responsePayload },
    });
    assert.equal(
      response.bytes.toString("utf8"),
      JSON.stringify(response.json),
      "the worker JSON is returned byte-for-byte without its JSONL newline",
    );
  });
});

test("POST /v1/stdio rejects a frame that exceeds the worker's 2 MiB limit", async () => {
  await withServer(async ({ port }) => {
    const oversized = JSON.stringify({ version: 1, op: "audits", padding: "x".repeat(MAX_FRAME_BYTES) });
    const response = await request(port, {
      method: "POST",
      path: "/v1/stdio",
      bearer: BEARER,
      body: oversized,
    });
    assert.equal(response.status, 413);
  });
});

test("a worker crash fails one request with 503 and respawns on the next request", async () => {
  await withServer(async ({ port }) => {
    assert.equal((await post(port, { version: 1, op: "crash" })).status, 503);
    const recovered = await post(port, { version: 1, op: "audits" });
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.json.result, { op: "audits", sequence: 1 });
  });
});

test("a worker timeout is bounded and the next request gets a fresh worker", async () => {
  await withServer(
    async ({ port }) => {
      assert.equal(
        (await post(port, { version: 1, op: "probe", delay_ms: 500 })).status,
        504,
      );
      const recovered = await post(port, { version: 1, op: "audits" });
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.json.result, { op: "audits", sequence: 1 });
    },
    { workerTimeoutMs: 150 },
  );
});

test("concurrent posts are serialized without crossing worker replies", async () => {
  await withServer(async ({ port }) => {
    const first = post(port, { version: 1, op: "probe", marker: "first", delay_ms: 100 });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    const second = post(port, { version: 1, op: "probe", marker: "second" });
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual(one.json.result, { op: "probe", sequence: 1, marker: "first" });
    assert.deepEqual(two.json.result, { op: "probe", sequence: 2, marker: "second" });
  });
});

test("GET /attestation is explicit when the launcher proxy is not configured", async () => {
  await withServer(async ({ port }) => {
    const response = await request(port, { path: "/attestation?nonce=synthetic" });
    assert.equal(response.status, 501);
    assert.deepEqual(response.json, { ok: false, reason: "attestation-not-configured" });
  });
});

test("GET /attestation proxies the configured launcher endpoint and nonce", async () => {
  const upstream = http.createServer((incoming, outgoing) => {
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ token: "synthetic", url: incoming.url }));
  });
  await new Promise((resolvePromise) => upstream.listen(0, "127.0.0.1", resolvePromise));
  const upstreamAddress = upstream.address();
  try {
    await withServer(
      async ({ port }) => {
        const response = await request(port, { path: "/attestation?nonce=abc123" });
        assert.equal(response.status, 200);
        assert.deepEqual(response.json, {
          token: "synthetic",
          url: "/token?audience=w6&nonce=abc123",
        });
      },
      {
        attestationUrl: `http://127.0.0.1:${upstreamAddress.port}/token?audience=w6`,
      },
    );
  } finally {
    await new Promise((resolvePromise) => upstream.close(resolvePromise));
  }
});

test("the listener requires TLS and rejects cleartext HTTP", async () => {
  await withServer(async ({ port }) => {
    await assert.rejects(
      new Promise((resolvePromise, rejectPromise) => {
        const outgoing = http.get({ host: "127.0.0.1", port, path: "/healthz" }, resolvePromise);
        outgoing.setTimeout(1_000, () => outgoing.destroy(new Error("cleartext request timeout")));
        outgoing.on("error", rejectPromise);
      }),
    );
  });
});
