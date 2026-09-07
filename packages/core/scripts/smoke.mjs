import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { digestOf } from "../../contracts/index.mjs";
import { verifyEvidence, createStore } from "../src/index.mjs";
const dir = mkdtempSync(join(tmpdir(), "core-process-smoke-"));
const children = new Set();
async function start() {
  const child = spawn(
    process.execPath,
    [
      new URL("../src/cli.mjs", import.meta.url).pathname,
      "--development",
      "--data-dir",
      dir,
      "--port",
      "0",
      "--delay-ms",
      "30",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  const exited = new Promise((r) =>
    child.once("exit", (code, signal) => {
      children.delete(child);
      r({ code, signal });
    }),
  );
  child.exited = exited;
  let text = "",
    stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Process startup timeout")),
      10000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Process startup failed: " + stderr));
    });
    child.stdout.on("data", (b) => {
      text += b;
      if (text.includes("\n")) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(text.split("\n")[0]));
        } catch {
          reject(Error("Invalid startup metadata"));
        }
      }
    });
  });
  return { child, ...info };
}
async function stop(child, signal = "SIGTERM") {
  child.kill(signal);
  await child.exited;
}
async function call(
  service,
  path,
  { method = "GET", body, cap, key, headers = {} } = {},
) {
  const r = await fetch(service.url + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cap ? { authorization: ["Bearer", cap].join(" ") } : {}),
      ...(key ? { "idempotency-key": key } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}
async function done(s, id, cap) {
  for (let i = 0; i < 200; i++) {
    const r = await call(s, "/v1/jobs/" + id, { cap });
    if (["failed", "cancelled", "succeeded"].includes(r.body?.executionStatus))
      return r.body;
    await delay(20);
  }
  throw Error("Job did not finish");
}
try {
  let s = await start();
  assert.equal((await call(s, "/healthz")).body.mode, "development");
  const cap = (await call(s, "/v1/sessions", { method: "POST", body: {} })).body
    .capability;
  const request = {
    version: "1",
    nonce: "1".repeat(64),
    providerId: "development.invalid",
    profileId: s.profileId,
    prompt: "SYNTHETIC PROCESS",
    maxOutputTokens: 32,
    seed: 0,
    sampling: "greedy",
    publishConsent: false,
  };
  const quote = (
    await call(s, "/v1/quotes", { method: "POST", body: { request }, cap })
  ).body;
  const body = { request, quoteId: quote.quoteId };
  const replies = await Promise.all(
    Array.from({ length: 6 }, () =>
      call(s, "/v1/jobs", { method: "POST", body, cap, key: "durable-retry" }),
    ),
  );
  assert.ok(replies.every((r) => r.status === 202));
  assert.equal(new Set(replies.map((r) => r.body.job.jobId)).size, 1);
  const id = replies[0].body.job.jobId,
    jobcap = replies[0].body.capability;
  const controller = new AbortController();
  const stream = await fetch(s.url + "/v1/jobs/" + id + "/events", {
    headers: { authorization: ["Bearer", jobcap].join(" ") },
    signal: controller.signal,
  });
  const first = new TextDecoder().decode(
    (await stream.body.getReader().read()).value,
  );
  const cursor = Number(first.match(/id: (\d+)/)[1]);
  controller.abort();
  const job = await done(s, id, cap);
  assert.equal(job.executionStatus, "succeeded");
  const replay = await fetch(s.url + "/v1/jobs/" + id + "/events", {
    headers: {
      authorization: ["Bearer", jobcap].join(" "),
      "last-event-id": String(cursor),
    },
  });
  const events = await replay.text();
  assert.ok(events.includes("event: done"));
  assert.ok(events.includes("event: delta"));
  assert.ok(
    events.lastIndexOf("event: job") < events.lastIndexOf("event: done"),
  );
  const bundle = (
    await call(s, "/v1/jobs/" + id + "/evidence", { cap: jobcap })
  ).body;
  const publicKey = (await call(s, "/v1/keys/" + encodeURIComponent(s.keyId)))
    .body;
  assert.equal(
    verifyEvidence(bundle, {
      trustedKeys: { [s.keyId]: publicKey.publicKeyJwk },
    }),
    true,
  );
  const receiptDigest = digestOf(bundle.receipt);
  await stop(s.child);
  s = await start();
  assert.equal(s.keyId, publicKey.keyId);
  assert.equal(
    digestOf(
      (await call(s, "/v1/jobs/" + id + "/receipt", { cap: jobcap })).body,
    ),
    receiptDigest,
  );
  const retry = await call(s, "/v1/jobs", {
    method: "POST",
    body,
    cap,
    key: "durable-retry",
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.job.jobId, id);
  const request2 = {
    ...request,
    nonce: "2".repeat(64),
    prompt: "X".repeat(100),
    maxOutputTokens: 100,
  };
  const q2 = (
    await call(s, "/v1/quotes", {
      method: "POST",
      body: { request: request2 },
      cap,
    })
  ).body;
  const b2 = { request: request2, quoteId: q2.quoteId };
  const pending = await call(s, "/v1/jobs", {
    method: "POST",
    body: b2,
    cap,
    key: "crash",
  });
  const orphanId = pending.body.job.jobId;
  for (let i = 0; i < 100; i++) {
    if (
      (await call(s, "/v1/jobs/" + orphanId, { cap })).body.executionStatus ===
      "running"
    )
      break;
    await delay(10);
  }
  await stop(s.child, "SIGKILL");
  s = await start();
  const failed = await done(s, orphanId, cap);
  assert.equal(failed.executionStatus, "failed");
  assert.equal(failed.failureCode, "ORPHANED_EXECUTION");
  assert.equal(failed.payment.status, "paid_but_failed");
  assert.equal(
    (await call(s, "/v1/jobs/" + orphanId + "/receipt", { cap })).status,
    409,
  );
  const noRepeat = await call(s, "/v1/jobs", {
    method: "POST",
    body: b2,
    cap,
    key: "crash",
  });
  assert.equal(noRepeat.body.job.jobId, orphanId);
  assert.equal(noRepeat.body.job.executionStatus, "failed");
  const third = { ...request2, nonce: "3".repeat(64) };
  const q3 = (
    await call(s, "/v1/quotes", {
      method: "POST",
      body: { request: third },
      cap,
    })
  ).body;
  const j3 = await call(s, "/v1/jobs", {
    method: "POST",
    body: { request: third, quoteId: q3.quoteId },
    cap,
    key: "cancel",
  });
  assert.equal(
    (
      await call(s, "/v1/jobs/" + j3.body.job.jobId + "/cancel", {
        method: "POST",
        body: {},
        cap,
      })
    ).body.executionStatus,
    "cancelled",
  );
  const assessment = await call(s, "/v1/jobs/" + id + "/assessments", {
    method: "POST",
    body: { method: "replay-v1" },
    cap,
    key: "assessment",
  });
  assert.equal(assessment.body.outcome, "unavailable");
  assert.equal(
    (await call(s, "/v1/jobs/" + id + "/evidence", { method: "DELETE", cap }))
      .status,
    204,
  );
  assert.equal(
    (await call(s, "/v1/jobs/" + id + "/evidence", { cap })).status,
    404,
  );
  await delay(150);
  await stop(s.child);
  const db = createStore({ path: join(dir, "core.sqlite") });
  assert.equal(db.list("jobs").length, 3);
  assert.equal(db.list("outcomes").length, 0);
  assert.equal(db.get("private", id), undefined);
  assert.ok(!JSON.stringify(db.list("sessions")).includes(cap));
  db.close();
  assert.equal(statSync(join(dir, "core.sqlite")).mode & 0o777, 0o600);
  console.log(
    JSON.stringify({
      result: "passed",
      mode: "development",
      processStarts: 3,
      cases: [
        "raw HTTP + durable SQLite",
        "six concurrent retries -> one job",
        "SSE disconnect/reconnect",
        "Ed25519 pinned-key export verification",
        "graceful restart retains receipt/key/capability",
        "SIGKILL orphan recovery without repayment",
        "explicit cancellation",
        "unavailable verifier",
        "private evidence deletion",
        "hashed sessions + 0600 SQLite",
      ],
      livePayment: false,
      inference: false,
    }),
  );
} finally {
  for (const child of children) {
    child.kill("SIGKILL");
    await child.exited;
  }
  rmSync(dir, { recursive: true, force: true });
}
