import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const ethers = require("ethers");

const PROVIDER_IMPL = "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e";
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

// Sepolia deployer key (the one with 0.521 ETH)
const { privateKey: OPERATOR_KEY } = JSON.parse(
  readFileSync(join(homedir(), ".ethonline-testnet/sepolia-deployer.json"), "utf8"),
);const ADDRESS = "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(OPERATOR_KEY, provider);

const ABI = [
  "function setText(bytes32 node, string key, string value)",
  "function authorizeTextRoles(bytes toName, string key, address account, bool grant)",
  "function text(bytes32 node, string key) view returns (string)",
  "function roles(uint256 resource, address account) view returns (uint256)",
  "function ROOT_RESOURCE() view returns (uint256)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)",
  "function grantRoles(uint256 resource, uint256 roleBitmap, address account)",
  "function grantRootRoles(uint256 roleBitmap, address account)",
];

const contract = new ethers.Contract(PROVIDER_IMPL, ABI, wallet);

function namehash(name) {
  let node = "0x" + "00".repeat(32);
  for (const label of name.split(".").reverse()) {
    const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
    node = ethers.keccak256(ethers.concat([node, labelHash]));
  }
  return node;
}

function dnsEncode(name) {
  const labels = name.split(".");
  let parts = [];
  for (const label of labels) {
    const bytes = ethers.toUtf8Bytes(label);
    parts.push(new Uint8Array([bytes.length]));
    parts.push(bytes);
  }
  parts.push(new Uint8Array([0]));
  return ethers.hexlify(ethers.concat(parts));
}

console.log("Operator:", ADDRESS);
console.log("Balance:", ethers.formatEther(await provider.getBalance(ADDRESS)), "ETH");
console.log("Nonce:", await provider.getTransactionCount(ADDRESS));

const ROOT_RESOURCE = await contract.ROOT_RESOURCE();
console.log("ROOT_RESOURCE:", ROOT_RESOURCE.toString());

// Check root roles: bit 0 = ROOT_ROLES_ADMIN_ROLE (which can grant all)
// Actually look at the ROLE_BUNDLES
const ROLE_BUNDLES_ABI = [
  "function ROOT_ROLES_ADMIN_ROLE() view returns (uint256)",
  "function TEXT_WRITE_ROLE() view returns (uint256)",
];
const ROLE_BUNDLES_IFACE = new ethers.Interface([
  "function ROOT_ROLES_ADMIN_ROLE() view returns (uint256)",
  "function TEXT_WRITE_ROLE() view returns (uint256)",
]);
// Manually compute from common role constants
// ROOT_ROLES_ADMIN_ROLE = 1 << 0 (bit 0)
// TEXT_WRITE_ROLE = 1 << 16 (bit 16)
const ROLE_ROOT_ADMIN = 1n;
const ROLE_TEXT_WRITE = 1n << 16n;
const ROLE_ALL = 0xFFFFn;

const hasRootAdmin = await contract.hasRoles(ROOT_RESOURCE, ROLE_ROOT_ADMIN, ADDRESS);
console.log("hasRootRoles ROOT_ADMIN:", hasRootAdmin);
const hasText = await contract.hasRoles(ROOT_RESOURCE, ROLE_TEXT_WRITE, ADDRESS);
console.log("hasRootRoles TEXT_WRITE_ROOT:", hasText);

const names = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const result = { operator: ADDRESS, balance: ethers.formatEther(await provider.getBalance(ADDRESS)), ROOT_RESOURCE: ROOT_RESOURCE.toString() };

for (const name of names) {
  const nh = namehash(name);
  const dns = dnsEncode(name);
  const textRolesForName = await contract.hasRoles(BigInt(nh), ROLE_TEXT_WRITE, ADDRESS);
  const allRolesForName = await contract.roles(BigInt(nh), ADDRESS);
  console.log(`\n${name}:`);
  console.log("  namehash:", nh);
  console.log("  hasRoles TEXT_WRITE:", textRolesForName);
  console.log("  roles bitmap:", allRolesForName.toString());
  result[name] = { namehash: nh, dns, hasTextWrite: textRolesForName, allRoles: allRolesForName.toString() };
}

writeFileSync("/tmp/ens-state.json", JSON.stringify(result, null, 2));