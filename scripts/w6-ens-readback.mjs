import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const ethers = require("ethers");

const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", undefined, { cacheTimeout: -1 });
provider.timeout = 30_000;

const NAMES = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const RESOLVER_IMPL = "0x4a1817d13e9cf196f471725176355c1234b63c70"; // Permissioned Resolver Impl

// Get namehash
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
  "function ownerOf(bytes32 node) view returns (address)",
  "function getRoles(bytes32 node, address account) view returns (uint256)",
]);
const resolver = new ethers.Contract(RESOLVER_IMPL, resolverIface, provider);

const KEY_IDS = ["ethonline.endpoint", "ethonline.profiles", "ethonline.payment.network", "ethonline.payment.asset", "ethonline.payment.receiver", "ethonline.history"];
const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN = 1n << 0n;
const TEXT_ROLES = [
  1n << 16n, // ENDPOINT
  1n << 17n, // PROFILES
  1n << 18n, // PAYMENT_NETWORK
  1n << 19n, // PAYMENT_ASSET
  1n << 20n, // PAYMENT_RECEIVER
  1n << 21n, // HISTORY
];

const ownerAddress = "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE";
for (const name of NAMES) {
  const nh = namehash(name);
  console.log(`\n=== ${name} ===`);
  console.log(`namehash: ${nh}`);
  let owner = "0x";
  let adminRoles = 0n;
  let textRoles = 0n;
  try {
    owner = await resolver.ownerOf(nh);
    console.log(`ownerOf: ${owner}`);
  } catch (e) {
    console.log(`ownerOf err: ${e.message?.slice(0,100)}`);
  }
  try {
    adminRoles = await resolver.getRoles(nh, ownerAddress);
    console.log(`getRoles(${ownerAddress}): ${adminRoles.toString()}`);
    console.log(`  ADMIN bit (1<<0): ${(adminRoles & ADMIN) !== 0n}`);
    for (let i = 0; i < TEXT_ROLES.length; i++) {
      const has = (adminRoles & TEXT_ROLES[i]) !== 0n;
      console.log(`  ${KEY_IDS[i]} bit (${TEXT_ROLES[i]}): ${has}`);
    }
  } catch (e) {
    console.log(`getRoles err: ${e.message?.slice(0,100)}`);
  }
  for (const key of KEY_IDS) {
    let value = "";
    try {
      value = await resolver.text(nh, key);
    } catch (e) {}
    console.log(`  ${key}: ${value?.slice(0,80)}`);
  }
}