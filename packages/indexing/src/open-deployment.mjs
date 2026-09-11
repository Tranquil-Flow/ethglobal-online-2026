import {
  AbiCoder,
  getAddress,
  getCreateAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { compileAllWithMetadata } from "../scripts/compile.mjs";
import { canonicalBytes } from "../../contracts/index.mjs";
import { bounded, deadline, checkAbort } from "./common.mjs";
const OWN_ERROR = Symbol("open-deployment-error");
const CONFIG_FIELDS = ["mode", "chainId", "sender", "nonce", "confirmations"];

const PLAN_SCHEMA = "mycelium.open-registry-deployment-plan/v1";
const INSPECTION_SCHEMA = "mycelium.open-registry-deployment-inspection/v1";
const DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const abi = AbiCoder.defaultAbiCoder();

function failure(code) {
  const error = new Error(code);
  error.code = code;
  error[OWN_ERROR] = true;
  return error;
}

function finiteInteger(value, { min, max = Number.MAX_SAFE_INTEGER } = {}) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw failure("OPEN_DEPLOYMENT_INVALID");
  if (
    Object.keys(input).sort().join(",") !== [...CONFIG_FIELDS].sort().join(",")
  )
    throw failure("OPEN_DEPLOYMENT_INVALID");
  if (!finiteInteger(input.mode, { min: 0, max: 1 }))
    throw failure("OPEN_DEPLOYMENT_INVALID");
  if (!finiteInteger(input.chainId, { min: 1 }))
    throw failure("OPEN_DEPLOYMENT_INVALID");
  if (!finiteInteger(input.nonce, { min: 0 }))
    throw failure("OPEN_DEPLOYMENT_INVALID");
  if (
    !finiteInteger(input.confirmations, {
      min: input.mode === 1 ? 12 : 1,
      max: 256,
    })
  )
    throw failure("OPEN_DEPLOYMENT_INVALID");
  let sender;
  try {
    sender = getAddress(input.sender);
  } catch {
    throw failure("OPEN_DEPLOYMENT_INVALID");
  }
  if (
    /^0x0{40}$/i.test(sender) ||
    (input.mode === 0 && input.chainId !== 31337) ||
    (input.mode === 1 && input.chainId !== 11155111)
  )
    throw failure("OPEN_DEPLOYMENT_INVALID");
  return {
    mode: input.mode,
    chainId: input.chainId,
    sender,
    nonce: input.nonce,
    confirmations: input.confirmations,
  };
}

function immutableDeclarations(ast) {
  const byId = new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (
      node.nodeType === "VariableDeclaration" &&
      node.mutability === "immutable"
    )
      byId.set(String(node.id), node.name);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  visit(ast);
  return byId;
}

function substituteRuntime(contract, ast, values) {
  const object = contract.evm.deployedBytecode.object;
  const references = contract.evm.deployedBytecode.immutableReferences;
  const names = immutableDeclarations(ast);
  const seen = new Set();
  let runtime = object;
  for (const [id, locations] of Object.entries(references || {})) {
    const name = names.get(id);
    const value = name && values[name];
    if (!name || !value || !Array.isArray(locations) || locations.length === 0)
      throw failure("OPEN_DEPLOYMENT_COMPILER_LAYOUT_INVALID");
    const replacement = value.slice(2).toLowerCase();
    if (replacement.length !== 64)
      throw failure("OPEN_DEPLOYMENT_COMPILER_LAYOUT_INVALID");
    seen.add(name);
    for (const location of locations) {
      if (location.length !== 32 || !finiteInteger(location.start, { min: 0 }))
        throw failure("OPEN_DEPLOYMENT_COMPILER_LAYOUT_INVALID");
      const start = location.start * 2;
      const end = start + location.length * 2;
      if (end > runtime.length)
        throw failure("OPEN_DEPLOYMENT_COMPILER_LAYOUT_INVALID");
      runtime = runtime.slice(0, start) + replacement + runtime.slice(end);
    }
  }
  if (
    seen.size !== Object.keys(values).length ||
    !seen.has("deploymentMode") ||
    !seen.has("DOMAIN_SEPARATOR")
  )
    throw failure("OPEN_DEPLOYMENT_COMPILER_LAYOUT_INVALID");
  return "0x" + runtime;
}

/** Build exact RegistryV2 CREATE inputs without an RPC, wallet, or side effect. */
export function planOpenRegistryDeployment(input) {
  const config = validate(input);
  const predictedAddress = getCreateAddress({
    from: config.sender,
    nonce: config.nonce,
  });
  const domainSeparator = keccak256(
    abi.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        keccak256(toUtf8Bytes(DOMAIN_TYPE)),
        keccak256(toUtf8Bytes("MyceliumOpenRegistry")),
        keccak256(toUtf8Bytes("2")),
        config.chainId,
        predictedAddress,
      ],
    ),
  );
  const immutableValues = {
    deploymentMode: abi.encode(["uint8"], [config.mode]),
    DOMAIN_SEPARATOR: domainSeparator,
  };
  const compiled = compileAllWithMetadata();
  const contract = compiled.contracts.RegistryV2;
  const metadata = JSON.parse(contract.metadata);
  const sources = Object.fromEntries(
    Object.keys(metadata.sources || {}).map((name) => {
      const entry = compiled.sources[name];
      if (!entry) throw failure("OPEN_DEPLOYMENT_COMPILER_METADATA_INVALID");
      return [name, keccak256(toUtf8Bytes(entry.content))];
    }),
  );
  for (const [name, hash] of Object.entries(sources)) {
    if (metadata.sources[name].keccak256 !== hash)
      throw failure("OPEN_DEPLOYMENT_COMPILER_METADATA_INVALID");
  }
  const expectedRuntime = substituteRuntime(
    contract,
    compiled.sourceOutputs["RegistryV2.sol"].ast,
    immutableValues,
  );
  const creationData =
    "0x" +
    contract.evm.bytecode.object +
    abi.encode(["uint8"], [config.mode]).slice(2);
  return Object.freeze({
    schema: PLAN_SCHEMA,
    broadcast: false,
    contract: "RegistryV2",
    ...config,
    predictedAddress,
    creationData,
    creationDataHash: keccak256(creationData),
    expectedRuntime,
    expectedRuntimeHash: keccak256(expectedRuntime),
    immutableValues: Object.freeze(immutableValues),
    compiler: Object.freeze({
      version: compiled.compilerVersion,
      evmVersion: compiled.settings.evmVersion,
      viaIR: compiled.settings.viaIR,
      optimizer: Object.freeze({ ...compiled.settings.optimizer }),
      metadataHash: keccak256(toUtf8Bytes(contract.metadata)),
    }),
    sources: Object.freeze(sources),
  });
}

function sameHex(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

/** Verify one already-mined RegistryV2 CREATE transaction and canonical deployed code. */
async function inspectOpen({
  provider,
  transactionHash,
  plan: input,
  signal,
  timeoutMs = 10000,
} = {}) {
  checkAbort(signal);
  if (!finiteInteger(timeoutMs, { min: 1, max: 60000 }))
    throw failure("OPEN_DEPLOYMENT_INVALID");
  const full = input?.schema === PLAN_SCHEMA;
  const plan = planOpenRegistryDeployment(
    full ? Object.fromEntries(CONFIG_FIELDS.map((k) => [k, input[k]])) : input,
  );
  if (full) {
    let same = false;
    try {
      same = canonicalBytes(input).equals(canonicalBytes(plan));
    } catch {}
    if (!same) throw failure("OPEN_DEPLOYMENT_PLAN_MISMATCH");
  }
  const end = deadline(signal, timeoutMs);
  const call = (fn) => {
    checkAbort(end);
    return bounded(
      Promise.resolve().then(() => {
        checkAbort(end);
        return fn();
      }),
      end,
    );
  };
  if (
    typeof transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)
  )
    throw failure("OPEN_DEPLOYMENT_INVALID");
  if (!provider || typeof provider.getNetwork !== "function")
    throw failure("OPEN_DEPLOYMENT_INVALID");

  const network = await call(() => provider.getNetwork());
  if (BigInt(network.chainId) !== BigInt(plan.chainId))
    throw failure("OPEN_DEPLOYMENT_CHAIN_MISMATCH");

  const [transaction, receipt] = await Promise.all([
    call(() => provider.getTransaction(transactionHash)),
    call(() => provider.getTransactionReceipt(transactionHash)),
  ]);
  if (!transaction && !receipt) throw failure("OPEN_DEPLOYMENT_UNKNOWN");
  if (!receipt || receipt.blockNumber == null)
    throw failure("OPEN_DEPLOYMENT_PENDING");
  if (!transaction) throw failure("OPEN_DEPLOYMENT_REORGED");
  if (
    !sameHex(transaction.hash, transactionHash) ||
    !sameHex(transaction.from, plan.sender) ||
    transaction.to !== null ||
    transaction.nonce !== plan.nonce ||
    BigInt(transaction.value) !== 0n ||
    !sameHex(transaction.data, plan.creationData) ||
    BigInt(transaction.chainId) !== BigInt(plan.chainId)
  )
    throw failure("OPEN_DEPLOYMENT_TRANSACTION_MISMATCH");
  if (
    receipt.status !== 1 ||
    !sameHex(receipt.hash, transactionHash) ||
    typeof receipt.blockHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) ||
    !finiteInteger(receipt.blockNumber, { min: 0 }) ||
    transaction.blockNumber !== receipt.blockNumber ||
    receipt.to !== null ||
    !sameHex(receipt.from, plan.sender) ||
    !sameHex(receipt.contractAddress, plan.predictedAddress)
  )
    throw failure("OPEN_DEPLOYMENT_RECEIPT_MISMATCH");
  if (!sameHex(transaction.blockHash, receipt.blockHash))
    throw failure("OPEN_DEPLOYMENT_REORGED");

  const [canonicalBlock, headNumber, runtime] = await Promise.all([
    call(() => provider.getBlock(receipt.blockNumber)),
    call(() => provider.getBlockNumber()),
    call(() => provider.getCode(plan.predictedAddress, receipt.blockNumber)),
  ]);
  if (
    !canonicalBlock ||
    canonicalBlock.number !== receipt.blockNumber ||
    !sameHex(canonicalBlock.hash, receipt.blockHash)
  )
    throw failure("OPEN_DEPLOYMENT_REORGED");
  if (!finiteInteger(headNumber, { min: 0 }))
    throw failure("OPEN_DEPLOYMENT_PENDING");
  let confirmations = headNumber - receipt.blockNumber + 1;
  if (
    !Number.isSafeInteger(confirmations) ||
    confirmations < plan.confirmations
  )
    throw failure("OPEN_DEPLOYMENT_PENDING");
  if (
    !sameHex(runtime, plan.expectedRuntime) ||
    keccak256(runtime) !== plan.expectedRuntimeHash
  )
    throw failure("OPEN_DEPLOYMENT_RUNTIME_MISMATCH");

  const [again, finalHead] = await Promise.all([
    call(() => provider.getBlock(receipt.blockNumber)),
    call(() => provider.getBlockNumber()),
  ]);
  if (
    !again ||
    again.number !== receipt.blockNumber ||
    !sameHex(again.hash, receipt.blockHash)
  )
    throw failure("OPEN_DEPLOYMENT_REORGED");
  if (
    !finiteInteger(finalHead, { min: receipt.blockNumber }) ||
    (confirmations = finalHead - receipt.blockNumber + 1) < plan.confirmations
  )
    throw failure("OPEN_DEPLOYMENT_PENDING");
  checkAbort(end);
  return Object.freeze({
    schema: INSPECTION_SCHEMA,
    verified: true,
    transactionHash: transaction.hash,
    sender: plan.sender,
    nonce: plan.nonce,
    value: "0",
    contractAddress: plan.predictedAddress,
    chainId: plan.chainId,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    confirmations,
    creationDataHash: plan.creationDataHash,
    runtimeHash: plan.expectedRuntimeHash,
    compilerMetadataHash: plan.compiler.metadataHash,
    sourceHashes: plan.sources,
  });
}

export async function inspectOpenRegistryDeployment(options) {
  try {
    return await inspectOpen(options);
  } catch (e) {
    if (e?.[OWN_ERROR]) throw e;
    throw failure(
      e?.code === "ABORTED" ? "ABORTED" : "OPEN_DEPLOYMENT_UNAVAILABLE",
    );
  }
}
