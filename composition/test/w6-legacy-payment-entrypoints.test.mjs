import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const retiredEntrypoint = join(root, "scripts/w6-paid-host.mjs");
const guardedEntrypoint = join(root, "scripts/w6-paid-browser.mjs");
const guardPath = "scripts/w6-single-payment-guard.mjs";
const refusalPattern = new RegExp(
  `RETIRED_PAYMENT_ENTRYPOINT[\\s\\S]*${guardPath.replaceAll(".", "\\.")}`,
);

function makeProbe() {
  const directory = mkdtempSync(join(tmpdir(), "w6-retired-entrypoint-"));
  const preload = join(directory, "preload.mjs");
  const moduleRunner = join(directory, "module-runner.mjs");
  const runtimeRoot = join(directory, "w6-runtime-root");
  writeFileSync(
    preload,
    String.raw`
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import Module, { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const events = [];
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const roots = [
  process.env.W6_ENTRYPOINT_CREDENTIAL_ROOT,
  process.env.W6_RUNTIME_ROOT,
  process.env.W6_ENTRYPOINT_ACTUAL_RUNTIME_ROOT,
].filter(Boolean).map((path) => path.replace(/\/+$/, ""));
const pathText = (value) => {
  try {
    if (value instanceof URL) return fileURLToPath(value);
    if (Buffer.isBuffer(value)) return value.toString("utf8");
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
};
const protectedPath = (value) => {
  const path = pathText(value);
  return roots.some((root) => path === root || path.startsWith(root + "/"));
};
const blockProtectedRead = (name, original) => function(path, ...args) {
  if (protectedPath(path)) {
    events.push("protected-read:" + name);
    throw new Error("W6_TEST_BLOCKED_PROTECTED_READ");
  }
  return original.call(this, path, ...args);
};
for (const name of ["readFileSync", "openSync", "createReadStream"]) {
  fs[name] = blockProtectedRead(name, fs[name]);
}
for (const name of ["readFile", "open"]) {
  fs.promises[name] = blockProtectedRead("promises." + name, fs.promises[name]);
}
const blockNetwork = (name) => function() {
  events.push("network:" + name);
  throw new Error("W6_TEST_BLOCKED_NETWORK");
};
globalThis.fetch = blockNetwork("fetch");
for (const [module, names] of [
  [http, ["request", "get"]],
  [https, ["request", "get"]],
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
]) {
  for (const name of names) module[name] = blockNetwork(name);
}
for (const name of ["sign", "createSign"]) {
  crypto[name] = function() {
    events.push("sign:" + name);
    throw new Error("W6_TEST_BLOCKED_SIGN");
  };
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "@x402/hedera" || request === "ethers") {
    events.push("signer-dependency:" + request);
    throw new Error("W6_TEST_BLOCKED_SIGNER_DEPENDENCY");
  }
  return originalLoad.call(this, request, parent, isMain);
};
syncBuiltinESMExports();
process.on("exit", () => {
  originalWriteFileSync(process.env.W6_ENTRYPOINT_PROBE_LOG, JSON.stringify(events));
});
`,
  );
  writeFileSync(
    moduleRunner,
    `const module = await import(${JSON.stringify(pathToFileURL(retiredEntrypoint).href)} + "?module-probe");\n` +
      `const stderr = [];\n` +
      `const exitCode = module.refuseLegacyPaymentEntrypoint({ stderr: { write: (text) => stderr.push(String(text)) } });\n` +
      `process.stdout.write(JSON.stringify({ exitCode, stderr: stderr.join("") }));\n`,
  );
  return { directory, preload, moduleRunner, runtimeRoot };
}

function runWithProbe(probe, args, logName) {
  const log = join(probe.directory, logName);
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
  const importOption = `--import=${pathToFileURL(probe.preload).href}`;
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: existingNodeOptions
        ? `${existingNodeOptions} ${importOption}`
        : importOption,
      W6_ENTRYPOINT_PROBE_LOG: log,
      W6_ENTRYPOINT_CREDENTIAL_ROOT: join(homedir(), ".ethonline-testnet"),
      W6_ENTRYPOINT_ACTUAL_RUNTIME_ROOT: join(
        homedir(),
        "mycelium-physical-run/w6-ethonline-20260912T090309Z",
      ),
      W6_RUNTIME_ROOT: probe.runtimeRoot,
    },
  });
  const events = JSON.parse(readFileSync(log, "utf8"));
  return { ...result, events };
}

test("retired paid host is inert when imported and explicitly refuses module invocation", () => {
  const probe = makeProbe();
  const result = runWithProbe(probe, [probe.moduleRunner], "module-events.json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, [], "module import or invocation touched a protected side effect");
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.exitCode, 1);
  assert.match(observed.stderr, refusalPattern);
});

test("retired paid host CLI exits non-zero with the maintained-guard refusal", () => {
  const probe = makeProbe();
  const result = runWithProbe(probe, [retiredEntrypoint], "cli-events.json");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, refusalPattern);
  assert.deepEqual(result.events, [], "CLI touched credentials, signing, or network");
});

test("retired source contains no credential, signer, runtime, or network capability", () => {
  const source = readFileSync(retiredEntrypoint, "utf8");
  assert.match(source, /scripts\/w6-single-payment-guard\.mjs/);
  assert.doesNotMatch(source, /trycloudflare/i);
  assert.doesNotMatch(
    source,
    /@x402|ethers|PrivateKey|createClientHederaSigner|\.sign\s*\(|readFile|openSync|createReadStream|ethonlineTestnetPath|w6RuntimePath|fetch\s*\(|node:https?|node:net|node:tls/i,
  );
});

test("the maintained one-attempt W6 payment tool imports and constructs the single-payment guard", () => {
  const source = readFileSync(guardedEntrypoint, "utf8");
  assert.match(source, /from "\.\/w6-single-payment-guard\.mjs"/);
  assert.match(source, /createSinglePaymentGuard\s*\(/);
});

test.todo(
  "finding: legacy composition/hedera-live-connection.mjs signer must route through the W6 single-payment guard",
  () => {
    const source = readFileSync(
      join(root, "composition/hedera-live-connection.mjs"),
      "utf8",
    );
    if (!source.includes("w6-single-payment-guard.mjs")) {
      throw new Error("LIVE_SIGNER_BYPASSES_W6_SINGLE_PAYMENT_GUARD");
    }
  },
);
