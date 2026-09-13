import { createRequire } from "node:module";
const require = createRequire(new URL("../packages/payments/package.json", import.meta.url).href);
const ethers = require("ethers");

const provider = new ethers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com", undefined, { cacheTimeout: -1 });
provider.timeout = 30_000;

const ROOT_REGISTRY = "0x8115186e8f2e0b0281e86ab91f0f48ba90364354";
const UNIVERSAL_RESOLVER = "0x4a1817d13e9cf196f471725176355c1234b63c70";
const RESOLVER_IMPL = "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e";

function namehash(name) {
  let node = ethers.ZeroHash;
  const labels = name.split(".").reverse();
  for (const label of labels) {
    const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
    node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], [node, labelHash]));
  }
  return node;
}

const NAMES = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];

// Try ENSv2-specific: maybe the names are subdomains of "ethonline-node-a.eth"
// Check the registry for the parent
const rootRegistryIface = new ethers.Interface([
  "function getExpiry(bytes32) view returns (uint64)",
  "function getResolver(bytes32) view returns (address)",
  "function ownerOf(bytes32) view returns (address)",
]);
const registry = new ethers.Contract(ROOT_REGISTRY, rootRegistryIface, provider);

// Universal Resolver
const universalIface = new ethers.Interface([
  "function addr(bytes32) view returns (address)",
  "function text(bytes32, string key) view returns (string)",
]);
const universal = new ethers.Contract(UNIVERSAL_RESOLVER, universalIface, provider);

// For ENSv2, getExpiry on the parent subdomain (e.g. service.ethonline-node-a)
// is the proper way to find ownership info
const subLabels = NAMES.map(n => n.split('.')[0]);

for (const name of NAMES) {
  const nh = namehash(name);
  console.log(`\n=== ${name} ===`);
  console.log(`namehash: ${nh}`);
  // Read getExpiry on the root domain
  for (const seg of name.split('.')) {
    const segNh = namehash(seg);
    try {
      const exp = await registry.getExpiry(segNh);
      console.log(`  getExpiry(${seg}): ${exp.toString()} (${exp === 0n ? 'no expiry' : new Date(Number(exp) * 1000).toISOString()})`);
    } catch (e) {
      console.log(`  getExpiry(${seg}): ERR`);
    }
  }
  // Try getResolver on the name
  try {
    const r = await registry.getResolver(nh);
    console.log(`  getResolver(${name}): ${r}`);
  } catch (e) {
    console.log(`  getResolver(${name}): ERR`);
  }
  // Universal Resolver: addr(node) returns the resolved address
  try {
    const a = await universal.addr(nh);
    console.log(`  universal.addr(${name}): ${a}`);
  } catch (e) {
    console.log(`  universal.addr: ERR`);
  }
}