import {
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import { ContractFactory, keccak256 } from "ethers";
import YAML from "yaml";
import { compile } from "./compile.mjs";
import { validateDeployment } from "../src/config.mjs";
import { validateManifest } from "../src/manifest.mjs";
import { planOpenRegistryDeployment } from "../src/open-deployment.mjs";

function readOpenPlan(path) {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > 65536
    )
      throw Error("OPEN_DEPLOYMENT_INVALID");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    for (;;) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
      if (count === bytes.length) break;
    }
    const after = fstatSync(fd);
    if (
      count !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error("OPEN_DEPLOYMENT_INVALID");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
// Offline only; this tool has no RPC transport, wallet, credential lookup or broadcast branch.
try {
  if (process.argv[2] === "--open-plan") {
    const path = process.argv[3];
    if (!path || process.argv.length !== 4)
      throw new Error("OPEN_DEPLOYMENT_INVALID");
    const input = readOpenPlan(path);
    console.log(JSON.stringify(planOpenRegistryDeployment(input), null, 2));
  } else {
    // Legacy Registry v1 dry-run interface and byte generation remain unchanged.
    const input = JSON.parse(
      readFileSync(
        process.argv[2] ||
          new URL("../config/development.example.json", import.meta.url),
        "utf8",
      ),
    );
    const d = validateDeployment(input.deployment);
    if (process.argv[3])
      validateManifest(YAML.parse(readFileSync(process.argv[3], "utf8")), d);
    const compiled = compile();
    const factory = new ContractFactory(
      compiled.abi,
      compiled.evm.bytecode.object,
    );
    const tx = await factory.getDeployTransaction(
      d.publisher,
      d.mode === "development" ? 0 : 1,
    );
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          broadcast: false,
          mode: d.mode,
          chainId: d.chainId,
          publisher: d.publisher,
          creationDataHash: keccak256(tx.data),
          creationDataBytes: (tx.data.length - 2) / 2,
          expectedStartBlock: d.startBlock,
          warning:
            "Addresses and runtime hash must be replaced with actual approved deployment evidence. This is not a transaction or live qualification.",
        },
        null,
        2,
      ),
    );
  }
} catch {
  console.error("DEPLOYMENT_DRY_RUN_INVALID");
  process.exitCode = 1;
}
