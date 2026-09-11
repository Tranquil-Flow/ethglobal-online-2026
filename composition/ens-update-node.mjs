// Explicit read-only preview / approved profile-record update for the two Wave 5 names.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import {
  previewOperation,
  createEnsV2Discovery,
} from "../packages/discovery/src/index.mjs";
import {
  readPrivateFile,
  assertPrivateDirectory,
} from "../operations/src/private-files.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import { boundedFee } from "./ens-register-second-node.mjs";
const { Wallet, JsonRpcProvider, FetchRequest, keccak256 } = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
)("ethers");
const rpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";
const names = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export function validateNodeUpdate(plan) {
  if (
    !plan ||
    Object.keys(plan).sort().join() !==
      ["chainId", "owner", "nodes"].sort().join() ||
    !Array.isArray(plan.nodes) ||
    plan.nodes.some(
      (n) =>
        !n ||
        Object.keys(n).sort().join() !==
          ["providerId", "profileId"].sort().join(),
    )
  )
    fail("UNEXPECTED_UPDATE_FIELD");
  if (
    plan?.owner !== "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE" ||
    plan.chainId !== 11155111
  )
    fail("SEPOLIA_OWNER_REQUIRED");
  if (
    plan.nodes?.length !== 2 ||
    plan.nodes
      .map((n) => n.providerId)
      .sort()
      .join() !== names.join()
  )
    fail("EXACT_WAVE5_NAMES_REQUIRED");
  if (plan.nodes.some((n) => !/^sha256:[0-9a-f]{64}$/.test(n.profileId)))
    fail("PROFILE_DIGEST_REQUIRED");
  return structuredClone(plan);
}
export async function updateNodeRecords({
  plan: input,
  execute = false,
  approved = false,
  walletFile,
  journalDirectory,
}) {
  const plan = validateNodeUpdate(input);
  if (execute && (!approved || !walletFile || !journalDirectory))
    fail("EXPLICIT_OWNER_APPROVAL_REQUIRED");
  const previews = [];
  for (const n of plan.nodes)
    previews.push(
      await previewOperation({
        mode: "live",
        rpcUrl,
        owner: plan.owner,
        name: n.providerId,
        operation: "update",
        records: { "ethonline.profiles": JSON.stringify([n.profileId]) },
        signal: AbortSignal.timeout(20000),
      }),
    );
  if (!execute) return { status: "preflight", broadcast: false, previews };
  const request = new FetchRequest(rpcUrl);
  request.timeout = 15000;
  const provider = new JsonRpcProvider(request, undefined, {
    cacheTimeout: -1,
  });
  let lock;
  try {
    if ((await provider.getNetwork()).chainId !== 11155111n)
      fail("SEPOLIA_ONLY");
    assertPrivateDirectory(dirname(resolve(walletFile)));
    const key = JSON.parse(
      readPrivateFile(resolve(walletFile), {
        maxBytes: 8192,
        code: "PRIVATE_WALLET_REQUIRED",
      }).data.toString("utf8"),
    );
    const wallet = new Wallet(key.privateKey, provider);
    if (wallet.address !== plan.owner || key.address !== plan.owner)
      fail("DEDICATED_WALLET_REQUIRED");
    const dir = resolve(journalDirectory);
    assertPrivateDirectory(dirname(dir));
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    assertPrivateDirectory(dir);
    mkdirSync(dir + "/lock", { mode: 0o700 });
    lock = dir + "/lock";
    const path = dir + "/journal.json";
    const state = existsSync(path)
      ? JSON.parse(
          readPrivateFile(path, {
            maxBytes: 1048576,
            code: "PRIVATE_JOURNAL_REQUIRED",
          }).data.toString("utf8"),
        )
      : { planDigest: digestOf(plan), entries: [] };
    if (state.planDigest !== digestOf(plan)) fail("JOURNAL_PLAN_MISMATCH");
    const save = () => {
      writeFileSync(path + ".tmp", JSON.stringify(state, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(path + ".tmp", path);
    };
    for (const [i, preview] of previews.entries()) {
      if (preview.chainId !== 11155111 || preview.transactions.length !== 1)
        fail("UNEXPECTED_UPDATE_PREVIEW");
      const tx = preview.transactions[0];
      if (
        tx.value !== "0" ||
        tx.to.toLowerCase() !== preview.resolver.toLowerCase()
      )
        fail("UNEXPECTED_UPDATE_PREVIEW");
      let entry = state.entries[i];
      if (!entry) {
        const gasLimit =
          ((await provider.estimateGas({ ...tx, from: wallet.address })) *
            12n) /
            10n +
          1n;
        const gasPrice =
          ((await provider.getFeeData()).gasPrice * 12n) / 10n + 1n;
        if (gasPrice > 3000000000n) fail("GAS_PRICE_ABOVE_PHASE_LIMIT");
        const fee = boundedFee({
          gas: gasLimit,
          gasPrice,
          used: state.entries.reduce((a, e) => a + BigInt(e.maximumFeeWei), 0n),
          perTransaction: 5000000000000000n,
          total: 10000000000000000n,
        });
        if ((await provider.getBalance(wallet.address)) < fee)
          fail("WALLET_BELOW_UPDATE_THRESHOLD");
        const nonce = await provider.getTransactionCount(
          wallet.address,
          "pending",
        );
        const raw = await wallet.signTransaction({
          ...tx,
          value: 0n,
          chainId: 11155111,
          type: 0,
          nonce,
          gasLimit,
          gasPrice,
        });
        entry = {
          name: preview.name,
          to: tx.to,
          data: tx.data,
          hash: keccak256(raw),
          raw,
          maximumFeeWei: String(fee),
          nonce,
        };
        state.entries.push(entry);
        save();
        console.log(
          JSON.stringify({
            providerId: preview.name,
            transactionHash: entry.hash,
            status: "signed-journaled",
          }),
        );
        await (await provider.broadcastTransaction(raw)).wait(1, 120000);
      } else if (entry.to !== tx.to || entry.data !== tx.data)
        fail("JOURNAL_UPDATE_MISMATCH");
      const receipt = await provider.getTransactionReceipt(entry.hash);
      if (!receipt || receipt.status !== 1)
        fail("UPDATE_UNRESOLVED_OWNER_RECONCILIATION_REQUIRED");
      Object.assign(entry, {
        status: 1,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        feeWei: String(receipt.fee),
      });
      save();
    }
    const last = state.entries.at(-1);
    const receipt = await provider.waitForTransaction(last.hash, 12, 300000);
    if (!receipt || (await receipt.confirmations()) < 12)
      fail("CONFIRMATION_DEPTH_REQUIRED");
    const records = await createEnsV2Discovery({
      inputs: { mode: "live", rpcUrl, names, timeoutMs: 15000 },
    }).list({ names, signal: AbortSignal.timeout(30000) });
    if (records.providers.length !== 2 || records.errors.length)
      fail("LIVE_ENS_READBACK_FAILED");
    for (const n of plan.nodes)
      if (
        records.providers
          .find((p) => p.providerId === n.providerId)
          ?.profileIds.join() !== n.profileId
      )
        fail("ENS_PROFILE_MISMATCH");
    return {
      status: "passed",
      observedAt: new Date().toISOString(),
      chainId: 11155111,
      confirmedAtLeast: 12,
      records,
      transactions: state.entries.map(({ raw, data, ...e }) => e),
      inferenceVerified: false,
      endpointPolicy:
        "Shared HTTPS gateway; laptop execution is profile-bound, not a private-IP public URL",
    };
  } finally {
    if (lock) rmdirSync(lock);
    provider.destroy();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values: v } = parseArgs({
      options: {
        plan: { type: "string" },
        execute: { type: "boolean" },
        approved: { type: "boolean" },
        wallet: { type: "string" },
        journal: { type: "string" },
        output: { type: "string" },
      },
    });
    const plan = JSON.parse(
      readPrivateFile(resolve(v.plan), {
        maxBytes: 65536,
        code: "PRIVATE_PLAN_REQUIRED",
      }).data.toString("utf8"),
    );
    const result = await updateNodeRecords({
      plan,
      execute: v.execute,
      approved: v.approved,
      walletFile: v.wallet,
      journalDirectory: v.journal,
    });
    if (v.output)
      writeFileSync(v.output, JSON.stringify(result, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.code ?? "ENS_UPDATE_FAILED");
    process.exitCode = 1;
  }
}
