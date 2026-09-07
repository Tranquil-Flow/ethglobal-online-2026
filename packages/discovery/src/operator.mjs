import {
  encodeFunctionData,
  isAddress,
  namehash,
  toHex,
  zeroAddress,
} from "viem";
import { packetToBytes } from "viem/ens";
import { artifact, sepolia } from "./artifacts.mjs";
import { rpcClient } from "./rpc.mjs";
import { normalizeName, RECORD_KEYS } from "./index.mjs";
import { safeUrl } from "./url-policy.mjs";
import { bounded, fail, DiscoveryError } from "./errors.mjs";
export const SERVICE_KEYS = ["ethonline.endpoint", "ethonline.profiles"];
const pr = artifact("PermissionedResolverImpl").abi,
  ur = artifact("UniversalResolverV2").abi;
function checkRecords(records, mode, provision = false) {
  if (
    !records ||
    typeof records !== "object" ||
    Array.isArray(records) ||
    !Object.keys(records).length
  )
    fail("INVALID_RECORDS");
  for (const [k, v] of Object.entries(records)) {
    if (!(provision ? RECORD_KEYS : SERVICE_KEYS).includes(k))
      fail("UNOWNED_RECORD");
    if (typeof v !== "string" || !v.length || v.length > 16384)
      fail("INVALID_RECORDS");
    if (k === "ethonline.endpoint" || k === "ethonline.history")
      safeUrl(v, { mode, allowLoopback: mode === "development" });
    else if (k === "ethonline.profiles") {
      let ids;
      try {
        ids = JSON.parse(v);
      } catch {
        fail("INVALID_RECORDS");
      }
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 128 ||
        ids.some(
          (x) => typeof x !== "string" || !/^sha256:[0-9a-f]{64}$/.test(x),
        ) ||
        new Set(ids).size !== ids.length
      )
        fail("INVALID_RECORDS");
    } else if (v.length > 256) fail("INVALID_RECORDS");
  }
  if (
    provision &&
    RECORD_KEYS.slice(0, 5).some((k) => !Object.hasOwn(records, k))
  )
    fail("INVALID_RECORDS");
}
// Returns unsigned previews only. It has no wallet, key loader or broadcast method.
export async function previewOperation({
  rpcUrl,
  mode,
  name,
  owner,
  actor = owner,
  delegate,
  operation,
  records,
  universal = sepolia.universal,
  root = sepolia.root,
  factory = sepolia.factory,
  implementation = sepolia.resolverImplementation,
  salt = "0",
  expiry,
  signal,
} = {}) {
  name = normalizeName(name);
  if (!["live", "development"].includes(mode)) fail("EXPLICIT_MODE_REQUIRED");
  if (
    !isAddress(owner) ||
    owner === zeroAddress ||
    !["provision", "grant", "revoke", "update"].includes(operation)
  )
    fail("INVALID_OPERATION");
  if (
    !isAddress(actor) ||
    (operation !== "update" && actor.toLowerCase() !== owner.toLowerCase())
  )
    fail("INVALID_ACTOR");
  if (
    ["grant", "revoke", "provision"].includes(operation) &&
    (!isAddress(delegate) ||
      delegate === zeroAddress ||
      delegate.toLowerCase() === owner.toLowerCase())
  )
    fail("INVALID_DELEGATE");
  if (operation === "update" || operation === "provision")
    checkRecords(records, mode, operation === "provision");
  safeUrl(rpcUrl, { mode, allowLoopback: mode === "development" });
  if (
    mode === "live" &&
    [universal, root, factory, implementation].some(
      (v, i) =>
        v.toLowerCase() !==
        [
          sepolia.universal,
          sepolia.root,
          sepolia.factory,
          sepolia.resolverImplementation,
        ][i].toLowerCase(),
    )
  )
    fail("UNSUPPORTED_ROUTE");
  return bounded(
    async (inner) => {
      try {
        const c = rpcClient(rpcUrl, { mode, signal: inner });
        const chainId = await c.getChainId();
        if (chainId !== (mode === "live" ? 11155111 : 31337))
          fail("CHAIN_MISMATCH");
        const block = await c.getBlock();
        const read = (address, abi, functionName, args = []) =>
          c.readContract({
            address,
            abi,
            functionName,
            args,
            blockNumber: block.number,
          });
        if (
          (await read(universal, ur, "ROOT_REGISTRY")).toLowerCase() !==
          root.toLowerCase()
        )
          fail("UNSUPPORTED_ROUTE");
        const dns = toHex(packetToBytes(name)),
          transactions = [];
        const tx = (to, abi, functionName, args) => ({
          to,
          data: encodeFunctionData({ abi, functionName, args }),
          value: "0",
        });
        let resolver;
        if (operation === "provision") {
          if (
            typeof salt !== "string" ||
            !/^(0|[1-9][0-9]{0,76})$/.test(salt) ||
            typeof expiry !== "string" ||
            !/^[0-9]{1,12}$/.test(expiry) ||
            BigInt(expiry) <= block.timestamp ||
            BigInt(expiry) > block.timestamp + 31536000n
          )
            fail("INVALID_PROVISION");
          const parentName = name.split(".").slice(1).join(".");
          const parent = await read(universal, ur, "findCanonicalRegistry", [
            toHex(packetToBytes(parentName)),
          ]);
          if (parent === zeroAddress) fail("PARENT_REGISTRY_REQUIRED");
          const parentOwner = await read(universal, ur, "findOwner", [
            toHex(packetToBytes(parentName)),
          ]);
          if (parentOwner.toLowerCase() !== owner.toLowerCase())
            fail("OWNER_MISMATCH");
          const existing = await read(universal, ur, "findOwner", [dns]);
          if (existing !== zeroAddress) fail("NAME_EXISTS");
          // In initialize.multicall the original sender is preserved. Give only text setter/admin
          // roles to the owner (not upgrade/alias/clear), then delegate individual service keys.
          const setters = Object.entries(records).map(([k, v]) =>
            encodeFunctionData({
              abi: pr,
              functionName: "setText",
              args: [namehash(name), k, v],
            }),
          );
          const role = 16n | (16n << 128n);
          const data = encodeFunctionData({
            abi: pr,
            functionName: "initialize",
            args: [owner, role, setters],
          });
          const args = [implementation, BigInt(salt), data];
          const simulation = await c.simulateContract({
            address: factory,
            abi: artifact("VerifiableFactory").abi,
            functionName: "deployProxy",
            args,
            account: owner,
          });
          resolver = simulation.result;
          if ((await c.getCode({ address: resolver }))?.length > 2)
            fail("RESOLVER_ALREADY_EXISTS");
          transactions.push(
            tx(factory, artifact("VerifiableFactory").abi, "deployProxy", args),
          );
          // The owner receives documented administrative roles for this new name only.
          const nameRoles =
            (1n << 20n) |
            (1n << 24n) |
            (1n << 148n) |
            (1n << 152n) |
            (1n << 156n);
          const registerArgs = [
            name.split(".")[0],
            owner,
            zeroAddress,
            resolver,
            nameRoles,
            BigInt(expiry),
          ];
          await c.simulateContract({
            address: parent,
            abi: artifact("RootRegistry").abi,
            functionName: "register",
            args: registerArgs,
            account: owner,
          });
          transactions.push(
            tx(parent, artifact("RootRegistry").abi, "register", registerArgs),
          );
          for (const k of SERVICE_KEYS)
            transactions.push(
              tx(resolver, pr, "authorizeTextRoles", [dns, k, delegate, true]),
            );
        } else {
          const actualOwner = await read(universal, ur, "findOwner", [dns]);
          if (actualOwner.toLowerCase() !== owner.toLowerCase())
            fail("OWNER_MISMATCH");
          const found = await read(universal, ur, "findResolver", [dns]);
          resolver = found[0];
          if (resolver === zeroAddress || found[2] !== 0n)
            fail("UNSUPPORTED_ROUTE");
          if ((await read(resolver, pr, "getAlias", [dns])) !== "0x")
            fail("ALIAS_UNSUPPORTED");
          const changes =
            operation === "update"
              ? Object.entries(records).map(([k, v]) => [
                  "setText",
                  [namehash(name), k, v],
                ])
              : SERVICE_KEYS.map((k) => [
                  "authorizeTextRoles",
                  [dns, k, delegate, operation === "grant"],
                ]);
          for (const [fn, args] of changes) {
            await c.simulateContract({
              address: resolver,
              abi: pr,
              functionName: fn,
              args,
              account: actor,
            });
            transactions.push(tx(resolver, pr, fn, args));
          }
        }
        if (
          (await c.getBlock({ blockNumber: block.number })).hash !== block.hash
        )
          fail("REORG");
        return {
          version: "1",
          mode,
          operation,
          name,
          chainId,
          from: actor,
          resolver,
          broadcast: false,
          approvalRequired: mode === "live",
          blockNumber: String(block.number),
          blockHash: block.hash,
          transactions,
          warnings: [
            "Unsigned preview; recheck chain, ownership, expiry and permissions before each transaction.",
            "Provision grant calls depend on deployment; partial completion requires owner recovery.",
            "Namespace integrity is not execution honesty, payment settlement or assessment proof.",
          ],
        };
      } catch (e) {
        if (e instanceof DiscoveryError) throw e;
        fail("OPERATION_UNAVAILABLE");
      }
    },
    signal,
    15000,
  );
}
