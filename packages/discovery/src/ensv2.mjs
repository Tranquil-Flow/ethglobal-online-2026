import {
  toHex,
  namehash,
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  stringToHex,
  zeroAddress,
} from "viem";
import { packetToBytes } from "viem/ens";
import { artifact, sepolia } from "./artifacts.mjs";
import { normalizeName, RECORD_KEYS } from "./index.mjs";
import { safeUrl } from "./url-policy.mjs";
import { rpcClient } from "./rpc.mjs";
import { fail, bounded, DiscoveryError } from "./errors.mjs";
const ur = artifact("UniversalResolverV2").abi,
  pr = artifact("PermissionedResolverImpl").abi,
  registry = artifact("RootRegistry").abi;
const slot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export function createEnsV2Resolver({
  rpcUrl,
  mode,
  universal = sepolia.universal,
  root = sepolia.root,
  ttlMs = 30000,
  timeoutMs = 5000,
  clock = () => new Date(),
} = {}) {
  if (!["development", "live"].includes(mode)) fail("EXPLICIT_MODE_REQUIRED");
  safeUrl(rpcUrl, { mode, allowLoopback: mode === "development" });
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 60000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    fail("INVALID_CONFIG");
  if (
    mode === "live" &&
    (universal.toLowerCase() !== sepolia.universal.toLowerCase() ||
      root.toLowerCase() !== sepolia.root.toLowerCase())
  )
    fail("UNSUPPORTED_ROUTE");
  // RPC is explicit operator configuration, never a provider record. CCIP gateways are disabled:
  // this supported profile is direct, canonical ENSv2 PermissionedResolver records only.
  function client(signal) {
    return rpcClient(rpcUrl, { mode, signal, timeoutMs });
  }
  const adapter = {
    route: mode === "live" ? "ensv2-sepolia-onchain" : "ensv2-local-onchain",
    async isCanonical({ source, signal }) {
      return bounded(
        async (s) => {
          try {
            return (
              (
                await client(s).getBlock({
                  blockNumber: BigInt(source.blockNumber),
                })
              ).hash === source.blockHash
            );
          } catch {
            return false;
          }
        },
        signal,
        timeoutMs,
      );
    },
    async resolve({ name, signal }) {
      name = normalizeName(name);
      return bounded(
        async (s) => {
          try {
            const c = client(s),
              chainId = await c.getChainId();
            if (chainId !== (mode === "live" ? 11155111 : 31337))
              fail("CHAIN_MISMATCH");
            const block = await c.getBlock({ blockTag: "latest" }),
              blockNumber = block.number;
            const now = +clock();
            if (
              !block.hash ||
              blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
              Math.abs(now - Number(block.timestamp) * 1000) > 120000
            )
              fail("STALE_BLOCK");
            const read = (address, abi, functionName, args = []) =>
              c.readContract({ address, abi, functionName, args, blockNumber });
            if (
              (await read(universal, ur, "ROOT_REGISTRY")).toLowerCase() !==
              root.toLowerCase()
            )
              fail("UNSUPPORTED_ROUTE");
            const dns = toHex(packetToBytes(name));
            // Verify each containing registry bidirectionally; namespace aliases are not identities.
            const labels = name.split("."),
              canonicalRegistries = [];
            let expiresAt = now + ttlMs;
            for (let i = 0; i < labels.length; i++) {
              const parent = labels.slice(i + 1).join(".");
              const address = await read(
                universal,
                ur,
                "findCanonicalRegistry",
                [toHex(packetToBytes(parent))],
              );
              if (address === zeroAddress) fail("NONCANONICAL_NAME");
              const expiry = await read(address, registry, "getExpiry", [
                BigInt(keccak256(stringToHex(labels[i]))),
              ]);
              canonicalRegistries.push({
                label: labels[i],
                parent,
                registry: address,
                expiry: String(expiry),
              });
              expiresAt = Math.min(expiresAt, Number(expiry) * 1000);
            }
            if (expiresAt <= now) fail("EXPIRED_NAME");
            const [resolved, node, offset] = await read(
              universal,
              ur,
              "findResolver",
              [dns],
            );
            if (
              resolved === zeroAddress ||
              offset !== 0n ||
              node !== namehash(name)
            )
              fail("UNSUPPORTED_ROUTE");
            const implSlot = await c.getStorageAt({
              address: resolved,
              slot,
              blockNumber,
            });
            const impl = implSlot ? "0x" + implSlot.slice(-40) : zeroAddress;
            if (
              impl === zeroAddress ||
              (mode === "live" &&
                impl.toLowerCase() !==
                  sepolia.resolverImplementation.toLowerCase())
            )
              fail("UNSUPPORTED_RESOLVER");
            const alias = await read(resolved, pr, "getAlias", [dns]);
            if (alias !== "0x") fail("ALIAS_UNSUPPORTED");
            const records = {};
            for (const key of RECORD_KEYS) {
              const call = encodeFunctionData({
                abi: pr,
                functionName: "text",
                args: [namehash(name), key],
              });
              const [result, via] = await read(
                universal,
                ur,
                "resolveWithGateways",
                [dns, call, []],
              );
              if (
                via.toLowerCase() !== resolved.toLowerCase() ||
                result.length > 33000
              )
                fail("INVALID_RECORDS");
              records[key] = decodeFunctionResult({
                abi: pr,
                functionName: "text",
                data: result,
              });
            }
            const postReadBlock = await c.getBlock({ blockNumber });
            if (postReadBlock.hash !== block.hash) fail("REORG");
            return {
              name,
              mode,
              records,
              chainId: String(chainId),
              blockNumber: Number(blockNumber),
              blockHash: block.hash,
              resolvedAt: new Date(now).toISOString(),
              expiresAt: new Date(expiresAt).toISOString(),
              // These are observations from the gates above, not a second or
              // weaker resolution path. They let guarded operators retain
              // before/after evidence without reimplementing ENSv2 checks.
              verification: {
                universalResolver: universal,
                rootRegistry: root,
                dnsName: dns,
                node,
                wildcardOffset: String(offset),
                canonicalRegistries,
                resolver: resolved,
                resolverImplementation: impl,
                alias,
                postReadBlockHash: postReadBlock.hash,
              },
            };
          } catch (e) {
            if (e instanceof DiscoveryError) throw e;
            fail("UNAVAILABLE");
          }
        },
        signal,
        timeoutMs,
      );
    },
  };
  return adapter;
}
