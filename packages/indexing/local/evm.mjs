import { spawn } from "node:child_process";
import { once } from "node:events";
import { JsonRpcProvider, HDNodeWallet, ContractFactory } from "ethers";
import { compileAll } from "../scripts/compile.mjs";

const mnemonic = "test test test test test test test test test test test junk";

/** Start an owned Anvil process and deploy a synthetic development Registry. */
export async function startLocalEvm() {
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
      "2",
      "--chain-id",
      "31337",
      "--hardfork",
      "shanghai",
      "--gas-limit",
      "12000000",
      "--mnemonic",
      mnemonic,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "exit");
  let output = "",
    url,
    port;
  try {
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("ANVIL_STARTUP_TIMEOUT")),
        10000,
      );
      const inspect = (buf) => {
        output = (output + buf.toString()).slice(-20000);
        const match = output.match(/Listening on (127\.0\.0\.1:(\d+))/);
        if (match) {
          clearTimeout(timer);
          port = Number(match[2]);
          resolve("http://" + match[1]);
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`ANVIL_EXITED:${code ?? signal}`));
      });
    });
    const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
    await provider.getNetwork();
    const signer = HDNodeWallet.fromPhrase(
      mnemonic,
      undefined,
      "m/44'/60'/0'/0/0",
    ).connect(provider);
    const stranger = HDNodeWallet.fromPhrase(
      mnemonic,
      undefined,
      "m/44'/60'/0'/0/1",
    ).connect(provider);
    const compiled = compileAll(),
      c = compiled.Registry,
      registry = await new ContractFactory(
        c.abi,
        c.evm.bytecode.object,
        signer,
      ).deploy(signer.address, 0);
    await registry.waitForDeployment();
    const openCompiled = compiled.RegistryV2,
      openRegistry = await new ContractFactory(
        openCompiled.abi,
        openCompiled.evm.bytecode.object,
        signer,
      ).deploy(0);
    await openRegistry.waitForDeployment();
    const server = {
      address() {
        return { address: "127.0.0.1", port };
      },
    };
    return {
      server,
      url,
      provider,
      signer,
      stranger,
      registry,
      openRegistry,
      abi: c.abi,
      anvilVersion: "1.7.1",
      async close() {
        provider.destroy();
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          const force = setTimeout(() => child.kill("SIGKILL"), 2000);
          try {
            await closed;
          } finally {
            clearTimeout(force);
          }
        }
        try {
          await fetch(url, { signal: AbortSignal.timeout(250) });
          throw new Error("OWNED_ANVIL_REMAINS_REACHABLE");
        } catch (error) {
          if (error.message === "OWNED_ANVIL_REMAINS_REACHABLE") throw error;
        }
      },
    };
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    throw error;
  }
}
