import { execFile as nodeExecFile } from "node:child_process";
import { resolve } from "node:path";
import { digestOf, validate } from "../packages/contracts/index.mjs";

export const DEFAULT_27B_MIN_MEM_BYTES = 22 * 1024 ** 3;
export const DEFAULT_27B_QUEUE_CAP = 4;
export const MAX_27B_PROMPT_TOKENS = 512;
export const MAX_27B_OUTPUT_TOKENS = 64;

const MODEL = "mlx-community/Qwen3.8-27B-4bit";
const MODEL_REVISION = "3e6447f082e89cc7f0bc6e5441afd38dfce760ff";
const CHECKPOINT_MANIFEST =
  "sha256:acf8033fb4737199a3bf0cd18b41d4c2fdf3301400fe3578424f9e74c39f858a";
const VERIFIER_PROFILE =
  "sha256:40ede77319ecc67833d8fac597026f3925b45cfa460c4243d090c0a6937abe5f";
const NATIVE_WORKER =
  "sha256:2d89106717baee5ad9c2e414872db4831442d8f40e27954372a450aea0e34ac7";
const MLX_TARGET_ADAPTER =
  "sha256:903c74b726eb0601c4f515affca07982d9fd6ba8b827d0b5e7520eeb569839aa";
const TOKENIZER =
  "sha256:06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523";
const TEMPLATE =
  "sha256:c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041";

export class W627BConfigurationError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "W627BConfigurationError";
    this.code = code;
  }
}

function fail(code, cause) {
  throw new W627BConfigurationError(code, cause ? { cause } : undefined);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function positiveSafeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function configuredInteger(raw, fallback, { minimum = 1, maximum } = {}) {
  const value = raw === undefined ? fallback : Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  )
    fail("INVALID_27B_PROFILE_OPTIONS");
  return value;
}

function absolutePath(value) {
  if (typeof value !== "string" || !value || resolve(value) !== value)
    fail("INVALID_27B_PROFILE_OPTIONS");
  return value;
}

/**
 * Operational serving policy bound into the schema-valid application Profile.
 * This function performs no filesystem, network, or model operation.
 */
export function create27BServingPolicy({
  runtimeBase,
  modelRoot,
  port,
  env = process.env,
} = {}) {
  absolutePath(runtimeBase);
  absolutePath(modelRoot);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    fail("INVALID_27B_PROFILE_OPTIONS");
  const queueCap = configuredInteger(env?.W6_27B_QUEUE_CAP, DEFAULT_27B_QUEUE_CAP, {
    maximum: 1024,
  });
  return deepFreeze({
    version: "1",
    endpoint: `http://127.0.0.1:${port}`,
    hostLabel: "m4pro-48GiB-single-host",
    concurrency: 1,
    queueCap,
    maxPromptTokens: MAX_27B_PROMPT_TOKENS,
    maxOutputTokens: MAX_27B_OUTPUT_TOKENS,
    loadPolicy: "once-at-launch",
    startupDownloads: false,
    fallbackProfile: null,
    runtimeBase: resolve(runtimeBase),
    modelRoot: resolve(modelRoot),
  });
}

/**
 * Build the immutable v1 Profile consumed by the app profile catalog.
 * Runtime paths and endpoint are only content-bound metadata; construction has
 * no side effects and never reads or downloads model files.
 */
export function create27BProfile(options = {}) {
  const policy = create27BServingPolicy(options);
  const policyDigest = digestOf(policy);
  const profile = {
    version: "1",
    model: MODEL,
    artifacts: [
      {
        role: "verifier-27b-profile-v1",
        digest: VERIFIER_PROFILE,
        uri: `urn:${VERIFIER_PROFILE}`,
      },
      {
        role: "qwen38-27b-checkpoint-manifest",
        digest: CHECKPOINT_MANIFEST,
        uri: `urn:${CHECKPOINT_MANIFEST}`,
      },
      {
        role: "mycelium-verifier-native-worker",
        digest: NATIVE_WORKER,
        uri: `urn:${NATIVE_WORKER}`,
      },
      {
        role: "mycelium-verifier-mlx-target-adapter",
        digest: MLX_TARGET_ADAPTER,
        uri: `urn:${MLX_TARGET_ADAPTER}`,
      },
      {
        role: "w6-27b-serving-policy-v1",
        digest: policyDigest,
        uri: `urn:${policyDigest}`,
      },
    ],
    runtimeRevision:
      `mycelium-verifier-0.1.0;mlx-0.32.2;mlx-lm-0.31.3;model-rev-${MODEL_REVISION}`,
    tokenizerDigest: TOKENIZER,
    templateDigest: TEMPLATE,
    numerics: {
      dtype: "checkpoint-native (bfloat16 config; float32 Mamba SSM)",
      quantization: "MLX affine 4-bit weights; group_size=64",
      backend: "mycelium_verifier mlx_target; MLX 0.32.2; mlx-lm 0.31.3; GPU",
      hardwareClass: "single-host macOS arm64 Apple M4 Pro 48 GiB unified memory",
      determinism:
        "sha256-cdf-f64-v1; temperature=0.7; top_k=20; top_p=0.9; " +
        "seed_domain=mycelium-hiddenstate-prep/sample/v1\\0; " +
        "chat-template thinking=false, generation-prompt=true, date=2026-09-12; " +
        "fresh cache/request; one-token decode; EOS=[248044,248046].",
    },
  };
  validate("Profile", profile);
  return deepFreeze(profile);
}

function configuredMinBytes(minRequiredBytes, env) {
  if (minRequiredBytes !== undefined)
    return positiveSafeInteger(minRequiredBytes, "INVALID_27B_MEMORY_THRESHOLD");
  const raw = env?.W6_27B_MIN_MEM_BYTES;
  if (raw === undefined) return DEFAULT_27B_MIN_MEM_BYTES;
  const parsed = Number(raw);
  return positiveSafeInteger(parsed, "INVALID_27B_MEMORY_THRESHOLD");
}

/** M3 fail-closed memory admission. Equality is admitted. */
export function is27BAdmissible({
  memAvailableBytes,
  minRequiredBytes,
  env = process.env,
} = {}) {
  const minimum = configuredMinBytes(minRequiredBytes, env);
  if (!Number.isSafeInteger(memAvailableBytes) || memAvailableBytes < 0) {
    return {
      ok: false,
      reason: "27B unavailable: available memory could not be measured safely.",
    };
  }
  if (memAvailableBytes < minimum) {
    return {
      ok: false,
      reason:
        `27B unavailable: available memory ${memAvailableBytes} bytes is below ` +
        `the required ${minimum} byte load threshold.`,
    };
  }
  return { ok: true, reason: "27B memory admission passed." };
}

function parsePageCount(output, label) {
  const expression = new RegExp(`^${label}:\\s*([0-9]+)\\.\\s*$`, "m");
  const match = output.match(expression);
  if (!match) fail("MAC_MEMORY_READ_FAILED");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) fail("MAC_MEMORY_READ_FAILED");
  return value;
}

/** Parse macOS vm_stat without counting active/wired/compressed pages. */
export function parseMacVmStat({ vmStatOutput, pageSizeOutput } = {}) {
  if (typeof vmStatOutput !== "string" || typeof pageSizeOutput !== "string")
    fail("MAC_MEMORY_READ_FAILED");
  const pageSize = Number(pageSizeOutput.trim());
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    fail("MAC_MEMORY_READ_FAILED");
  const pages =
    parsePageCount(vmStatOutput, "Pages free") +
    parsePageCount(vmStatOutput, "Pages inactive") +
    parsePageCount(vmStatOutput, "Pages speculative");
  const bytes = pages * pageSize;
  if (!Number.isSafeInteger(bytes)) fail("MAC_MEMORY_READ_FAILED");
  return bytes;
}

function execFilePromise(execFileImpl, file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(
      file,
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) rejectPromise(error);
        else resolvePromise(stdout);
      },
    );
  });
}

/** Read current macOS available bytes via bounded sysctl + vm_stat calls. */
export async function readMacAvailableMemory({
  execFileImpl = nodeExecFile,
  parser = parseMacVmStat,
} = {}) {
  try {
    const pageSizeOutput = await execFilePromise(
      execFileImpl,
      "/usr/sbin/sysctl",
      ["-n", "hw.pagesize"],
    );
    const vmStatOutput = await execFilePromise(
      execFileImpl,
      "/usr/bin/vm_stat",
      [],
    );
    const result = parser({ vmStatOutput, pageSizeOutput });
    if (!Number.isSafeInteger(result) || result < 0)
      fail("MAC_MEMORY_READ_FAILED");
    return result;
  } catch (error) {
    if (error instanceof W627BConfigurationError) throw error;
    fail("MAC_MEMORY_READ_FAILED", error);
  }
}
