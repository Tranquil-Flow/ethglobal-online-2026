import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createStore } from "../../packages/core/src/index.mjs";
import { createRequest } from "../../packages/access/src/index.mjs";
import {
  makeOwnedNativeConfiguration,
  inspectOwnedNativeRuntime,
} from "../application-owned-native.mjs";
const put = (p, x) =>
  writeFile(p, JSON.stringify(x, null, 2) + "\n", { mode: 0o600 });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "app-owned-native-"));
  await mkdir(join(root, "native"), { mode: 0o700 });
  const config = makeOwnedNativeConfiguration({
    engine: "fixture",
    python: "/usr/bin/python3",
  });
  await put(join(root, "native/config.json"), config);
  const spec = {
    kind: "application-native",
    configurationFile: "native/config.json",
    permitFile: "native/permit.json",
  };
  const descriptor = inspectOwnedNativeRuntime({
    root,
    spec,
    mode: "development",
    providerId: "owned.fixture",
  });
  const now = Date.now();
  const permit = {
    schema: "mycelium.application-native-permit.v1",
    grantId: randomUUID(),
    approved: true,
    approvalRef: "synthetic test only - no model permission",
    mode: "development",
    runtimeDigest: descriptor.bindingDigest,
    sourceDigest: config.sourceDigest,
    notBefore: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    limits: {
      maxLoads: 2,
      maxRequests: 2,
      maxPromptTokens: 512,
      maxOutputTokens: 64,
      maxTotalPromptTokens: 1024,
      maxTotalOutputTokens: 128,
      maxRuntimeMs: 61000,
      maxRssBytes: 268435456,
      maxMlxBytes: 268435456,
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      shutdownGraceMs: 1000,
    },
  };
  const store = createStore({ path: join(root, "runtime.sqlite") });
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    permit,
    descriptor,
    store,
    async permitFile(p = permit) {
      await put(join(root, "native/permit.json"), p);
    },
    async start() {
      const r = await descriptor.create({ store });
      runtimes.push(r);
      return r;
    },
  };
}
async function execute(
  runtime,
  f,
  jobId,
  prompt = "fixture café 🌙",
  maxOutputTokens = 6,
) {
  const request = await createRequest({
    providerId: "owned.fixture",
    profileId: f.descriptor.profiles.map((x) => f.config.profileId)[0],
    prompt,
    maxOutputTokens,
    seed: 0,
    publishConsent: false,
  });
  const args = {
    jobId,
    request,
    profile: f.config.profile,
    signal: new AbortController().signal,
  };
  const events = [];
  for await (const e of runtime.executor.execute(args)) events.push(e);
  return { args, events };
}

test("owned native startup is offline until a matching permit and never relabels fixture as live", async (t) => {
  const f = await setup(t);
  assert.equal(f.descriptor.kind, "application-native");
  assert.equal(f.descriptor.status().status, "not_started");
  await assert.rejects(f.start(), /APP_NATIVE_PERMIT_REQUIRED/);
  assert.throws(
    () =>
      inspectOwnedNativeRuntime({
        root: f.root,
        spec: {
          kind: "application-native",
          configurationFile: "native/config.json",
          permitFile: "native/permit.json",
        },
        mode: "live",
        providerId: "owned.fixture",
      }),
    /RUNTIME_MODE_MISMATCH/,
  );
  await f.permitFile({ ...f.permit, sourceDigest: "sha256:" + "0".repeat(64) });
  await assert.rejects(f.start(), /APP_NATIVE_PERMIT_BINDING/);
  await f.permitFile();
  const r = await f.start();
  assert.equal(r.status().status, "ready");
  assert.equal(r.status().modelLoaded, false);
  const pid = r.status().pid;
  assert(pid > 0);
  await r.close();
  assert.equal(r.status().status, "stopped");
  assert.throws(() => process.kill(pid, 0));
});

test("owned worker streams actual fixture IDs, replays without execution and preserves budget across restart", async (t) => {
  const f = await setup(t);
  await f.permitFile();
  let r = await f.start();
  const one = await execute(r, f, randomUUID());
  assert.equal(one.events.at(-1).type, "completed");
  assert.equal(one.events.at(-1).output.text, "fixtur");
  assert.deepEqual(
    one.events.at(-1).output.tokenIds,
    [102, 105, 120, 116, 117, 114],
  );
  const replay = [];
  for await (const e of r.executor.execute(one.args)) replay.push(e);
  assert.deepEqual(replay, one.events);
  assert.equal(r.status().requestsReserved, 1);
  await r.close();
  r = await f.start();
  const after = [];
  for await (const e of r.executor.execute(one.args)) after.push(e);
  assert.deepEqual(after, one.events);
  assert.equal(r.status().loadsReserved, 2);
  assert.equal(r.status().requestsReserved, 1);
  await execute(r, f, randomUUID(), "second", 3);
  await assert.rejects(
    execute(r, f, randomUUID(), "denied", 3),
    /APP_NATIVE_REQUEST_BUDGET/,
  );
  await r.close();
  await assert.rejects(f.start(), /APP_NATIVE_LOAD_BUDGET/);
});

test("owned cancellation waits for worker terminal and no completed output is accepted", async (t) => {
  const f = await setup(t);
  await f.permitFile();
  const r = await f.start();
  const request = await createRequest({
    providerId: "owned.fixture",
    profileId: f.config.profileId,
    prompt: "a".repeat(64),
    maxOutputTokens: 64,
    seed: 0,
    publishConsent: false,
  });
  const controller = new AbortController();
  let tokens = 0;
  await assert.rejects(async () => {
    for await (const e of r.executor.execute({
      jobId: randomUUID(),
      request,
      profile: f.config.profile,
      signal: controller.signal,
    })) {
      assert.notEqual(e.type, "completed");
      if (e.type === "delta" && ++tokens === 1) controller.abort();
    }
  }, /EXECUTION_CANCELLED/);
  assert(tokens >= 1);
  assert.equal(r.status().activeRequests, 0);
  assert.equal(r.status().status, "ready");
});

test("expired or rebound permits cannot reset state or start a process", async (t) => {
  const f = await setup(t);
  await f.permitFile();
  const r = await f.start();
  await r.close();
  await f.permitFile({
    ...f.permit,
    limits: { ...f.permit.limits, maxRequests: 20 },
  });
  await assert.rejects(f.start(), /APP_NATIVE_PERMIT_REBOUND/);
  await f.permitFile({ ...f.permit, expiresAt: new Date(0).toISOString() });
  await assert.rejects(f.start(), /APP_NATIVE_PERMIT_EXPIRED/);
});

test("model manifest and environment cannot drift behind an unchanged advertised profile", async (t) => {
  const f = await setup(t);
  const spec = {
    kind: "application-native",
    configurationFile: "native/config.json",
    permitFile: "native/permit.json",
  };
  for (const changed of [
    {
      ...f.config,
      modelFiles: [
        { name: "unexpected.safetensors", bytes: 1, sha256: "0".repeat(64) },
      ],
    },
    {
      ...f.config,
      runtimeVersions: { ...f.config.runtimeVersions, python: "changed" },
    },
  ]) {
    await put(join(f.root, "native/config.json"), changed);
    assert.throws(
      () =>
        inspectOwnedNativeRuntime({
          root: f.root,
          spec,
          mode: "development",
          providerId: "owned.fixture",
        }),
      /APP_NATIVE_PROFILE_MISMATCH/,
    );
  }
});

test("failed executable launch releases ownership without inventing a running child", async (t) => {
  const f = await setup(t);
  const { chmod } = await import("node:fs/promises");
  const executable = join(f.root, "python");
  await writeFile(executable, "#!/missing/application-test-interpreter\n");
  await chmod(executable, 0o700);
  const config = makeOwnedNativeConfiguration({
    engine: "fixture",
    python: executable,
  });
  await put(join(f.root, "native/config.json"), config);
  const d = inspectOwnedNativeRuntime({
    root: f.root,
    spec: {
      kind: "application-native",
      configurationFile: "native/config.json",
      permitFile: "native/permit.json",
    },
    mode: "development",
    providerId: "owned.fixture",
  });
  await f.permitFile({
    ...f.permit,
    runtimeDigest: d.bindingDigest,
    sourceDigest: config.sourceDigest,
  });
  await assert.rejects(d.create({ store: f.store }), /APP_NATIVE_SPAWN_FAILED/);
  assert.equal(f.store.get("metadata", "owner"), undefined);
});

test("post-spawn state-write failure stops the actual child and releases the store", async (t) => {
  const f = await setup(t);
  await f.permitFile();
  let spawnedPid;
  const wrapped = new Proxy(f.store, {
    get(target, key) {
      if (key === "set")
        return (ns, id, value) => {
          if (ns === "app-native-state-v1" && value.pid) {
            spawnedPid = value.pid;
            throw Error("synthetic state write failure");
          }
          return target.set(ns, id, value);
        };
      return target[key];
    },
  });
  await assert.rejects(
    f.descriptor.create({ store: wrapped }),
    /APP_NATIVE_STATE_PERSISTENCE_FAILED/,
  );
  assert(spawnedPid > 0);
  assert.throws(() => process.kill(spawnedPid, 0));
  assert.equal(f.store.get("metadata", "owner"), undefined);
});

test("running lease expiry stops the worker and live status cannot remain ready", async (t) => {
  const f = await setup(t);
  const now = Date.now();
  await f.permitFile({
    ...f.permit,
    notBefore: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 1000).toISOString(),
  });
  const r = await f.start();
  const pid = r.status().pid;
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(r.status().status, "expired");
  assert.equal(r.status().pid, null);
  assert.throws(() => process.kill(pid, 0));
});

test("cached replay is checked against its retained record and deletion cannot reexecute", async (t) => {
  const f = await setup(t);
  await f.permitFile();
  const r = await f.start();
  const one = await execute(r, f, randomUUID());
  const saved = f.store.get("app-native-jobs-v1", one.args.jobId);
  const changed = structuredClone(saved);
  changed.events[0].text = "changed";
  f.store.set("app-native-jobs-v1", one.args.jobId, changed);
  await assert.rejects(async () => {
    for await (const e of r.executor.execute(one.args)) {
    }
  }, /APP_NATIVE_RECORD_CORRUPT/);
  f.store.set("app-native-jobs-v1", one.args.jobId, saved);
  r.deleteEvidence({ jobId: one.args.jobId });
  await assert.rejects(async () => {
    for await (const e of r.executor.execute(one.args)) {
    }
  }, /EVIDENCE_UNAVAILABLE/);
  assert.equal(r.status().requestsReserved, 1);
});

test("controller death closes private input and the owned worker exits without orphaning", async (t) => {
  const f = await setup(t);
  await f.permitFile();
  const { spawn } = await import("node:child_process");
  const moduleUrl = new URL("../application-owned-native.mjs", import.meta.url)
    .href;
  const storeUrl = new URL("../../packages/core/src/index.mjs", import.meta.url)
    .href;
  const script = `import {inspectOwnedNativeRuntime} from '${moduleUrl}';import {createStore} from '${storeUrl}';const root=process.argv[2];const store=createStore({path:root+'/runtime.sqlite'});const d=inspectOwnedNativeRuntime({root,spec:{kind:'application-native',configurationFile:'native/config.json',permitFile:'native/permit.json'},mode:'development',providerId:'owned.fixture'});const r=await d.create({store});console.log(JSON.stringify({pid:r.status().pid,temp:store.get('app-native-state-v1','current').temporaryDirectory}));setInterval(()=>{},1000);`;
  const path = join(f.root, "controller.mjs");
  await writeFile(path, script);
  const child = spawn(process.execPath, [path, f.root], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const data = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(Error("FIXTURE_READY_TIMEOUT")),
      5000,
    );
    child.stdout.on("data", (b) => {
      text += b;
      const i = text.indexOf("\n");
      if (i >= 0) {
        clearTimeout(timer);
        resolve(JSON.parse(text.slice(0, i)));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null && code !== 0) reject(Error("FIXTURE_CONTROLLER_EXIT"));
    });
  });
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  const until = Date.now() + 5000;
  let alive = true;
  while (Date.now() < until) {
    try {
      process.kill(data.pid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(alive, false);
  await assert.rejects((await import("node:fs/promises")).access(data.temp));
  const restarted = await f.start();
  assert.equal(restarted.status().loadsReserved, 2);
});
