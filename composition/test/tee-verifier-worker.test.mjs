// W6 TEE verifier worker — client-contract integration test.
//
// Proves the worker at composition/tee-verifier-worker/ answers the REAL
// client bridge (composition/w6-verifier-bridge.mjs) field-for-field over real
// HTTPS/TLS:
//
//   * HttpsTransport constraints are satisfied by the worker's TLS listener
//     (https:// origin, no userinfo/query/hash — w6-verifier-bridge.mjs:245-271);
//   * the `audits` start handshake and every reply envelope are accepted by
//     parseReply() (w6-verifier-bridge.mjs:67-91);
//   * the `observe` receipt satisfies the bridge's receipt validation
//     (w6-verifier-bridge.mjs:546-553: echo ids, boolean random_selected,
//     array audit_ids) and additionally carries the ensemble verdict +
//     worker-unattested evidence class;
//   * match / mismatch / inconclusive demonstrations run end-to-end through
//     bridge.observeCompleted / getAudit / listAudits;
//   * raw wire checks: exact envelope keys, fail-closed auth (401), unknown
//     ops, honest /attestation stub (501, no fabricated token).
//
// Run from the workbench root (same convention as the other composition tests):
//   PYTHON=/opt/homebrew/bin/python3.14 \
//     node --test composition/test/tee-verifier-worker.test.mjs
//
// The test binds port 0 on 127.0.0.1, generates a throwaway self-signed cert,
// spawns the worker as its own subprocess and kills exactly that subprocess.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createVerifierBridge,
  VerifierBridgeError,
} from "../w6-verifier-bridge.mjs";

const execFileAsync = promisify(execFile);

const PYTHON = process.env.PYTHON ?? "python3";
const WORKER_SCRIPT = resolve("composition/tee-verifier-worker/tee_verifier_worker.py");
const BANK = resolve("composition/tee-verifier-worker/fixtures/reference-bank.example.json");
const PROFILES = resolve("composition/tee-verifier-worker/fixtures/test-profiles.json");
const BEARER = "synthetic-integration-bearer";
const APP_PROFILE = "sha256:" + "b".repeat(64);
const PROVIDER = "tee-worker-test-provider";
const MATCH_REQUEST = "tee-worker-test-match-1";
const MISMATCH_REQUEST = "tee-worker-test-mismatch-1";
const HONEST_TEXT = "honest answer: 42";
const ATTACKER_TEXT = "demo attacker";

let temporaryDirectory;
let worker;
let port;
let bridge;

async function startWorker(env) {
  const child = spawn(PYTHON, ["-I", "-B", WORKER_SCRIPT, "serve"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  const listening = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error(`worker did not report a listening port; output=${buffer}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolvePromise(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        rejectPromise(new Error(`bad listening line: ${buffer}`));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`worker exited before listening (code ${code})`));
    });
  });
  return { child, listening };
}

// Minimal fetch-compatible TLS client that accepts the test's self-signed
// certificate (same trust posture as composition/test/w6-verifier-serve.test.mjs
// which uses rejectUnauthorized: false for its own loopback server).
function tlsFetch(url, init = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const target = new URL(String(url));
    const outgoing = https.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: init.method ?? "GET",
        headers: init.headers,
        rejectUnauthorized: false,
        signal: init.signal,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolvePromise(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: {
                "content-type": response.headers["content-type"] ?? "application/json",
              },
            }),
          );
        });
      },
    );
    outgoing.on("error", rejectPromise);
    outgoing.end(init.body);
  });
}

function rawRequest(options = {}) {
  const { method = "POST", path = "/v1/stdio", bearer, body, contentType } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = { accept: "application/json" };
    if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
    if (body !== undefined) {
      headers["content-type"] = contentType ?? "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const outgoing = https.request(
      { host: "127.0.0.1", port, method, path, headers, rejectUnauthorized: false },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolvePromise({
            status: response.statusCode,
            bytes,
            json: bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined,
          });
        });
      },
    );
    outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("request timeout")));
    outgoing.on("error", rejectPromise);
    outgoing.end(body);
  });
}

function observeFrame(requestId, responseText) {
  return JSON.stringify({
    op: "observe",
    response: {
      kind: "ordinary",
      profile_sha256: "a".repeat(64),
      provider_id: PROVIDER,
      request_id: requestId,
      response_text: responseText,
      version: 1,
    },
    version: 1,
  });
}

function ordinaryJob(requestId, responseText) {
  return {
    requestId,
    providerId: PROVIDER,
    appProfileDigest: APP_PROFILE,
    responseText,
    kind: "ordinary",
  };
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "w6-tee-verifier-worker-"));
  const privateKeyPath = join(temporaryDirectory, "tls-key.pem");
  const certificatePath = join(temporaryDirectory, "tls-cert.pem");
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
  await execFileAsync("openssl", [
    "req", "-new", "-x509",
    "-key", privateKeyPath,
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
    "-days", "1",
    "-out", certificatePath,
  ]);
  await readFile(certificatePath); // sanity: cert exists and is readable

  const environment = { ...process.env };
  delete environment.PYTHONPATH;
  delete environment.PYTHONHOME;
  delete environment.VIRTUAL_ENV;
  worker = await startWorker({
    ...environment,
    W6_TEE_VERIFIER_HOST: "127.0.0.1",
    W6_TEE_VERIFIER_PORT: "0",
    W6_TEE_VERIFIER_BEARER: BEARER,
    W6_TEE_VERIFIER_TLS_CERT: certificatePath,
    W6_TEE_VERIFIER_TLS_KEY: privateKeyPath,
    W6_TEE_VERIFIER_REFERENCE_BANK: BANK,
  });
  port = worker.listening.port;
  assert.equal(worker.listening.scheme, "https");
  assert.equal(worker.listening.evidenceClass, "worker-unattested");

  bridge = createVerifierBridge({
    teeUrl: `https://127.0.0.1:${port}`,
    teeBearer: BEARER,
    profilesFile: PROFILES,
    stateDir: join(temporaryDirectory, "bridge-state"),
    timeoutMs: 5_000,
    fetchImpl: tlsFetch,
  });
  await bridge.start();
});

after(async () => {
  await bridge?.close();
  if (worker?.child && worker.child.exitCode === null) {
    const exited = new Promise((resolvePromise) => worker.child.once("exit", resolvePromise));
    worker.child.kill("SIGTERM");
    await exited;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("bridge runs in tee-attested mode and the start handshake succeeds", () => {
  assert.equal(bridge.mode, "tee-attested");
});

test("match: real bridge observeCompleted against the worker's statistical test", async () => {
  const receipt = await bridge.observeCompleted(ordinaryJob(MATCH_REQUEST, HONEST_TEXT));
  // Fields the bridge itself validates (w6-verifier-bridge.mjs:546-553):
  assert.equal(receipt.version, 1);
  assert.equal(receipt.request_id, MATCH_REQUEST);
  assert.equal(receipt.provider_id, PROVIDER);
  assert.equal(typeof receipt.random_selected, "boolean");
  assert.equal(receipt.random_selected, true);
  assert.deepEqual(receipt.audit_ids, []);
  // Worker extensions (allowed: the bridge does not exactKey the receipt):
  assert.equal(receipt.verdict, "match");
  assert.equal(receipt.evidenceClass, "worker-unattested");
  assert.equal(receipt.evidence.test, "ensemble-target-vs-rest-binomial-v1");
  assert.equal(receipt.evidence.referenceCount, 3);
  assert.equal(receipt.evidence.agreementCount, 3);
  assert.equal(receipt.evidence.agreement, 1);
  assert.equal(receipt.evidence.p0Rational, "4/5");
  assert.equal(receipt.evidence.pLowerExact, "1/1");
  assert.equal(receipt.evidence.referenceSource, "bank");
  assert.match(receipt.evidence.request_digest, /^[0-9a-f]{64}$/);
  assert.match(receipt.evidence.output_digest, /^[0-9a-f]{64}$/);
});

test("mismatch: attacker output escalates to an audit record the bridge can read", async () => {
  const receipt = await bridge.observeCompleted(ordinaryJob(MISMATCH_REQUEST, ATTACKER_TEXT));
  assert.equal(receipt.verdict, "mismatch");
  assert.equal(receipt.evidence.reason, "target-diverges-from-reference-ensemble");
  assert.equal(receipt.evidence.agreementCount, 0);
  assert.equal(receipt.evidence.pLowerExact, "1/125");
  assert.equal(receipt.audit_ids.length, 1);
  assert.match(receipt.audit_ids[0], /^tee-audit-/);

  const audit = await bridge.getAudit(receipt.audit_ids[0]);
  assert.equal(audit.verdict, "mismatch");
  assert.equal(audit.outcome.status, "mismatch");
  assert.equal(audit.request_id, MISMATCH_REQUEST);
  assert.equal(audit.trigger_request_id, MISMATCH_REQUEST);
  assert.equal(audit.evidenceClass, "worker-unattested");

  const audits = await bridge.listAudits();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].audit_id, receipt.audit_ids[0]);

  const unknown = await bridge.getAudit("tee-audit-does-not-exist");
  assert.equal(unknown, null, "unknown audit ids resolve to null, not fabricated records");
});

test("identical re-observation replays deterministically at the worker", async () => {
  const first = await rawRequest({ bearer: BEARER, body: observeFrame(MATCH_REQUEST, HONEST_TEXT) });
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  const second = await rawRequest({ bearer: BEARER, body: observeFrame(MATCH_REQUEST, HONEST_TEXT) });
  assert.equal(second.status, 200);
  assert.equal(second.json.result.duplicate, true);
  assert.equal(second.json.result.observation_id, first.json.result.observation_id);
  assert.equal(second.json.result.verdict, "match");
});

test("conflicting payload for the same request id is refused", async () => {
  const conflict = await rawRequest({
    bearer: BEARER,
    body: observeFrame(MATCH_REQUEST, "a different output for the same request"),
  });
  assert.equal(conflict.status, 200);
  assert.deepEqual(conflict.json, { version: 1, ok: false, error: "observation-conflict" });
});

test("unreferenced request yields an honest inconclusive receipt (no fabricated evidence)", async () => {
  const response = await rawRequest({
    bearer: BEARER,
    body: observeFrame("tee-worker-test-no-reference-1", HONEST_TEXT),
  });
  assert.equal(response.status, 200);
  const result = response.json.result;
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.evidence.reason, "no-reference-ensemble");
  assert.equal(result.random_selected, false);
  assert.deepEqual(result.audit_ids, []);
  assert.equal(result.evidence.p0, null);
});

test("wire envelope has exactly the three keys parseReply accepts", async () => {
  const response = await rawRequest({ bearer: BEARER, body: '{"op":"audits","version":1}' });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ["ok", "result", "version"]);
  assert.equal(response.json.ok, true);
  assert.ok(Array.isArray(response.json.result));
});

test("unknown ops and mismatched wire versions are rejected inside the envelope", async () => {
  const unknownOp = await rawRequest({ bearer: BEARER, body: '{"op":"frobnicate","version":1}' });
  assert.equal(unknownOp.status, 200);
  assert.deepEqual(unknownOp.json, { version: 1, ok: false, error: "unknown-op" });

  const badVersion = await rawRequest({ bearer: BEARER, body: '{"op":"audits","version":2}' });
  assert.equal(badVersion.status, 200);
  assert.deepEqual(badVersion.json, { version: 1, ok: false, error: "unsupported-version" });
});

test("auth is fail-closed (401) and wrong content types are refused", async () => {
  const noAuth = await rawRequest({ body: '{"op":"audits","version":1}' });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.reason, "unauthorized");

  const wrongBearer = await rawRequest({
    bearer: "not-the-bearer",
    body: '{"op":"audits","version":1}',
  });
  assert.equal(wrongBearer.status, 401);

  const notJson = await rawRequest({
    bearer: BEARER,
    body: "plain text",
    contentType: "text/plain",
  });
  assert.equal(notJson.status, 415);
});

test("healthz and the honest attestation stub", async () => {
  const healthz = await rawRequest({ method: "GET", path: "/healthz", bearer: undefined });
  assert.equal(healthz.status, 200);
  assert.equal(healthz.json.ok, true);
  assert.equal(healthz.json.version, 1);
  assert.equal(healthz.json.evidenceClass, "worker-unattested");
  assert.equal(healthz.json.bank.loaded, true);
  assert.equal(healthz.json.attestation.configured, false);

  const attestation = await rawRequest({ method: "GET", path: "/attestation" });
  assert.equal(attestation.status, 501);
  assert.equal(attestation.json.reason, "attestation-not-configured");
  assert.equal(attestation.json.evidenceClass, "worker-unattested");
  assert.ok(attestation.json.requirements.length >= 3);
  assert.doesNotMatch(attestation.bytes.toString("utf8"), /eyJ/); // no fabricated JWT
});

test("bridge close is clean and leaves no worker process behind", async () => {
  await bridge.close();
  const again = await rawRequest({ bearer: BEARER, body: '{"op":"audits","version":1}' });
  assert.equal(again.status, 200, "HTTP worker keeps serving after a client-side bridge close");
});
