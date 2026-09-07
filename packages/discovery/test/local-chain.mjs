import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createPublicClient,
  createWalletClient,
  http,
  zeroAddress,
  encodeFunctionData,
} from "viem";
import { artifact } from "../src/artifacts.mjs";
export async function localChain() {
  const child = spawn(
    process.execPath,
    [
      new URL("../node_modules/@foundry-rs/anvil/bin.mjs", import.meta.url)
        .pathname,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--accounts",
      "3",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "exit");
  let url;
  async function close() {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    if (url) {
      let reachable = false;
      try {
        await fetch(url, { signal: AbortSignal.timeout(250) });
        reachable = true;
      } catch {}
      if (reachable)
        throw new Error("Owned Anvil RPC remains reachable after cleanup");
    }
  }
  try {
    url = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(
        () => reject(new Error("Anvil startup timeout")),
        10000,
      );
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Anvil exited"));
      });
      child.stdout.on("data", (buf) => {
        text = (text + buf.toString()).slice(-20000);
        const m = text.match(/Listening on (127\.0\.0\.1:\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve("http://" + m[1]);
          text = "";
        }
      });
      child.stderr.resume();
    });
    const chain = {
      id: 31337,
      name: "Local development only",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [url] } },
    };
    const client = createPublicClient({
      chain,
      transport: http(url, { retryCount: 0, timeout: 5000 }),
      ccipRead: false,
      pollingInterval: 10,
    });
    const accounts = await client.request({ method: "eth_accounts" });
    const wallet = createWalletClient({
      chain,
      account: accounts[0],
      transport: http(url, { retryCount: 0 }),
    });
    const delegate = createWalletClient({
      chain,
      account: accounts[1],
      transport: http(url, { retryCount: 0 }),
    });
    async function sent(hash) {
      const r = await client.waitForTransactionReceipt({
        hash,
        timeout: 10000,
      });
      if (r.status !== "success")
        throw Object.assign(new Error("Local transaction reverted"), {
          code: "LOCAL_REVERT",
          receipt: r,
        });
      return r;
    }
    async function deploy(name, args = []) {
      const a = artifact(name);
      return (
        await sent(
          await wallet.deployContract({
            abi: a.abi,
            bytecode: a.bytecode,
            args,
          }),
        )
      ).contractAddress;
    }
    async function write(address, name, fn, args, who = wallet) {
      return sent(
        await who.writeContract({
          address,
          abi: artifact(name).abi,
          functionName: fn,
          args,
        }),
      );
    }
    const roles = BigInt("0x" + "1".repeat(64));
    const labels = await deploy("LabelStore", [zeroAddress]);
    const root = await deploy("RootRegistry", [labels, accounts[0], roles]);
    const eth = await deploy("RootRegistry", [labels, accounts[0], roles]);
    const parent = await deploy("RootRegistry", [labels, accounts[0], roles]);
    const implementation = await deploy("PermissionedResolverImpl", [
      accounts[0],
    ]);
    const factory = await deploy("VerifiableFactory");
    const data = encodeFunctionData({
      abi: artifact("PermissionedResolverImpl").abi,
      functionName: "initialize",
      args: [accounts[0], roles, []],
    });
    const sim = await client.simulateContract({
      address: factory,
      abi: artifact("VerifiableFactory").abi,
      functionName: "deployProxy",
      args: [implementation, 0n, data],
      account: accounts[0],
    });
    const resolver = sim.result;
    await sent(await wallet.writeContract(sim.request));
    const expiry = (await client.getBlock()).timestamp + 3600n;
    await write(root, "RootRegistry", "register", [
      "eth",
      accounts[0],
      eth,
      zeroAddress,
      roles,
      expiry,
    ]);
    await write(eth, "RootRegistry", "setParent", [root, "eth"]);
    await write(eth, "RootRegistry", "register", [
      "example",
      accounts[0],
      parent,
      zeroAddress,
      roles,
      expiry,
    ]);
    await write(parent, "RootRegistry", "setParent", [eth, "example"]);
    await write(parent, "RootRegistry", "register", [
      "worker",
      accounts[0],
      zeroAddress,
      resolver,
      roles,
      expiry,
    ]);
    const universal = await deploy("UniversalResolverV2", [
      root,
      zeroAddress,
      zeroAddress,
    ]);
    return {
      url,
      client,
      wallet,
      delegate,
      accounts,
      root,
      eth,
      parent,
      resolver,
      implementation,
      factory,
      universal,
      write,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
