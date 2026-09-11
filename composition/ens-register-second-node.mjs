// Owner-approved Wave 5 ENSv2 registration. Import/dry-run never loads a wallet
// or broadcasts. Exact signed bytes are journaled privately before submission.
import {
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  rmdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { artifact, sepolia } from "../packages/discovery/src/artifacts.mjs";
import { createEnsV2Discovery } from "../packages/discovery/src/index.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import {
  readPrivateFile,
  assertPrivateDirectory,
  assertSafeParent,
} from "../operations/src/private-files.mjs";
const {
  Contract,
  Interface,
  Wallet,
  JsonRpcProvider,
  FetchRequest,
  keccak256,
  ZeroAddress,
  ZeroHash,
  namehash,
} = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
)("ethers");
const vendor = JSON.parse(
  readFileSync(new URL("./vendor/wave5-ens.json", import.meta.url), "utf8"),
);
const names = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const rpcUrl = "https://ethereum-sepolia-rpc.publicnode.com";
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
function publicHttps(value) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      /^\d+\./.test(u.hostname) ||
      ["localhost", "[::1]"].includes(u.hostname)
    )
      fail("INVALID_ENS_ENDPOINT");
    return u.href.replace(/\/$/, "");
  } catch {
    fail("INVALID_ENS_ENDPOINT");
  }
}
export function buildEnsRecords({
  providerId,
  profileId,
  endpoint,
  historyUrl,
}) {
  if (!names.includes(providerId)) fail("EXACT_WAVE5_NAMES_REQUIRED");
  if (!/^sha256:[0-9a-f]{64}$/.test(profileId)) fail("INVALID_PROFILE");
  return {
    "ethonline.endpoint": publicHttps(endpoint),
    "ethonline.profiles": JSON.stringify([profileId]),
    "ethonline.payment.network": "non-economic",
    "ethonline.payment.asset": "none",
    "ethonline.payment.receiver": providerId,
    "ethonline.history": publicHttps(historyUrl),
  };
}
export function validateRegistrationPlan(plan) {
  if (plan?.chainId !== 11155111) fail("SEPOLIA_ONLY");
  if (plan.owner !== "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE")
    fail("DEDICATED_WALLET_REQUIRED");
  if (
    plan.providers?.length !== 2 ||
    plan.providers
      .map((p) => p.providerId)
      .sort()
      .join() !== names.join()
  )
    fail("EXACT_WAVE5_NAMES_REQUIRED");
  for (const p of plan.providers) buildEnsRecords(p);
  if (
    plan.perTransactionLimitWei !== "5000000000000000" ||
    plan.totalLimitWei !== "30000000000000000"
  )
    fail("BOUNDED_PHASE_REQUIRED");
  return structuredClone(plan);
}
export function boundedFee({ gas, gasPrice, used, perTransaction, total }) {
  const fee = gas * gasPrice;
  if (gas <= 0n || gasPrice <= 0n || fee > perTransaction)
    fail("TRANSACTION_BUDGET");
  if (used + fee > total) fail("PHASE_BUDGET");
  return fee;
}
const privateJson = (file) =>
  JSON.parse(
    readPrivateFile(resolve(file), {
      maxBytes: 1048576,
      code: "PRIVATE_INPUT_REQUIRED",
    }).data.toString("utf8"),
  );
export async function registerWave5({
  planFile,
  walletFile,
  journalDirectory,
  approved = false,
  execute = false,
}) {
  const plan = validateRegistrationPlan(privateJson(planFile));
  if (execute && (!approved || !walletFile || !journalDirectory))
    fail("EXPLICIT_OWNER_APPROVAL_REQUIRED");
  const transport = new FetchRequest(rpcUrl);
  transport.timeout = 15000;
  const provider = new JsonRpcProvider(transport, undefined, {
    cacheTimeout: -1,
  });
  let lock, state, save;
  try {
    if ((await provider.getNetwork()).chainId !== 11155111n)
      fail("SEPOLIA_ONLY");
    const abi = (name) => vendor.contracts[name]?.abi ?? artifact(name).abi;
    const deployed = (name) => vendor.contracts[name].address;
    const registrar = new Contract(
      deployed("ETHRegistrar"),
      abi("ETHRegistrar"),
      provider,
    );
    const eth = new Contract(
      deployed("ETHRegistry"),
      abi("ETHRegistry"),
      provider,
    );
    if (
      (await registrar.ETH_REGISTRY()).toLowerCase() !==
      deployed("ETHRegistry").toLowerCase()
    )
      fail("REGISTRAR_BINDING_MISMATCH");
    const duration = 31536000n;
    if (duration < (await registrar.MIN_REGISTER_DURATION()))
      fail("REGISTRATION_DURATION_UNSUPPORTED");
    const minimumAge = await registrar.MIN_COMMITMENT_AGE();
    if (minimumAge > 600n) fail("COMMITMENT_WAIT_REQUIRES_OWNER");
    const balance = await provider.getBalance(plan.owner);
    const preflight = {
      chainId: 11155111,
      owner: plan.owner,
      balanceWei: String(balance),
      minimumCommitmentAge: String(minimumAge),
      durationSeconds: String(duration),
      names: [],
    };
    for (const p of plan.providers) {
      const label = p.providerId.split(".")[1];
      const owner = await eth.findOwner(label);
      if (
        owner !== ZeroAddress &&
        owner.toLowerCase() !== plan.owner.toLowerCase()
      )
        fail("NAME_OWNED_BY_OTHER_ACCOUNT");
      const price = await registrar.getRegisterPrice(
        label,
        duration,
        deployed("MockUSDC"),
      );
      preflight.names.push({
        name: p.providerId,
        parentOwner: owner,
        available: await registrar.isAvailable(label),
        priceBaseUnits: String(price[0] + price[1]),
      });
    }
    if (!execute)
      return {
        status: "preflight",
        broadcast: false,
        walletLoaded: false,
        ...preflight,
      };
    if (balance < BigInt(plan.totalLimitWei))
      fail("WALLET_BELOW_PHASE_THRESHOLD");
    assertPrivateDirectory(dirname(resolve(walletFile)));
    const key = privateJson(walletFile);
    const wallet = new Wallet(key.privateKey, provider);
    if (wallet.address !== plan.owner || key.address !== plan.owner)
      fail("DEDICATED_WALLET_REQUIRED");
    const dir = resolve(journalDirectory);
    assertSafeParent(dir);
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    assertPrivateDirectory(dir);
    const proposedLock = dir + "/lock";
    mkdirSync(proposedLock, { mode: 0o700 });
    lock = proposedLock; // Remove only the lock this invocation actually acquired.
    const stateFile = dir + "/journal.json";
    state = existsSync(stateFile)
      ? privateJson(stateFile)
      : {
          version: "wave5-ens-journal-v1",
          planDigest: digestOf(plan),
          createdAt: new Date().toISOString(),
          entries: {},
          providers: {},
        };
    if (state.planDigest !== digestOf(plan)) fail("JOURNAL_PLAN_MISMATCH");
    save = () => {
      const temp = stateFile + ".tmp";
      writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temp, stateFile);
    };
    save();
    const used = () =>
      Object.values(state.entries).reduce(
        (sum, e) => sum + BigInt(e.maximumFeeWei),
        0n,
      );
    async function send(id, to, contractName, method, args) {
      const data = new Interface(abi(contractName)).encodeFunctionData(
        method,
        args,
      );
      const previous = state.entries[id];
      if (previous) {
        if (
          previous.to.toLowerCase() !== to.toLowerCase() ||
          previous.data !== data
        )
          fail("JOURNAL_CALL_MISMATCH");
        const receipt = await provider.getTransactionReceipt(previous.hash);
        if (!receipt || receipt.status !== 1)
          fail("TRANSACTION_UNRESOLVED_OWNER_RECONCILIATION_REQUIRED");
        Object.assign(previous, {
          status: "confirmed",
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          actualFeeWei: String(receipt.fee),
        });
        save();
        return receipt;
      }
      if (Object.keys(state.entries).length >= 20)
        fail("TRANSACTION_COUNT_LIMIT");
      const estimate = await provider.estimateGas({
        from: wallet.address,
        to,
        data,
        value: 0n,
      });
      const gasLimit = (estimate * 120n + 99n) / 100n;
      const fees = await provider.getFeeData();
      const gasPrice = (fees.gasPrice * 120n + 99n) / 100n;
      if (gasPrice > 3000000000n) fail("GAS_PRICE_ABOVE_PHASE_LIMIT");
      const maximumFee = boundedFee({
        gas: gasLimit,
        gasPrice,
        used: used(),
        perTransaction: BigInt(plan.perTransactionLimitWei),
        total: BigInt(plan.totalLimitWei),
      });
      const nonce = await provider.getTransactionCount(
        wallet.address,
        "pending",
      );
      const raw = await wallet.signTransaction({
        chainId: 11155111,
        type: 0,
        nonce,
        to,
        data,
        value: 0n,
        gasLimit,
        gasPrice,
      });
      const hash = keccak256(raw);
      state.entries[id] = {
        hash,
        to,
        data,
        nonce,
        gasLimit: String(gasLimit),
        gasPrice: String(gasPrice),
        maximumFeeWei: String(maximumFee),
        raw,
        status: "signed-not-confirmed",
      };
      save();
      console.log(
        JSON.stringify({
          operation: id,
          transactionHash: hash,
          phase: "signed-journaled",
        }),
      );
      const tx = await provider.broadcastTransaction(raw);
      const receipt = await tx.wait(1, 120000);
      if (!receipt || receipt.status !== 1) fail("TRANSACTION_NOT_CONFIRMED");
      Object.assign(state.entries[id], {
        status: "confirmed",
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        actualFeeWei: String(receipt.fee),
      });
      save();
      return receipt;
    }
    const factory = new Contract(
      sepolia.factory,
      abi("VerifiableFactory"),
      wallet,
    );
    const token = new Contract(deployed("MockUSDC"), abi("MockUSDC"), provider);
    const roles = BigInt("0x" + "1".repeat(64));
    for (const p of plan.providers) {
      const label = p.providerId.split(".")[1],
        records = buildEnsRecords(p);
      let node = state.providers[p.providerId];
      if (!node) {
        node = state.providers[p.providerId] = {
          salt: String(BigInt("0x" + randomBytes(16).toString("hex"))),
          secret: "0x" + randomBytes(32).toString("hex"),
        };
        save();
      }
      const resolverData = new Interface(
        abi("PermissionedResolverImpl"),
      ).encodeFunctionData("initialize", [
        wallet.address,
        16n | (16n << 128n),
        Object.entries(records).map(([k, v]) =>
          new Interface(abi("PermissionedResolverImpl")).encodeFunctionData(
            "setText",
            [namehash(p.providerId), k, v],
          ),
        ),
      ]);
      const registryData = new Interface(
        abi("UserRegistryImpl"),
      ).encodeFunctionData("initialize", [wallet.address, roles]);
      if (!node.resolver) {
        node.resolver = await factory.deployProxy.staticCall(
          sepolia.resolverImplementation,
          BigInt(node.salt),
          resolverData,
        );
        save();
      }
      await send(
        label + "-resolver",
        sepolia.factory,
        "VerifiableFactory",
        "deployProxy",
        [sepolia.resolverImplementation, BigInt(node.salt), resolverData],
      );
      if (!node.registry) {
        node.registry = await factory.deployProxy.staticCall(
          deployed("UserRegistryImpl"),
          BigInt(node.salt) + 1n,
          registryData,
        );
        save();
      }
      await send(
        label + "-registry",
        sepolia.factory,
        "VerifiableFactory",
        "deployProxy",
        [deployed("UserRegistryImpl"), BigInt(node.salt) + 1n, registryData],
      );
      if (
        (await factory.verifyContract(node.resolver)).toLowerCase() !==
          sepolia.resolverImplementation.toLowerCase() ||
        (await factory.verifyContract(node.registry)).toLowerCase() !==
          deployed("UserRegistryImpl").toLowerCase()
      )
        fail("PROXY_IMPLEMENTATION_MISMATCH");
      const actualOwner = await eth.findOwner(label);
      if (actualOwner === ZeroAddress) {
        const prices = await registrar.getRegisterPrice(
          label,
          duration,
          deployed("MockUSDC"),
        );
        const price = prices[0] + prices[1];
        if ((await token.balanceOf(wallet.address)) < price)
          await send(
            label + "-mint-test-usdc",
            deployed("MockUSDC"),
            "MockUSDC",
            "mint",
            [wallet.address, price],
          );
        if (
          (await token.allowance(wallet.address, deployed("ETHRegistrar"))) <
          price
        )
          await send(
            label + "-approve-test-usdc",
            deployed("MockUSDC"),
            "MockUSDC",
            "approve",
            [deployed("ETHRegistrar"), price],
          );
        const commitment = await registrar.makeCommitment(
          label,
          wallet.address,
          node.secret,
          node.registry,
          node.resolver,
          duration,
          ZeroHash,
        );
        await send(
          label + "-commit",
          deployed("ETHRegistrar"),
          "ETHRegistrar",
          "commit",
          [commitment],
        );
        const committedAt = await registrar.commitmentAt(commitment),
          maxAge = await registrar.MAX_COMMITMENT_AGE();
        const deadline = Date.now() + (Number(minimumAge) + 60) * 1000;
        while (
          (await provider.getBlock("latest")).timestamp <=
          Number(committedAt + minimumAge)
        ) {
          if (Date.now() > deadline) fail("COMMITMENT_WAIT_TIMEOUT");
          await delay(2000);
        }
        if (
          BigInt((await provider.getBlock("latest")).timestamp) >=
          committedAt + maxAge
        )
          fail("COMMITMENT_EXPIRED");
        await send(
          label + "-register",
          deployed("ETHRegistrar"),
          "ETHRegistrar",
          "register",
          [
            label,
            wallet.address,
            node.secret,
            node.registry,
            node.resolver,
            duration,
            deployed("MockUSDC"),
            ZeroHash,
          ],
        );
      } else if (
        actualOwner.toLowerCase() !== wallet.address.toLowerCase() ||
        (await eth.getSubregistry(label)).toLowerCase() !==
          node.registry.toLowerCase()
      )
        fail("EXISTING_PARENT_MISMATCH");
      const registry = new Contract(
        node.registry,
        abi("UserRegistryImpl"),
        provider,
      );
      await send(
        label + "-canonical-parent",
        node.registry,
        "UserRegistryImpl",
        "setParent",
        [deployed("ETHRegistry"), label],
      );
      const expiry = await eth.findExpiry(label);
      await send(
        label + "-service",
        node.registry,
        "UserRegistryImpl",
        "register",
        ["service", wallet.address, ZeroAddress, node.resolver, roles, expiry],
      );
    }
    const entries = Object.values(state.entries);
    const last = entries.reduce((a, b) =>
      a.blockNumber > b.blockNumber ? a : b,
    );
    const confirmed = await provider.waitForTransaction(last.hash, 12, 300000);
    if (
      !confirmed ||
      confirmed.status !== 1 ||
      (await confirmed.confirmations()) < 12
    )
      fail("CONFIRMATION_DEPTH_REQUIRED");
    const discovery = createEnsV2Discovery({
      inputs: { mode: "live", rpcUrl, names, timeoutMs: 15000 },
    });
    const listed = await discovery.list({
      names,
      signal: AbortSignal.timeout(30000),
    });
    if (listed.providers.length !== 2 || listed.errors.length)
      fail("LIVE_ENS_READBACK_FAILED");
    for (const p of listed.providers) {
      const expected = plan.providers.find(
        (x) => x.providerId === p.providerId,
      );
      if (
        !expected ||
        p.endpoint !== publicHttps(expected.endpoint) ||
        p.profileIds.join() !== expected.profileId ||
        p.historyEndpoint !== publicHttps(expected.historyUrl) ||
        p.paymentNetwork !== "non-economic"
      )
        fail("LIVE_ENS_RECORD_MISMATCH");
    }
    const result = {
      status: "passed",
      chainId: 11155111,
      observedAt: new Date().toISOString(),
      confirmedAtLeast: 12,
      owner: wallet.address,
      records: listed,
      proxies: Object.fromEntries(
        Object.entries(state.providers).map(([id, n]) => [
          id,
          { resolver: n.resolver, registry: n.registry },
        ]),
      ),
      transactions: Object.fromEntries(
        Object.entries(state.entries).map(([id, e]) => [
          id,
          {
            transactionHash: e.hash,
            blockNumber: e.blockNumber,
            blockHash: e.blockHash,
            actualFeeWei: e.actualFeeWei,
          },
        ]),
      ),
      maximumReservedFeeWei: String(used()),
      actualFeeWei: String(
        entries.reduce((n, e) => n + BigInt(e.actualFeeWei), 0n),
      ),
      inferenceVerified: false,
      publicServiceQualified: false,
    };
    state.result = result;
    save();
    return result;
  } catch (error) {
    if (state && save) {
      state.lastErrorCode =
        typeof error.code === "string" ? error.code : "ENS_REGISTRATION_FAILED";
      save();
    }
    throw error;
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
    const { values } = parseArgs({
      options: {
        plan: { type: "string" },
        wallet: { type: "string" },
        journal: { type: "string" },
        output: { type: "string" },
        execute: { type: "boolean" },
        approved: { type: "boolean" },
      },
    });
    const result = await registerWave5({
      planFile: values.plan,
      walletFile: values.wallet,
      journalDirectory: values.journal,
      approved: values.approved,
      execute: values.execute,
    });
    if (values.output)
      writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.code ?? "ENS_REGISTRATION_FAILED");
    process.exitCode = 1;
  }
}
