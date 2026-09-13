import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const ethers = require("ethers");

const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", undefined, { cacheTimeout: -1 });
provider.timeout = 30_000;

const RESOLVER_IMPL = "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e";
const ZERO = "0x0000000000000000000000000000000000000000";

function namehash(name) {
  let node = ethers.ZeroHash;
  const labels = name.split(".").reverse();
  for (const label of labels) {
    const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
    node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [node, labelHash]));
  }
  return node;
}

const resolverIface = new ethers.Interface([
  "function text(bytes32 node, string key) view returns (string)",
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
]);
const resolver = new ethers.Contract(RESOLVER_IMPL, resolverIface, provider);

const NAMES = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const KEYS = ["ethonline.endpoint","ethonline.profiles","ethonline.payment.network","ethonline.payment.asset","ethonline.payment.receiver","ethonline.history"];
const CANDIDATE_OWNERS = [
  "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE",
  "0x3059a3a2BE58717380A3662eECF68bbd1143359B",
  ZERO,
];

for (const name of NAMES) {
  const nh = namehash(name);
  console.log(`\n=== ${name} ===`);
  console.log(`namehash: ${nh}`);
  // Read current records
  for (const key of KEYS) {
    try {
      const value = await resolver.text(nh, key);
      console.log(`  ${key}: ${value?.slice(0,80)}`);
    } catch (e) {
      console.log(`  ${key}: ERR ${e.message?.slice(0,80)}`);
    }
  }
  // Read roles for each candidate owner
  for (const owner of CANDIDATE_OWNERS) {
    if (owner === ZERO) continue;
    try {
      const r = await resolver.roles(nh, owner);
      console.log(`  roles(${owner.slice(0,10)}...): ${r.toString()}`);
    } catch (e) {
      console.log(`  roles(${owner.slice(0,10)}...): ERR ${e.message?.slice(0,80)}`);
    }
  }
}