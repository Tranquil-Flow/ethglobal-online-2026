import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

export const ROOT = resolve(new URL("../..", import.meta.url).pathname);
export const EVIDENCE = resolve(ROOT, "artifacts/w6-v2/x0");
export const DEPLOYED = resolve(EVIDENCE, "deployed");
export const RPC = "https://testnet.hashio.io/api";
export const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";
export const FACILITATOR = "https://api.testnet.blocky402.com";
export const PAYER = "0.0.10419268";
export const FEE_PAYER = "0.0.7162784";

const require = createRequire(resolve(ROOT, "packages/payments/package.json"));
export const ethers = require("ethers");
export const hedera = require("@hiero-ledger/sdk");
export const x402Hedera = require("@x402/hedera");
export const x402CoreHttp = require("@x402/core/http");

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function saveJson(file, value, mode = 0o644) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
    { mode },
  );
}

export function loadOperator(file) {
  file = resolve(file);
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid()) {
    throw new Error("PRIVATE_OPERATOR_FILE_REQUIRED");
  }
  const bytes = readFileSync(file);
  if (bytes.length < 1 || bytes.length > 4096) throw new Error("PRIVATE_OPERATOR_FILE_REQUIRED");
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!/^0x[0-9a-f]{64}$/i.test(parsed.privateKey ?? "")) throw new Error("PRIVATE_OPERATOR_KEY_REQUIRED");
  const wallet = new ethers.Wallet(parsed.privateKey);
  if (parsed.address && wallet.address.toLowerCase() !== parsed.address.toLowerCase()) {
    throw new Error("PRIVATE_OPERATOR_ADDRESS_MISMATCH");
  }
  return {
    privateKey: parsed.privateKey,
    address: wallet.address,
    metadata: {
      path: file,
      mode: "0600",
      sha256: sha256(bytes),
      address: wallet.address,
      secretPersistedInEvidence: false,
    },
  };
}

export async function getJson(url, attempts = 1) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (response.ok) return body;
      last = new Error(`HTTP_${response.status}`);
    } catch (error) {
      last = error;
    }
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 500));
  }
  throw last;
}

export function mirrorTxId(id) {
  return id.includes("@") ? id.replace("@", "-").replace(/\.(\d+)$/, "-$1") : id;
}

export function safeError(error) {
  const message = String(error?.code ?? error?.shortMessage ?? error?.message ?? error?.name ?? "FAILED");
  return /^[A-Za-z0-9_ .:-]{1,300}$/.test(message) ? message : "FAILED";
}
