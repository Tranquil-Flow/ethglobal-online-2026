import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createVerifierBridge,
  VerifierBridgeError,
} from "../w6-verifier-bridge.mjs";
import {
  assertProfileAvailableBeforeQuote,
  getProfileCapability,
  loadProfileCapabilities,
} from "../w6-profile-capabilities.mjs";

const PROFILE = "a".repeat(64);
const APP_PROFILE = "sha256:" + "b".repeat(64);
const UNKNOWN_PROFILE = "sha256:" + "c".repeat(64);
const SEED = "d".repeat(64);
const SYNTHETIC_RESPONSE = "SYNTHETIC_TRANSIENT_RESPONSE_DO_NOT_PERSIST";
const wheelPython = resolve("artifacts/w6-v2/verifier-env/venv/bin/python");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function makeFixture({ scorerOutage = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "w6-verifier-"));
  const privateDir = join(root, "private");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const bank = {
    version: 1,
    profile_sha256: PROFILE,
    qualification: {
      status: "qualified_local",
      evidence_sha256: "e".repeat(64),
    },
    samples: [
      {
        sample_id: "synthetic-sample",
        prompt_token_ids: [42, 43],
        seed: SEED,
        max_output_tokens: 4,
        eos_token_ids: [2],
        expected_output_token_ids: [101, 2],
        stop_reason: "eos",
      },
    ],
  };
  const bankBytes = Buffer.from(JSON.stringify(canonical(bank)));
  const bankPath = join(privateDir, "synthetic-bank.json");
  await writeFile(bankPath, bankBytes, { mode: 0o600 });

  const providerCapture = join(privateDir, "provider-request.json");
  const providerPath = join(privateDir, "synthetic-provider.py");
  await writeFile(
    providerPath,
    [
      "import json, pathlib, sys",
      "request = json.load(sys.stdin)",
      "pathlib.Path(sys.argv[1]).write_text(json.dumps(request, sort_keys=True))",
      "allowed = ('version', 'audit_id', 'provider_id', 'profile_sha256', 'seed')",
      "result = {key: request[key] for key in allowed}",
      "result.update(output_token_ids=[101, 2], stop_reason='eos')",
      "print(json.dumps(result, sort_keys=True))",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(providerPath, 0o700);

  const config = {
    version: 1,
    reference_bank_path: bankPath,
    reference_bank_sha256: sha256(bankBytes),
    profile_sha256: PROFILE,
    state_path: join(privateDir, "verifier.sqlite3"),
    policy: { audit_every_x: 1, negative_streak: 0, max_pending: 8 },
    provider_command: [wheelPython, "-I", providerPath, providerCapture],
    provider_timeout_s: 5,
  };
  if (!scorerOutage) {
    // The synthetic fixture intentionally has no classifier bundle. The test
    // suite never reads the sealed reference bank or invokes any model.
  }
  const configPath = join(privateDir, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const profiles = {
    version: 1,
    profiles: [
      {
        id: "synthetic-0.5b",
        appProfileDigest: APP_PROFILE,
        verifierProfileSha256: PROFILE,
        pinReason:
          "Synthetic profile is fully pinned for this local test only.",
        contract: {
          model: "synthetic/token-fixture",
          revision: "synthetic",
          runtimeDtype: "float32",
          quantization: "int8-weight-only",
          selector: "quantized_greedy_token_id",
          seed: 0,
          maxOutputTokens: 64,
        },
        audits: { referenceSamples: true, ensembleScorer: false },
      },
    ],
  };
  const profilesPath = join(privateDir, "profiles.json");
  await writeFile(profilesPath, JSON.stringify(profiles), { mode: 0o600 });

  const bridgeState = join(privateDir, "bridge-state");
  const bridge = createVerifierBridge({
    localCommand: [
      wheelPython,
      "-I",
      "-B",
      "-m",
      "mycelium_verifier",
      "stdio",
      "--config",
      configPath,
    ],
    profilesFile: profilesPath,
    stateDir: bridgeState,
    timeoutMs: 5_000,
  });
  await bridge.start();
  return { bridge, bridgeState, privateDir, providerCapture, profilesPath };
}

function ordinary(overrides = {}) {
  return {
    requestId: "ordinary-request-1",
    providerId: "synthetic-provider",
    appProfileDigest: APP_PROFILE,
    responseText: SYNTHETIC_RESPONSE,
    kind: "ordinary",
    ...overrides,
  };
}

test("real sealed-wheel subprocess: observe -> scores -> audit with synthetic tokens", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.bridge.close());

  const receipt = await fixture.bridge.observeCompleted(ordinary());
  assert.equal(receipt.version, 1);
  assert.equal(receipt.random_selected, true);
  assert.equal(receipt.audit_ids.length, 1);

  const scores = await fixture.bridge.processScores();
  assert.equal(scores.length, 1);
  assert.match(JSON.stringify(scores), /scorer_unavailable/);

  const outcomes = await fixture.bridge.runPending();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].status, "match");
  assert.notEqual(outcomes[0].audit_id, outcomes[0].trigger_request_id);

  const audit = await fixture.bridge.getAudit(outcomes[0].audit_id);
  assert.equal(audit.outcome.status, "match");
  const sentToProvider = JSON.parse(
    await readFile(fixture.providerCapture, "utf8"),
  );
  assert.deepEqual(Object.keys(sentToProvider).sort(), [
    "audit_id",
    "eos_token_ids",
    "max_output_tokens",
    "profile_sha256",
    "prompt_token_ids",
    "provider_id",
    "sample_id",
    "seed",
    "trigger_request_id",
    "version",
  ]);
  assert.equal("expected_output_token_ids" in sentToProvider, false);
  assert.equal("expected_answer" in sentToProvider, false);
  assert.equal("response_text" in sentToProvider, false);
});

test("identical observe is idempotent; conflicting duplicate is rejected", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.bridge.close());

  const first = await fixture.bridge.observeCompleted(ordinary());
  const duplicate = await fixture.bridge.observeCompleted(ordinary());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.observation_id, first.observation_id);
  assert.deepEqual(duplicate.audit_ids, first.audit_ids);
  const audits = await fixture.bridge.listAudits();
  assert.equal(audits.length, 1);

  await assert.rejects(
    fixture.bridge.observeCompleted(
      ordinary({ responseText: "SYNTHETIC_CONFLICTING_RESPONSE" }),
    ),
    (error) =>
      error instanceof VerifierBridgeError &&
      error.code === "OBSERVATION_CONFLICT",
  );
  assert.equal((await fixture.bridge.listAudits()).length, 1);
});

test("scorer outage leaves durable random-baseline audit runnable", async (t) => {
  const fixture = await makeFixture({ scorerOutage: true });
  t.after(() => fixture.bridge.close());

  const ticket = fixture.bridge.enqueueCompletedJob({
    executionStatus: "succeeded",
    requestId: "ordinary-request-outage",
    providerId: "synthetic-provider",
    profileId: APP_PROFILE,
    requestKind: "ordinary",
    output: { text: "SYNTHETIC_SCORER_OUTAGE_RESPONSE" },
  });
  assert.equal(ticket.enqueued, true);
  assert.equal(
    typeof ticket.then,
    "undefined",
    "enqueue must not block delivery",
  );
  const receipt = await ticket.completion;
  assert.equal(receipt.random_selected, true);

  const scores = await fixture.bridge.processScores();
  assert.match(JSON.stringify(scores), /scorer_unavailable/);
  const outcomes = await fixture.bridge.runPending();
  assert.equal(outcomes[0].status, "match");

  const files = await readdir(fixture.bridgeState);
  const persisted = Buffer.concat(
    await Promise.all(
      files.map((file) => readFile(join(fixture.bridgeState, file))),
    ),
  ).toString("utf8");
  assert.doesNotMatch(persisted, /SYNTHETIC_SCORER_OUTAGE_RESPONSE/);
  assert.match(persisted, /ordinary-request-outage/);
});

test("audit observations cannot recursively trigger audits", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.bridge.close());

  assert.throws(
    () =>
      fixture.bridge.enqueueCompletedJob({
        executionStatus: "succeeded",
        requestId: "aud-recursive",
        providerId: "synthetic-provider",
        profileId: APP_PROFILE,
        requestKind: "audit",
        auditId: "aud-parent",
        output: { text: "SYNTHETIC_AUDIT_OUTPUT" },
      }),
    (error) =>
      error instanceof VerifierBridgeError &&
      error.code === "AUDIT_RECURSION_REFUSED",
  );
  assert.equal((await fixture.bridge.listAudits()).length, 0);
});

test("bridge has no signing, payment, or authorization authority", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fixture.bridge.close());
  const authorityNames = Object.keys(fixture.bridge).filter((name) =>
    /sign|pay|authoriz/i.test(name),
  );
  assert.deepEqual(authorityNames, []);
  assert.equal(Object.isFrozen(fixture.bridge), true);
});

test("unsupported and unpinned profiles refuse before quote", async () => {
  const profilesFile = resolve("composition/w6-verifier-profiles.json");
  const map = await loadProfileCapabilities(profilesFile);
  let quoteCalls = 0;
  assert.throws(
    () => {
      assertProfileAvailableBeforeQuote(UNKNOWN_PROFILE, map, {
        verifierMode: "tee-attested",
      });
      quoteCalls += 1;
    },
    (error) => error.code === "VERIFIER_PROFILE_UNAVAILABLE",
  );
  assert.equal(quoteCalls, 0);

  const hosted = map.profiles.find((row) => row.id === "hosted-qwen2.5-0.5b");
  assert.ok(hosted);
  assert.deepEqual(hosted.audits, {
    referenceSamples: true,
    ensembleScorer: false,
  });
  assert.equal(
    getProfileCapability(hosted.appProfileDigest, map, {
      verifierMode: "local",
    }).ensembleScorer,
    "not-applicable",
  );
});

async function makeWireHarness(code, timeoutMs = 500) {
  const root = await mkdtemp(join(tmpdir(), "w6-verifier-wire-"));
  const profilesPath = join(root, "profiles.json");
  await writeFile(
    profilesPath,
    JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "synthetic-wire",
          appProfileDigest: APP_PROFILE,
          verifierProfileSha256: PROFILE,
          pinReason: "Synthetic wire test pin.",
          contract: { model: "synthetic/wire" },
          audits: { referenceSamples: true, ensembleScorer: false },
        },
      ],
    }),
  );
  const bridge = createVerifierBridge({
    localCommand: [wheelPython, "-I", "-c", code],
    profilesFile: profilesPath,
    stateDir: join(root, "state"),
    timeoutMs,
  });
  return { bridge, profilesPath, root };
}

test("version handshake rejects a non-v1 JSONL worker", async (t) => {
  const harness = await makeWireHarness(
    "import json,sys\nfor line in sys.stdin:\n print(json.dumps({'version':2,'ok':True,'result':[]}));sys.stdout.flush()",
  );
  t.after(() => harness.bridge.close());
  await assert.rejects(
    harness.bridge.start(),
    (error) => error.code === "VERIFIER_VERSION_MISMATCH",
  );
});

test("local JSONL requests have a bounded timeout", async (t) => {
  const harness = await makeWireHarness(
    "import sys,time\nsys.stdin.readline();time.sleep(5)",
    50,
  );
  t.after(() => harness.bridge.close());
  await assert.rejects(
    harness.bridge.start(),
    (error) => error.code === "VERIFIER_TIMEOUT",
  );
});

test("TEE transport sends authenticated v1 frames without payment material", async () => {
  const root = await mkdtemp(join(tmpdir(), "w6-verifier-tee-"));
  const profilesPath = join(root, "profiles.json");
  await writeFile(
    profilesPath,
    JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "synthetic-tee",
          appProfileDigest: APP_PROFILE,
          verifierProfileSha256: PROFILE,
          pinReason: "Synthetic TEE client test pin.",
          contract: { model: "synthetic/tee" },
          audits: { referenceSamples: true, ensembleScorer: false },
        },
      ],
    }),
  );
  const calls = [];
  const bridge = createVerifierBridge({
    teeUrl: "https://verifier.example/base/",
    teeBearer: "synthetic-bearer",
    profilesFile: profilesPath,
    stateDir: join(root, "state"),
    timeoutMs: 500,
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        authorization: init.headers.authorization,
        body: JSON.parse(Buffer.from(init.body).toString("utf8")),
      });
      return new Response(
        JSON.stringify({ version: 1, ok: true, result: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await bridge.start();
  await bridge.listAudits();
  await bridge.close();
  assert.equal(bridge.mode, "tee-attested");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://verifier.example/base/v1/stdio");
  assert.equal(calls[0].authorization, "Bearer synthetic-bearer");
  assert.deepEqual(calls[0].body, { version: 1, op: "audits" });
  assert.doesNotMatch(JSON.stringify(calls), /payment|sign|expected_answer/i);
});
