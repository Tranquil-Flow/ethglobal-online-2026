import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import {
  readPrivateFile,
  assertPrivateDirectory,
  writePrivateExclusive,
} from "../operations/src/private-files.mjs";
import {
  validateDeployment,
  createEventSink,
  createPublicationStore,
} from "../packages/indexing/src/index.mjs";
const require = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
);
const {
  FetchRequest,
  JsonRpcProvider,
  Wallet,
  Transaction,
} = require("ethers");
const code = (c) => {
  const e = new Error(c);
  e.code = c;
  throw e;
};
const exact = (x, fields) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).sort().join("\n") === [...fields].sort().join("\n");
const safeRel = (path) => {
  if (
    typeof path !== "string" ||
    path.length < 1 ||
    path.length > 256 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    code("UNSAFE_MANAGED_PATH");
  return path;
};
const resolveManaged = (root, path) => {
  const full = resolve(root, safeRel(path));
  if (!full.startsWith(resolve(root) + "/")) code("UNSAFE_MANAGED_PATH");
  try {
    assertPrivateDirectory(root);
    let parent = root;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      if (!existsSync(parent)) break; // Deferred journal parents are created privately at publish.
      assertPrivateDirectory(parent);
    }
  } catch {
    code("UNSAFE_MANAGED_PATH");
  }
  return full;
};
const loopback = (host) =>
  host === "127.0.0.1" ||
  host === "localhost" ||
  host === "[::1]" ||
  host === "::1";
export function validateRpc(url, mode) {
  let u;
  try {
    u = new URL(url);
  } catch {
    code("INVALID_PUBLICATION_RPC");
  }
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["http:", "https:"].includes(u.protocol)
  )
    code("INVALID_PUBLICATION_RPC");
  const host = u.hostname;
  if (mode === "development") {
    if (u.protocol !== "http:" || !loopback(host))
      code("INVALID_PUBLICATION_RPC");
  } else {
    if (u.protocol !== "https:") code("INVALID_PUBLICATION_RPC");
    if (
      loopback(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      /^169\.254\./.test(host)
    )
      code("INVALID_PUBLICATION_RPC");
  }
  return u.toString();
}
function ensureJournal(root, relative) {
  let directory = root;
  for (const segment of relative.split("/")) {
    directory = join(directory, segment);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    assertPrivateDirectory(directory);
  }
  const lock = join(directory, "journal.lock");
  if (!existsSync(lock)) {
    try {
      writePrivateExclusive(lock, "mycelium-publication-lock-v1\n");
    } catch (e) {
      if (e.code !== "DESTINATION_EXISTS") throw e;
    }
  }
  readPrivateFile(lock, {
    maxBytes: 128,
    code: "UNSAFE_PUBLICATION_LOCK",
  }).data.fill(0);
}
export function inspectManagedPublication({ root, spec, mode }) {
  spec = structuredClone(spec);
  assertPrivateDirectory(resolve(root));
  if (
    !exact(spec, [
      "deployment",
      "rpcUrl",
      "signerFile",
      "journalDirectory",
      "maxGasPriceWei",
      "approvedLiveWrite",
      ...(spec?.budget === undefined ? [] : ["budget"]),
    ])
  )
    code("INVALID_MANAGED_PUBLICATION");
  const deployment = validateDeployment(spec.deployment);
  if (deployment.mode !== mode) code("PUBLICATION_MODE_MISMATCH");
  if (mode === "live" && spec.approvedLiveWrite !== true)
    code("LIVE_WRITE_APPROVAL_REQUIRED");
  if (mode === "development" && spec.approvedLiveWrite !== false)
    code("INVALID_MANAGED_PUBLICATION");
  if (
    typeof spec.maxGasPriceWei !== "string" ||
    !/^[1-9][0-9]{0,20}$/.test(spec.maxGasPriceWei)
  )
    code("INVALID_MANAGED_PUBLICATION");
  const rpcUrl = validateRpc(spec.rpcUrl, mode);
  const budget =
    spec.budget ??
    (mode === "development"
      ? { maxTransactions: 64, maxTotalFeeWei: "1000000000000000000" }
      : null);
  if (
    !exact(budget, ["maxTransactions", "maxTotalFeeWei"]) ||
    !Number.isSafeInteger(budget.maxTransactions) ||
    budget.maxTransactions < 1 ||
    budget.maxTransactions > 64 ||
    typeof budget.maxTotalFeeWei !== "string" ||
    !/^[1-9][0-9]{0,20}$/.test(budget.maxTotalFeeWei)
  )
    code("PUBLICATION_BUDGET_REQUIRED");
  const signerFile = safeRel(spec.signerFile),
    journalDirectory = safeRel(spec.journalDirectory);
  if (
    journalDirectory === signerFile ||
    journalDirectory.startsWith(signerFile + "/") ||
    signerFile.startsWith(journalDirectory + "/")
  )
    code("UNSAFE_MANAGED_PATH");
  return Object.freeze({
    files: [signerFile],
    directories: [journalDirectory],
    async create() {
      let parsed;
      const signerPath = resolveManaged(root, signerFile);
      try {
        const { data } = readPrivateFile(signerPath, {
          maxBytes: 4096,
          code: "PRIVATE_PUBLICATION_SIGNER_REQUIRED",
        });
        try {
          parsed = JSON.parse(data.toString("utf8"));
        } finally {
          data.fill(0);
        }
      } catch (e) {
        if (e.code === "PRIVATE_PUBLICATION_SIGNER_REQUIRED") throw e;
        code("INVALID_PUBLICATION_SIGNER");
      }
      let provider, store, sink;
      try {
        if (
          !parsed ||
          typeof parsed.address !== "string" ||
          typeof parsed.privateKey !== "string" ||
          !Object.keys(parsed).every((k) =>
            ["address", "privateKey", "purpose"].includes(k),
          )
        )
          code("INVALID_PUBLICATION_SIGNER");
        const request = new FetchRequest(rpcUrl);
        request.timeout = 15000;
        provider = new JsonRpcProvider(request, undefined, {
          cacheTimeout: -1,
        });
        const wallet = new Wallet(parsed.privateKey, provider);
        if (
          wallet.address.toLowerCase() !== parsed.address.toLowerCase() ||
          wallet.address.toLowerCase() !== deployment.publisher.toLowerCase()
        )
          code("INVALID_PUBLICATION_SIGNER");
        store = createPublicationStore({
          directory: resolveManaged(root, journalDirectory),
        });
        let activeEntries;
        const boundedStore = {
          transact(fn, options) {
            return store.transact(async (data, save) => {
              activeEntries = data.entries;
              try {
                return await fn(data, save);
              } finally {
                activeEntries = undefined;
              }
            }, options);
          },
          close() {
            return store.close();
          },
        };
        const boundedSigner = {
          provider,
          getAddress: () => wallet.getAddress(),
          async signTransaction(tx) {
            if (!activeEntries) code("PUBLICATION_BUDGET_UNAVAILABLE");
            const previous = Object.values(activeEntries);
            const used = previous.reduce((total, e) => {
              const t = Transaction.from(e.raw);
              return total + t.gasLimit * (t.gasPrice ?? t.maxFeePerGas ?? 0n);
            }, 0n);
            if (
              previous.length >= budget.maxTransactions ||
              used + BigInt(tx.gasLimit) * BigInt(tx.gasPrice) >
                BigInt(budget.maxTotalFeeWei)
            )
              code("PUBLICATION_BUDGET_EXHAUSTED");
            return wallet.signTransaction(tx);
          },
        };
        sink = createEventSink({
          config: {
            enabled: true,
            deployment,
            maxGasPriceWei: spec.maxGasPriceWei,
            timeoutMs: 30000,
          },
          signer: boundedSigner,
          store: boundedStore,
        });
        let closed = false;
        return {
          async publish(args) {
            if (closed) code("PUBLICATION_CLOSED");
            ensureJournal(root, journalDirectory);
            return sink.publish(args);
          },
          async close() {
            if (closed) return;
            closed = true;
            try {
              await sink.close?.();
            } finally {
              await store.close?.();
              provider.destroy();
            }
          },
        };
      } catch {
        try {
          await sink?.close?.();
        } catch {}
        try {
          await store?.close?.();
        } catch {}
        provider?.destroy();
        code("INVALID_PUBLICATION_SIGNER");
      } finally {
        if (parsed && typeof parsed === "object") parsed.privateKey = "";
      }
    },
  });
}
