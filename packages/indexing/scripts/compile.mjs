import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function source(name) {
  return {
    content: readFileSync(
      new URL(`../contracts/${name}`, import.meta.url),
      "utf8",
    ),
  };
}

function compileDetailed() {
  const solc = require("solc");
  const input = {
    language: "Solidity",
    sources: {
      "Registry.sol": source("Registry.sol"),
      "RegistryV2.sol": source("RegistryV2.sol"),
    },
    settings: {
      evmVersion: "shanghai",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "": ["ast"],
          "*": [
            "abi",
            "metadata",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "evm.deployedBytecode.immutableReferences",
          ],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((x) => x.severity === "error");
  if (errors.length)
    throw new Error(errors.map((x) => x.formattedMessage).join("\n"));
  return {
    contracts: {
      Registry: output.contracts["Registry.sol"].Registry,
      RegistryV2: output.contracts["RegistryV2.sol"].RegistryV2,
    },
    sources: input.sources,
    sourceOutputs: output.sources,
    compilerVersion: solc.version(),
    settings: input.settings,
  };
}

export function compileAllWithMetadata() {
  return compileDetailed();
}

export function compileAll() {
  return compileDetailed().contracts;
}
export function compile() {
  return compileAll().Registry;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const all = compileAll();
  mkdirSync(new URL("../build/", import.meta.url), { recursive: true });
  mkdirSync(new URL("../subgraph/abis/", import.meta.url), { recursive: true });
  for (const [name, c] of Object.entries(all)) {
    writeFileSync(
      new URL(`../build/${name}.json`, import.meta.url),
      JSON.stringify(c, null, 2) + "\n",
    );
    writeFileSync(
      new URL(`../subgraph/abis/${name}.json`, import.meta.url),
      JSON.stringify(c.abi, null, 2) + "\n",
    );
  }
  console.log(
    "Solidity " +
      require("solc").version() +
      " compiled Registry and RegistryV2 (Shanghai target)",
  );
}
