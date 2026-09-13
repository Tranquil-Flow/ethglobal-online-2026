import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digestOf, validate } from "../../packages/contracts/index.mjs";
import {
  DEFAULT_27B_MIN_MEM_BYTES,
  create27BProfile,
  create27BServingPolicy,
  is27BAdmissible,
  parseMacVmStat,
  readMacAvailableMemory,
} from "../w6-provider-27b.mjs";
import {
  build27BWorkerCommand,
  create27BLauncher,
} from "../w6-27b-serve.mjs";

const GiB = 1024 ** 3;
const MODEL_REVISION = "3e6447f082e89cc7f0bc6e5441afd38dfce760ff";

function eventuallyNotRunning(pid) {
  return new Promise((resolvePromise, rejectPromise) => {
    const deadline = Date.now() + 3_000;
    const poll = () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return resolvePromise();
        return rejectPromise(error);
      }
      if (Date.now() >= deadline)
        return rejectPromise(new Error(`child ${pid} remained alive`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function auditRequest(overrides = {}) {
  return {
    version: 1,
    audit_id: "synthetic-audit",
    trigger_request_id: "synthetic-trigger",
    provider_id: "synthetic-provider",
    sample_id: "synthetic-sample",
    profile_sha256: "a".repeat(64),
    prompt_token_ids: [42, 43],
    seed: "b".repeat(64),
    max_output_tokens: 4,
    eos_token_ids: [248044, 248046],
    ...overrides,
  };
}

test("27B profile conforms to the app Profile and pins serving policy", () => {
  const options = {
    runtimeBase: "/synthetic/installed-verifier",
    modelRoot: "/synthetic/qwen38-27b-mlx4-3e6447f",
    port: 0,
    env: { W6_27B_QUEUE_CAP: "7" },
  };
  const profile = create27BProfile(options);
  assert.equal(validate("Profile", profile), true);
  assert.deepEqual(Object.keys(profile).sort(), [
    "artifacts",
    "model",
    "numerics",
    "runtimeRevision",
    "templateDigest",
    "tokenizerDigest",
    "version",
  ]);
  assert.equal(profile.model, "mlx-community/Qwen3.8-27B-4bit");
  assert.match(profile.runtimeRevision, new RegExp(MODEL_REVISION));
  assert.equal(
    profile.tokenizerDigest,
    "sha256:06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523",
  );
  assert.equal(
    profile.templateDigest,
    "sha256:c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041",
  );
  assert.match(profile.numerics.hardwareClass, /single-host.*M4 Pro.*48 GiB/i);
  assert.match(profile.numerics.determinism, /sha256-cdf-f64-v1/);
  assert.match(profile.numerics.determinism, /temperature=0\.7/);
  assert.match(profile.numerics.determinism, /top_k=20/);
  assert.match(profile.numerics.determinism, /top_p=0\.9/);
  assert.match(profile.numerics.determinism, /thinking=false/);

  const verifierProfile = profile.artifacts.find(
    ({ role }) => role === "verifier-27b-profile-v1",
  );
  assert.equal(
    verifierProfile?.digest,
    "sha256:40ede77319ecc67833d8fac597026f3925b45cfa460c4243d090c0a6937abe5f",
  );
  const policy = create27BServingPolicy(options);
  assert.deepEqual(policy, {
    version: "1",
    endpoint: "http://127.0.0.1:0",
    hostLabel: "m4pro-48GiB-single-host",
    concurrency: 1,
    queueCap: 7,
    maxPromptTokens: 512,
    maxOutputTokens: 64,
    loadPolicy: "once-at-launch",
    startupDownloads: false,
    fallbackProfile: null,
    runtimeBase: resolve(options.runtimeBase),
    modelRoot: resolve(options.modelRoot),
  });
  const artifact = profile.artifacts.find(
    ({ role }) => role === "w6-27b-serving-policy-v1",
  );
  assert.ok(artifact);
  assert.equal(artifact.digest, digestOf(policy));
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.numerics), true);
  assert.equal(Object.isFrozen(policy), true);
});

test("27B profile rejects invalid queue, path, and port configuration", () => {
  const base = {
    runtimeBase: "/runtime",
    modelRoot: "/model",
    port: 0,
  };
  assert.throws(
    () => create27BProfile({ ...base, env: { W6_27B_QUEUE_CAP: "0" } }),
    (error) => error.code === "INVALID_27B_PROFILE_OPTIONS",
  );
  assert.throws(
    () => create27BProfile({ ...base, port: 65_536 }),
    (error) => error.code === "INVALID_27B_PROFILE_OPTIONS",
  );
  assert.throws(
    () => create27BProfile({ ...base, modelRoot: "relative/model" }),
    (error) => error.code === "INVALID_27B_PROFILE_OPTIONS",
  );
});

test("M3 admission refuses below threshold and admits at/above it", () => {
  assert.equal(DEFAULT_27B_MIN_MEM_BYTES, 22 * GiB);
  const below = is27BAdmissible({
    memAvailableBytes: DEFAULT_27B_MIN_MEM_BYTES - 1,
    minRequiredBytes: DEFAULT_27B_MIN_MEM_BYTES,
  });
  assert.equal(below.ok, false);
  assert.match(below.reason, /27B/);
  assert.match(below.reason, /available memory/i);

  assert.deepEqual(
    is27BAdmissible({
      memAvailableBytes: DEFAULT_27B_MIN_MEM_BYTES,
      minRequiredBytes: DEFAULT_27B_MIN_MEM_BYTES,
    }),
    { ok: true, reason: "27B memory admission passed." },
  );
  assert.equal(
    is27BAdmissible({
      memAvailableBytes: 10 * GiB,
      env: { W6_27B_MIN_MEM_BYTES: String(9 * GiB) },
    }).ok,
    true,
  );
});

test("vm_stat parser sums free, inactive, and speculative pages", () => {
  const fixture4k = `Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 100.\nPages active: 999.\nPages inactive: 200.\nPages speculative: 25.\n`;
  assert.equal(
    parseMacVmStat({ vmStatOutput: fixture4k, pageSizeOutput: "4096\n" }),
    325 * 4096,
  );

  const fixture16k = `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1.\nPages inactive:                           2.\nPages speculative:                        3.\nPages wired down:                       999.\n`;
  assert.equal(
    parseMacVmStat({ vmStatOutput: fixture16k, pageSizeOutput: "16384" }),
    6 * 16384,
  );
  assert.throws(
    () =>
      parseMacVmStat({
        vmStatOutput: "Pages free: 1.\nPages inactive: 2.\n",
        pageSizeOutput: "4096",
      }),
    (error) => error.code === "MAC_MEMORY_READ_FAILED",
  );
});

test("macOS memory reader uses sysctl/vm_stat and an injectable parser", async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push([file, args, options]);
    callback(
      null,
      file === "/usr/sbin/sysctl" ? "16384\n" : "fixture vm_stat",
      "",
    );
  };
  const parser = ({ vmStatOutput, pageSizeOutput }) => {
    assert.equal(vmStatOutput, "fixture vm_stat");
    assert.equal(pageSizeOutput, "16384\n");
    return 123456;
  };
  assert.equal(
    await readMacAvailableMemory({ execFileImpl, parser }),
    123456,
  );
  assert.deepEqual(
    calls.map(([file, args]) => [file, args]),
    [
      ["/usr/sbin/sysctl", ["-n", "hw.pagesize"]],
      ["/usr/bin/vm_stat", []],
    ],
  );
});

test("real worker command is shell-free and forces offline startup", () => {
  const built = build27BWorkerCommand({
    runtimeBase: "/synthetic/runtime",
    python: "/synthetic/python",
    env: { KEEP_ME: "yes", PYTHONPATH: "/unsafe" },
  });
  assert.deepEqual(built.command, [
    "/synthetic/python",
    "-I",
    "-B",
    "-m",
    "mycelium_verifier.workers.native",
  ]);
  assert.equal(built.cwd, "/synthetic/runtime");
  assert.equal(built.shell, false);
  assert.equal(built.env.KEEP_ME, "yes");
  assert.equal("PYTHONPATH" in built.env, false);
  assert.equal(built.env.HF_HUB_OFFLINE, "1");
  assert.equal(built.env.TRANSFORMERS_OFFLINE, "1");
  assert.equal(built.env.HF_HUB_DISABLE_TELEMETRY, "1");
});

test("launcher runs a synthetic JSONL adapter, health, restart, and owned cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "w6-27b-launcher-"));
  const childScript = join(root, "synthetic_adapter.py");
  const childLog = join(root, "children.log");
  await writeFile(
    childScript,
    [
      "import json, os, pathlib, sys",
      "pathlib.Path(sys.argv[1]).open('a').write(str(os.getpid()) + '\\n')",
      "loaded = False",
      "for line in sys.stdin:",
      "    msg = json.loads(line)",
      "    op = msg.get('op')",
      "    if op == 'hello': result = {'version': 1, 'model_loaded': loaded}",
      "    elif op == 'load':",
      "        loaded = True",
      "        pathlib.Path(sys.argv[1]).open('a').write('load:' + str(os.getpid()) + '\\n')",
      "        result = {'loaded': True, 'synthetic': True}",
      "    elif op == 'generate':",
      "        req = msg['request']",
      "        result = {'output_token_ids': [req['prompt_token_ids'][0], 248044], 'stop_reason': 'eos', 'timings': {'synthetic': True}}",
      "    elif op == 'close':",
      "        print(json.dumps({'ok': True, 'result': {'closed': True}}), flush=True)",
      "        break",
      "    else: raise RuntimeError('unsupported op')",
      "    print(json.dumps({'ok': True, 'result': result}), flush=True)",
    ].join("\n"),
  );

  const launcher = create27BLauncher({
    command: [process.env.W6_TEST_PYTHON ?? "/usr/bin/python3", "-I", "-B", childScript, childLog],
    cwd: root,
    env: { ...process.env },
    port: 0,
    queueCap: 2,
    maxPromptTokens: 512,
    maxOutputTokens: 64,
    readAvailableMemory: async () => 30 * GiB,
    minRequiredBytes: 22 * GiB,
    loadRequest: {
      op: "load",
      allow_model_load: true,
      profile: { synthetic: true },
      checkpoint_root: "/synthetic/no-weights-read",
      manifest_path: "/synthetic/manifest.json",
      manifest_sha256: "c".repeat(64),
    },
  });
  t.after(() => launcher.close());

  const started = await launcher.start();
  const firstPid = started.childPid;
  assert.equal(Number.isSafeInteger(firstPid), true);
  const health = await fetch(started.url + "/healthz").then((response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
  assert.deepEqual(health, {
    status: "ok",
    model: "27B",
    childPid: firstPid,
    restarts: 0,
  });
  assert.deepEqual(await launcher.generate(auditRequest()), {
    output_token_ids: [42, 248044],
    stop_reason: "eos",
    timings: { synthetic: true },
  });

  const restarted = await launcher.restart();
  assert.notEqual(restarted.childPid, firstPid);
  assert.equal(restarted.url, started.url);
  await eventuallyNotRunning(firstPid);
  const afterRestart = await fetch(restarted.url + "/healthz").then((r) => r.json());
  assert.equal(afterRestart.status, "ok");
  assert.equal(afterRestart.restarts, 1);
  assert.deepEqual((await launcher.generate(auditRequest())).output_token_ids, [
    42,
    248044,
  ]);

  const secondPid = restarted.childPid;
  await launcher.close();
  await eventuallyNotRunning(secondPid);
  await assert.rejects(fetch(started.url + "/healthz"));
  const logged = (await readFile(childLog, "utf8")).trim().split("\n");
  assert.deepEqual(logged, [
    String(firstPid),
    `load:${firstPid}`,
    String(secondPid),
    `load:${secondPid}`,
  ]);
});

test("launcher refuses low-memory admission before spawning", async () => {
  const launcher = create27BLauncher({
    command: ["/definitely/not/spawned"],
    cwd: "/",
    env: {},
    port: 0,
    readAvailableMemory: async () => 1,
    minRequiredBytes: 22 * GiB,
  });
  await assert.rejects(
    launcher.start(),
    (error) => error.code === "W6_27B_MEMORY_REFUSED" && /27B/.test(error.message),
  );
  assert.equal(launcher.childPid, null);
  await launcher.close();
});
