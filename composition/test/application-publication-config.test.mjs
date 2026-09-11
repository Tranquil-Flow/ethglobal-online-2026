import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { inspectManagedPublication } from "../application-publication-config.mjs";

const { Wallet } = createRequire(
  new URL("../../packages/indexing/package.json", import.meta.url),
)("ethers");
const codeHash = "0x" + "12".repeat(32);
const publisher = Wallet.createRandom(),
  registry = Wallet.createRandom();
function deployment(mode = "development") {
  return mode === "development"
    ? {
        mode,
        chainId: 31337,
        network: "localhost",
        address: registry.address,
        publisher: publisher.address,
        codeHash,
        startBlock: 0,
        confirmations: 1,
      }
    : {
        mode,
        chainId: 11155111,
        network: "sepolia",
        address: registry.address,
        publisher: publisher.address,
        codeHash,
        startBlock: 0,
        confirmations: 12,
      };
}
function spec(overrides = {}) {
  return {
    deployment: deployment(),
    rpcUrl: "http://127.0.0.1:8545/",
    signerFile: "publication/signer.json",
    journalDirectory: "publication/journal",
    maxGasPriceWei: "100000000000",
    approvedLiveWrite: false,
    ...overrides,
  };
}
function hasCode(code) {
  return (error) => error?.code === code && error.message === code;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "managed-publication-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function missing(path) {
  try {
    await access(path, constants.F_OK);
    return false;
  } catch (e) {
    if (e.code === "ENOENT") return true;
    throw e;
  }
}

test("inspection is closed, offline, deferred, and declares backup closure", async (t) => {
  const root = await fixture(t);
  const inspected = inspectManagedPublication({
    root,
    spec: spec(),
    mode: "development",
  });
  assert.deepEqual(Object.keys(inspected).sort(), [
    "create",
    "directories",
    "files",
  ]);
  assert.deepEqual(inspected.files, ["publication/signer.json"]);
  assert.deepEqual(inspected.directories, ["publication/journal"]);
  assert.equal(typeof inspected.create, "function");
  assert.equal(await missing(join(root, "publication")), true);
  await assert.rejects(
    inspected.create(),
    hasCode("PRIVATE_PUBLICATION_SIGNER_REQUIRED"),
  );
  assert.equal(await missing(join(root, "publication/journal")), true);
  assert.throws(
    () =>
      inspectManagedPublication({
        root,
        mode: "development",
        spec: { ...spec(), unexpected: true },
      }),
    hasCode("INVALID_MANAGED_PUBLICATION"),
  );
});

test("inspection rejects mode, approval, fee, path, and RPC trust violations", async (t) => {
  const root = await fixture(t);
  const live = deployment("live");
  const cases = [
    ["mode mismatch", spec(), "live", "PUBLICATION_MODE_MISMATCH"],
    [
      "live approval",
      spec({ deployment: live, rpcUrl: "https://rpc.sepolia.org/" }),
      "live",
      "LIVE_WRITE_APPROVAL_REQUIRED",
    ],
    [
      "zero fee",
      spec({ maxGasPriceWei: "0" }),
      "development",
      "INVALID_MANAGED_PUBLICATION",
    ],
    [
      "noncanonical fee",
      spec({ maxGasPriceWei: "01" }),
      "development",
      "INVALID_MANAGED_PUBLICATION",
    ],
    [
      "absolute signer",
      spec({ signerFile: "/tmp/signer.json" }),
      "development",
      "UNSAFE_MANAGED_PATH",
    ],
    [
      "traversal journal",
      spec({ journalDirectory: "publication/../journal" }),
      "development",
      "UNSAFE_MANAGED_PATH",
    ],
    [
      "non-http",
      spec({ rpcUrl: "ws://127.0.0.1:8545/" }),
      "development",
      "INVALID_PUBLICATION_RPC",
    ],
    [
      "remote development",
      spec({ rpcUrl: "http://rpc.sepolia.org/" }),
      "development",
      "INVALID_PUBLICATION_RPC",
    ],
    [
      "live http",
      spec({
        deployment: live,
        rpcUrl: "http://rpc.sepolia.org/",
        approvedLiveWrite: true,
      }),
      "live",
      "INVALID_PUBLICATION_RPC",
    ],
    [
      "live private target",
      spec({
        deployment: live,
        rpcUrl: "https://192.168.1.8/",
        approvedLiveWrite: true,
      }),
      "live",
      "INVALID_PUBLICATION_RPC",
    ],
  ];
  for (const [name, value, mode, code] of cases)
    assert.throws(
      () => inspectManagedPublication({ root, spec: value, mode }),
      hasCode(code),
      name,
    );
  for (const rpcUrl of [
    "http://user:password@127.0.0.1:8545/",
    "http://127.0.0.1:8545/?token=secret",
    "http://127.0.0.1:8545/#secret",
  ])
    assert.throws(
      () =>
        inspectManagedPublication({
          root,
          mode: "development",
          spec: spec({ rpcUrl }),
        }),
      hasCode("INVALID_PUBLICATION_RPC"),
    );
});

test("create privately loads an address-bound signer and returns an owned sink", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "signer.json"),
    JSON.stringify({
      address: publisher.address,
      privateKey: publisher.privateKey,
    }),
    { mode: 0o600 },
  );
  const inspected = inspectManagedPublication({
    root,
    mode: "development",
    spec: spec({
      signerFile: "signer.json",
      journalDirectory: "publication-journal",
    }),
  });
  const sink = await inspected.create();
  assert.deepEqual(Object.keys(sink).sort(), ["close", "publish"]);
  assert.equal(await missing(join(root, "publication-journal")), true);
  await sink.close();
  await sink.close();
});

test("create fails closed with redacted signer errors", async (t) => {
  const root = await fixture(t);
  const canary = "PRIVATE-CANARY-MUST-NOT-LEAK";
  await writeFile(
    join(root, "signer.json"),
    JSON.stringify({ address: publisher.address, privateKey: canary }),
    { mode: 0o600 },
  );
  const inspected = inspectManagedPublication({
    root,
    mode: "development",
    spec: spec({ signerFile: "signer.json", journalDirectory: "journal" }),
  });
  await assert.rejects(inspected.create(), (error) => {
    assert.equal(error.code, "INVALID_PUBLICATION_SIGNER");
    assert.equal(error.message, "INVALID_PUBLICATION_SIGNER");
    assert.equal(String(error).includes(canary), false);
    assert.equal(String(error).includes(join(root, "signer.json")), false);
    return true;
  });
});

test("managed signer paths reject a symlinked parent before reading an external key", async (t) => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const parent = await fixture(t),
    root = join(parent, "root"),
    external = join(parent, "external");
  await mkdir(root, { mode: 0o700 });
  await mkdir(external, { mode: 0o700 });
  await writeFile(
    join(external, "signer.json"),
    JSON.stringify({
      address: publisher.address,
      privateKey: publisher.privateKey,
    }),
    { mode: 0o600 },
  );
  await symlink(external, join(root, "redirect"), "dir");
  const inspected = inspectManagedPublication({
    root,
    mode: "development",
    spec: spec({ signerFile: "redirect/signer.json" }),
  });
  let sink;
  try {
    await assert.rejects(async () => {
      sink = await inspected.create();
    }, /UNSAFE_MANAGED_PATH/);
  } finally {
    await sink?.close();
  }
});
