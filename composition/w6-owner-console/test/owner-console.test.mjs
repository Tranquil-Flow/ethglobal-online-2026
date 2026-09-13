import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCapabilityPanel,
  collectServiceHealth,
  collectNativeRoute,
  collectTimeline,
  collectVerifierStatus,
  collectStakes,
  collectGraphFreshness,
  collectSponsorBalance,
  collectRecentErrors,
} from "../src/data.mjs";
import {
  assertLoopbackHost,
  redactSensitive,
  createFeedbackStore,
} from "../src/safety.mjs";
import { startOwnerConsole } from "../src/server.mjs";

const available = (value) => ({ available: true, value });
const unavailable = (reason) => ({ available: false, reason });

test("panel 1: capability matrix has every build-goal flag, reason, and evidence link", () => {
  const panel = buildCapabilityPanel({
    ownerConsoleServing: true,
    service: { paidHealthy: true },
    native: { routeReady: false },
    graph: { policyReady: false },
    env: { W6_DEMO_SPONSOR_ENABLED: "1", W6_DEMO_SPONSOR_ACCOUNT: "0.0.7" },
  });
  assert.equal(panel.id, "capabilities");
  assert.equal(panel.data.rows.length, 15);
  assert(panel.data.rows.every((row) => typeof row.reason === "string" && row.reason));
  assert(panel.data.rows.every((row) => row.evidence?.href?.startsWith("/console#")));
  assert.equal(panel.data.rows.find((row) => row.id === "owner-console").enabled, true);
  assert.equal(panel.data.rows.find((row) => row.id === "staking").enabled, false);
});

test("panel 2: service health reports launchd, three exact health probes, tunnel count, monitor", async () => {
  const panel = await collectServiceHealth({
    command: async (name) => name === "launchctl"
      ? available("7\t0\tnow.mycelium.edge\n8\t0\tnow.other")
      : available('{"conns":[{},{}]}'),
    probeHttp: async (port) => available({ status: port === 4351 ? 403 : 200, body: port === 4351 ? "ORIGIN_DENIED" : '{"status":"ok"}' }),
    readJson: async () => available({ version: 1, history: [{ checkedAt: "2026-09-13T00:00:00Z", ok: true }] }),
  });
  assert.equal(panel.id, "service-health");
  assert.deepEqual(panel.data.health.map((x) => x.port), [4350, 4351, 4352, 8791]);
  assert.equal(panel.data.launchd.length, 1);
  assert.equal(panel.data.tunnelConnectors, 2);
  assert.equal(panel.data.lastMonitorRun.checkedAt, "2026-09-13T00:00:00Z");
});

test("panel 3: native qualification exposes metadata and PQ states but never identity bytes", async () => {
  const panel = await collectNativeRoute({
    fileMeta: async () => available({ present: true, mode: "0600", size: 32 }),
    tcpProbe: async () => available({ alive: true }),
    qualification: async () => available({ route_ready: true, evidence_class: "physical_qualification", binding: { model_id: "safe-model" }, bearer: "must-not-leak" }),
    pqStatus: async (id) => unavailable(`${id} not run`),
  });
  assert.equal(panel.id, "native-route");
  assert.equal(panel.data.route.routeReady, true);
  assert.equal(panel.data.identity.size, 32);
  assert.equal(JSON.stringify(panel).includes("must-not-leak"), false);
  assert.deepEqual(Object.keys(panel.data.parity), ["PQ1", "PQ2", "PQ3"]);
});

test("panel 4: request timeline preserves required ordered stages without private prompt/output", async () => {
  const panel = await collectTimeline({
    timelineSources: async () => available({
      quotes: [{ quoteId: "q1", providerId: "p", profileId: "prof", amountBaseUnits: "1", createdAt: "t" }],
      payments: [{ paymentId: "pay1", quoteId: "q1", transactionId: "0.0.1@1.2", status: "settled" }],
      jobs: [{ jobId: "j1", quoteId: "q1", paymentId: "pay1", executionStatus: "succeeded", tokenIdsPresent: true, tokenIdCount: 3 }],
      observations: [{ requestId: "j1", randomSelected: true, auditIds: ["a1"] }],
      escrow: [], scores: [], audits: [],
    }),
  });
  const row = panel.data.requests[0];
  assert.deepEqual(row.timeline.map((x) => x.id), ["quote", "payment", "escrow", "stream", "token-ids", "observation", "score", "audit", "settlement"]);
  assert.equal(row.timeline.find((x) => x.id === "escrow").state, "unavailable");
  assert.equal(JSON.stringify(panel).includes("prompt"), false);
  assert.equal(JSON.stringify(panel).includes("output"), false);
});

test("panel 5: verifier status distinguishes local from TEE and unavailable fields", async () => {
  const panel = await collectVerifierStatus({
    env: { W6_VERIFIER_LOCAL_CMD: "/safe/local" },
    readProfiles: async () => available({ version: 1, profiles: [{ id: "p", audits: { referenceSamples: true, ensembleScorer: false }, verifierProfileSha256: null, pinReason: "awaiting pin" }] }),
    readObservationSummary: async () => available({ completed: 2, pending: 0 }),
    attestation: async () => unavailable("TEE not configured"),
    qualification: async () => available({ route_ready: true, evidence_class: "physical_qualification", binding: { model_id: "safe-model", resolved_commit: "abc123", qualification_digest: "sha256:q" }, reason_codes: [] }),
    readAttestationVerification: async () => unavailable("not recorded"),
  });
  assert.equal(panel.data.mode, "local");
  assert.equal(panel.data.qualification.qualificationDigest, "sha256:q");
  assert.equal(panel.data.attestation.state, "unavailable");
  assert.equal(panel.data.attestationImageDigestMatch.state, "unavailable");
  assert.equal(panel.data.auditProbability.state, "unavailable");
});

test("panel 6: stakes are explicitly unavailable until G1 endpoint lands", async () => {
  const panel = await collectStakes({ env: {}, queryLedger: async () => assert.fail("must not query") });
  assert.equal(panel.id, "stakes");
  assert.equal(panel.status, "unavailable");
  assert.match(panel.reason, /G1/);
});

test("panel 7: graph freshness computes lag and 12-confirmation safe block", async () => {
  const panel = await collectGraphFreshness({
    graphMeta: async () => available({ indexedBlock: 988, hasIndexingErrors: false }),
    chainHead: async () => available(1000),
  });
  assert.equal(panel.data.lagBlocks, 12);
  assert.equal(panel.data.requiredConfirmations, 12);
  assert.equal(panel.data.safeBlock, 988);
  assert.equal(panel.data.safeBlockIndexed, true);
});

test("panel 8: sponsor balance uses mirror result and no credential fields", async () => {
  const panel = await collectSponsorBalance({
    env: { W6_DEMO_SPONSOR_ACCOUNT: "0.0.123" },
    mirrorAccount: async () => available({ balance: { balance: 123456, timestamp: "1.2" }, key: "private" }),
  });
  assert.equal(panel.data.accountId, "0.0.123");
  assert.equal(panel.data.balanceTinybar, "123456");
  assert.equal(JSON.stringify(panel).includes("private"), false);
});

test("panel 9: recent errors tails real inputs and redacts required secret classes", async () => {
  const secretLine = "bearer abcdef key=xyz secret=q signature=abcd 0x" + "a".repeat(40) + " " + "b".repeat(32);
  const panel = await collectRecentErrors({
    listLogs: async () => available(["/tmp/mycelium-edge.log"]),
    tailLines: async () => available(["normal error", secretLine, "-----BEGIN PRIVATE KEY-----", "payload", "-----END PRIVATE KEY-----"]),
  });
  const text = JSON.stringify(panel);
  assert(text.includes("normal error"));
  assert(text.includes("[REDACTED]"));
  assert.equal(text.includes("abcdef"), false);
  assert.equal(text.includes("BEGIN PRIVATE"), false);
  assert.equal(text.includes("a".repeat(40)), false);
});

test("redaction regex handles standalone values and multiline private-key blocks", () => {
  const input = `x 0x${"a".repeat(40)} ${"b".repeat(64)} bearer token\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nkey=value secret: wow signature=q`;
  const redacted = redactSensitive(input);
  assert.equal(redacted.includes("a".repeat(40)), false);
  assert.equal(redacted.includes("b".repeat(64)), false);
  assert.equal(redacted.includes("abc"), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test("panel 10: feedback append round-trips from JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "ot2-feedback-"));
  const file = join(root, "feedback.jsonl");
  const store = createFeedbackStore(file, { now: () => new Date("2026-09-13T01:02:03Z") });
  const saved = await store.append({ page: "/console", text: "Owner note", screenshotRef: "shot-1.png" });
  assert.equal(saved.ts, "2026-09-13T01:02:03.000Z");
  assert.deepEqual(await store.list(), [saved]);
  assert.equal((await readFile(file, "utf8")).trim(), JSON.stringify(saved));
});

test("feedback redacts accidental secret material before append", async () => {
  const root = await mkdtemp(join(tmpdir(), "ot2-feedback-redact-"));
  const store = createFeedbackStore(join(root, "feedback.jsonl"));
  const saved = await store.append({ page: "/console", text: `key=value 0x${"a".repeat(40)}` });
  assert.equal(saved.text.includes("value"), false);
  assert.match(saved.text, /\[REDACTED\]/);
});

test("loopback binding guard accepts only literal 127.0.0.1", () => {
  assert.equal(assertLoopbackHost("127.0.0.1"), "127.0.0.1");
  for (const host of ["0.0.0.0", "::", "::1", "localhost", "192.168.1.2"]) assert.throws(() => assertLoopbackHost(host), /LOOPBACK_BINDING_REQUIRED/);
});

test("owner console serves HTML and feedback POST then reload GET", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ot2-server-"));
  const feedbackFile = join(root, "feedback.jsonl");
  const app = await startOwnerConsole({ port: 0, host: "127.0.0.1", feedbackFile, collector: async () => ({ generatedAt: "now", panels: [] }) });
  t.after(() => app.close());
  const html = await fetch(`${app.url}/console`).then((r) => { assert.equal(r.status, 200); return r.text(); });
  assert.match(html, /Owner console/);
  assert.match(html, /<script src="\/console\.js" defer><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/console\.css">/);
  assert.match(html, /<h3 id="feedback-title">Feedback<\/h3>/);
  assert.match(html, /data-panel-id="feedback"/);
  const js = await fetch(`${app.url}/console.js`).then((r) => { assert.equal(r.status, 200); return r.text(); });
  assert.match(js, /data-panel-id/);
  await fetch(`${app.url}/console.css`).then((r) => assert.equal(r.status, 200));
  const post = await fetch(`${app.url}/api/feedback`, { method: "POST", headers: { "content-type": "application/json", origin: app.url }, body: JSON.stringify({ page: "/console", text: "round trip" }) });
  assert.equal(post.status, 200);
  const recorded = await post.json();
  assert.deepEqual(recorded, { status: "recorded" });
  const entries = await fetch(`${app.url}/api/feedback`).then((r) => r.json());
  assert.equal(entries.entries.at(-1).text, "round trip");
});

test("owner console refuses non-loopback startup before listen", async () => {
  await assert.rejects(startOwnerConsole({ port: 0, host: "0.0.0.0", feedbackFile: "/tmp/never-written" }), /LOOPBACK_BINDING_REQUIRED/);
});
