// One explicitly approved public qualification window. No automatic publication:
// only receipt digests privately admitted by the qualification driver may spend.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import {
  readPrivateFile,
  assertPrivateDirectory,
} from "../operations/src/private-files.mjs";
import {
  initializeApplication,
  startManagedApplication,
} from "./application-operator.mjs";
import { inspectManagedPublication } from "./application-publication-config.mjs";
import {
  startApplicationHttps,
  inspectApplicationHttps,
} from "./application-https.mjs";
export const PUBLIC_ORIGIN = "https://m4pro.tail53d0d3.ts.net";
const base = fileURLToPath(new URL("../../", import.meta.url));
const waveRoot = join(base, ".private/wave5");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function owned(path) {
  const p = resolve(path);
  if (!p.startsWith(resolve(waveRoot) + "/"))
    fail("WAVE5_PRIVATE_PATH_REQUIRED");
  return p;
}
function jsonFile(path) {
  return JSON.parse(
    readPrivateFile(path, {
      maxBytes: 2097152,
      code: "PRIVATE_INPUT_REQUIRED",
    }).data.toString("utf8"),
  );
}
function tsStatus() {
  const r = spawnSync("tailscale", ["serve", "status", "--json"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (r.status !== 0) fail("TAILSCALE_STATUS_FAILED");
  return JSON.parse(r.stdout);
}
async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    ended,
    delay(5000).then(() => {
      child.kill("SIGKILL");
      return ended;
    }),
  ]);
}
export function createReceiptGatedSink({ authorizationFile, createSink }) {
  let pending,
    sink,
    closed = false;
  return {
    async publish(args) {
      if (closed) fail("PUBLICATION_CLOSED");
      if (args.event?.kind !== "receipt" || args.event.mode !== "live")
        return { status: "unavailable" };
      assertPrivateDirectory(dirname(authorizationFile));
      const allow = jsonFile(authorizationFile);
      if (
        !Array.isArray(allow.receiptDigests) ||
        allow.receiptDigests.length > 4 ||
        allow.receiptDigests.some((x) => !/^sha256:[0-9a-f]{64}$/.test(x))
      )
        fail("INVALID_RECEIPT_AUTHORIZATION");
      if (!allow.receiptDigests.includes(args.event.objectDigest))
        return { status: "pending" };
      pending ??= Promise.resolve().then(createSink);
      sink = await pending;
      if (closed) fail("PUBLICATION_CLOSED");
      return sink.publish(args);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (pending) {
        sink = await pending;
        await sink.close?.();
      }
    },
  };
}
export async function startPublicWindow({
  approved = false,
  privateRoot,
  physicalEvidence,
} = {}) {
  if (!approved || process.env.WAVE5_PUBLIC_WINDOW_APPROVED !== "1")
    fail("PUBLIC_WINDOW_APPROVAL_REQUIRED");
  if (process.env.WAVE5_OLLAMA_LIVE_APPROVED !== "1")
    fail("OLLAMA_LOCAL_MODEL_APPROVAL_REQUIRED");
  const root = owned(privateRoot),
    proof = jsonFile(owned(physicalEvidence));
  if (
    proof.status !== "passed" ||
    proof.jobs?.length !== 2 ||
    proof.nodeClaims?.length !== 2
  )
    fail("PHYSICAL_PACKET_REQUIRED");
  const names = [
    "service.ethonline-node-a.eth",
    "service.ethonline-node-b.eth",
  ];
  const profiles = names.map(
    (n) => proof.jobs.find((x) => x.providerId === n)?.profile,
  );
  profiles.forEach((p) => validate("Profile", p));
  const before = tsStatus();
  if (Object.keys(before).length) fail("EXISTING_SERVING_CONFIG_PRESERVED");
  assertPrivateDirectory(dirname(root));
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, "tailscale-before.json"), JSON.stringify(before), {
    flag: "wx",
    mode: 0o600,
  });
  const sourceRevision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  }).stdout.trim();
  let tunnel,
    app,
    tls,
    funnel,
    publisher,
    closed = false,
    lease;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(lease);
    const errors = [];
    for (const f of [
      () => stop(funnel),
      () => tls?.close(),
      () => app?.close(),
      () => publisher?.close(),
      () => stop(tunnel),
    ])
      try {
        await f();
      } catch (e) {
        errors.push(e.code ?? e.name);
      }
    let after;
    try {
      after = tsStatus();
    } catch (e) {
      errors.push(e.code);
    }
    const restored = JSON.stringify(after) === JSON.stringify(before);
    writeFileSync(
      join(root, "closed.json"),
      JSON.stringify(
        {
          closedAt: new Date().toISOString(),
          servingRestored: restored,
          errors,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (!restored || errors.length) fail("PUBLIC_WINDOW_CLEANUP_UNCONFIRMED");
  };
  try {
    const forwardPort = await freePort();
    tunnel = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ExitOnForwardFailure=yes",
        "-i",
        join(homedir(), ".ssh/id_ed25519_m4pro_to_laptop"),
        "-N",
        "-L",
        `127.0.0.1:${forwardPort}:100.126.111.123:11434`,
        "mycelium-laptop",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    tunnel.stderr.on("data", (b) =>
      writeFileSync(join(root, "ssh-last-error.log"), b, { mode: 0o600 }),
    );
    const endpoints = [
      "http://127.0.0.1:11434",
      `http://127.0.0.1:${forwardPort}`,
    ];
    let ready = false;
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      try {
        const r = await fetch(endpoints[1] + "/api/version", {
          signal: AbortSignal.timeout(1000),
        });
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      if (tunnel.exitCode !== null) fail("SSH_TUNNEL_FAILED");
      await delay(100);
    }
    if (!ready) fail("LAPTOP_TUNNEL_UNAVAILABLE");
    const dataDir = join(root, "app"),
      configFile = join(dataDir, "application.json");
    await initializeApplication({ dataDir, providerIds: names });
    const config = jsonFile(configFile),
      operatorFile = join(dataDir, "operator.json"),
      operator = jsonFile(operatorFile);
    const graph = JSON.parse(
      readFileSync(join(base, "GRAPH-OPEN-PUBLICATION.json"), "utf8"),
    );
    const policy = {
      maxPromptTokens: 512,
      maxOutputTokens: 64,
      contextTokens: 1024,
      timeoutMs: 90000,
      maxOutputBytes: 65536,
    };
    config.mode = "live";
    config.publicOrigin = PUBLIC_ORIGIN;
    Object.assign(config.core, {
      jobDeadlineMs: 120000,
      portTimeoutMs: 30000,
      concurrency: 1,
      maxQueue: 8,
      maxRecords: 32,
    });
    for (const [i, p] of config.providers.entries()) {
      const runtime = {
        kind: "ollama",
        endpoint: endpoints[i],
        profile: profiles[i],
        options: policy,
      };
      operator.providers[i].runtime = runtime;
      p.profileIds = [digestOf(profiles[i])];
      p.runtimeDigest = digestOf(runtime);
      p.aliases = { ["qwen-raw-" + i]: p.profileIds[0] };
    }
    operator.history = {
      endpoint: graph.queryUrl,
      publicEndpoint: graph.queryUrl,
      deployment: graph.deployment,
      deploymentId: graph.deploymentId,
      rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    };
    operator.discovery = {
      mode: "live",
      rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
      names,
      timeoutMs: 15000,
    };
    writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    writeFileSync(operatorFile, JSON.stringify(operator, null, 2), {
      mode: 0o600,
    });
    const authorizationFile = join(root, "allowed-receipts.json");
    writeFileSync(authorizationFile, JSON.stringify({ receiptDigests: [] }), {
      mode: 0o600,
    });
    publisher = createReceiptGatedSink({
      authorizationFile,
      createSink: async () => {
        const bytes = readPrivateFile(
          join(base, ".private/integration09-native/app/publisher.json"),
          { maxBytes: 8192, code: "PRIVATE_SIGNER_REQUIRED" },
        ).data;
        try {
          writeFileSync(join(dataDir, "publisher.json"), bytes, {
            flag: "wx",
            mode: 0o600,
          });
        } finally {
          bytes.fill(0);
        }
        return inspectManagedPublication({
          root: dataDir,
          mode: "live",
          spec: {
            deployment: graph.deployment,
            rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
            signerFile: "publisher.json",
            journalDirectory: "publication",
            maxGasPriceWei: "3000000000",
            approvedLiveWrite: true,
            budget: { maxTransactions: 4, maxTotalFeeWei: "5000000000000000" },
          },
        }).create();
      },
    });
    app = await startManagedApplication({ configFile, eventSink: publisher });
    const tlsPort = await freePort();
    const certFile = join(root, "public.crt");
    writeFileSync(
      certFile,
      readFileSync(join(base, ".private/nonverify-live/tls/public.crt")),
      { flag: "wx", mode: 0o600 },
    );
    const tlsConfig = {
      upstream: app.url,
      publicOrigin: PUBLIC_ORIGIN,
      certFile,
      keyFile: join(base, ".private/nonverify-live/tls/private.key"),
      port: tlsPort,
      upstreamTimeoutMs: 120000,
    };
    const tlsFile = join(root, "tls.json");
    writeFileSync(tlsFile, JSON.stringify(tlsConfig), { mode: 0o600 });
    const tlsInspection = inspectApplicationHttps({ configFile: tlsFile });
    tls = await startApplicationHttps({ configFile: tlsFile });
    // All local services are ready before any public route is configured.
    funnel = spawn(
      "tailscale",
      ["funnel", "--tcp=443", `tcp://127.0.0.1:${tlsPort}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let funnelText = "";
    for (const s of [funnel.stdout, funnel.stderr])
      s.on("data", (b) => {
        funnelText = (funnelText + b).slice(-16384);
        writeFileSync(join(root, "funnel.log"), funnelText, { mode: 0o600 });
      });
    let active = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = JSON.stringify(tsStatus());
      if (
        state.includes(`127.0.0.1:${tlsPort}`) &&
        state.includes("AllowFunnel")
      ) {
        active = true;
        break;
      }
      if (funnel.exitCode !== null) fail("FUNNEL_START_FAILED");
      await delay(200);
    }
    if (!active) fail("FUNNEL_ACTIVATION_UNCONFIRMED");
    const manifest = {
      version: "wave5-public-window-v1",
      sourceRevision,
      publicOrigin: PUBLIC_ORIGIN,
      privateRoot: root,
      configFile,
      operatorFile,
      authorizationFile,
      profiles,
      providerIds: names,
      pins: app.pins,
      graph,
      startedAt: new Date().toISOString(),
      tlsInspection,
      tlsPort,
      apiUrl: app.url,
      forwardPort,
      maximumLifetimeMs: 3600000,
    };
    writeFileSync(join(root, "ready.json"), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    lease = setTimeout(() => close().catch(() => {}), 3600000);
    return { manifest, close };
  } catch (error) {
    await close();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let window;
  try {
    const { values: v } = parseArgs({
      options: {
        root: { type: "string" },
        proof: { type: "string" },
        approved: { type: "boolean" },
      },
    });
    window = await startPublicWindow({
      approved: v.approved,
      privateRoot: v.root,
      physicalEvidence: v.proof,
    });
    console.log(
      JSON.stringify({
        status: "public-window-ready",
        manifest: join(window.manifest.privateRoot, "ready.json"),
        publicOrigin: PUBLIC_ORIGIN,
      }),
    );
    await new Promise((r) => {
      process.once("SIGTERM", r);
      process.once("SIGINT", r);
      setTimeout(r, 3600000).unref();
    });
    await window.close();
  } catch (error) {
    await window?.close().catch(() => {});
    console.error(error.code ?? "PUBLIC_WINDOW_FAILED");
    process.exitCode = 1;
  }
}
