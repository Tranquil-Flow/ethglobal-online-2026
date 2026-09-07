import { rpcClient } from "../src/rpc.mjs";
import { artifact, sepolia } from "../src/artifacts.mjs";
import { keccak256 } from "viem";
// Read-only public endpoint; never wallet environment or credentials.
const c = rpcClient("https://ethereum-sepolia-rpc.publicnode.com", {
  mode: "live",
  timeoutMs: 10000,
});
try {
  const chainId = await c.getChainId();
  if (chainId !== 11155111) throw new Error("CHAIN_MISMATCH");
  const block = await c.getBlock();
  const root = await c.readContract({
    address: sepolia.universal,
    abi: artifact("UniversalResolverV2").abi,
    functionName: "ROOT_REGISTRY",
    blockNumber: block.number,
  });
  if (root.toLowerCase() !== sepolia.root.toLowerCase())
    throw new Error("ROOT_MISMATCH");
  const code = await c.getCode({
    address: sepolia.resolverImplementation,
    blockNumber: block.number,
  });
  if (!code || code === "0x") throw new Error("NO_CODE");
  if ((await c.getBlock({ blockNumber: block.number })).hash !== block.hash)
    throw new Error("REORG");
  console.log(
    JSON.stringify(
      {
        qualification:
          "read-only deployment observation, not provider or write qualification",
        chainId,
        blockNumber: String(block.number),
        blockHash: block.hash,
        universal: sepolia.universal,
        root,
        resolverImplementation: sepolia.resolverImplementation,
        observedResolverCodeHash: keccak256(code),
        rootMatches: true,
        sourceRevision: "97a57293f3b4279d94b571e678edb53ce62638f4",
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    JSON.stringify({
      status: "unverified",
      code: "READ_ONLY_DEPLOYMENT_CHECK_FAILED",
    }),
  );
  process.exitCode = 1;
}
