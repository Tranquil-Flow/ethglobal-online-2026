// Native x402 wallet boundary. Private keys are injected only by the approved
// live connector; ordinary imports/tests do not inspect any operator wallet.
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmdirSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestOf, validate } from "../packages/contracts/index.mjs";
import {
  createBoundHederaSigner,
  createHederaPaymentAuthorizer,
} from "../packages/payments/src/client.mjs";
import { inspectProof } from "../packages/payments/src/protocol.mjs";
import {
  assertPrivateDirectory,
  readPrivateFile,
} from "../operations/src/private-files.mjs";
export const HEDERA_PAYER = "0.0.10419268",
  HEDERA_RECEIVER = "0.0.10419316";
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export function createSingleTinybarWallet({
  journalFile,
  request,
  mode,
  feePayer,
  resourceUrl,
  signTransaction,
}) {
  validate("Request", request);
  if (
    request.publishConsent !== false ||
    !request.prompt.startsWith("SYNTHETIC_LIVE_SMOKE:") ||
    !["development", "live"].includes(mode) ||
    typeof signTransaction !== "function"
  )
    fail("ONE_TINYBAR_SCOPE_REQUIRED");
  const original = structuredClone(request),
    requestHash = digestOf(original),
    file = resolve(journalFile);
  const signer = createBoundHederaSigner({
    accountId: HEDERA_PAYER,
    nodeAccountIds: ["0.0.3"],
    signTransaction,
  });
  const authorize = createHederaPaymentAuthorizer({
    signer,
    approve: () => true,
  });
  return async (context) => {
    const { quote, challenge, signal } = context;
    const r = challenge?.accepts?.[0];
    if (signal?.aborted) fail("ABORTED");
    if (
      challenge?.accepts?.length !== 1 ||
      quote?.requestHash !== requestHash ||
      quote.providerId !== original.providerId ||
      quote.profileId !== original.profileId ||
      quote.mode !== mode ||
      quote.amountBaseUnits !== "1" ||
      quote.receiver !== HEDERA_RECEIVER ||
      quote.network !== "hedera:testnet" ||
      quote.asset !== "0.0.0" ||
      r.amount !== "1" ||
      r.payTo !== HEDERA_RECEIVER ||
      r.network !== "hedera:testnet" ||
      r.asset !== "0.0.0" ||
      r.extra?.feePayer !== feePayer ||
      challenge.resource?.url !== resourceUrl + "/quotes/" + quote.quoteId
    )
      fail("ONE_TINYBAR_SCOPE_REQUIRED");
    const binding = digestOf({ quote, challenge, requestHash });
    assertPrivateDirectory(dirname(file));
    const lock = file + ".lock";
    let acquired = false;
    const save = (value) => {
      const fd = openSync(file + ".tmp", "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(file + ".tmp", file);
      const directoryFd = openSync(dirname(file), "r");
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    };
    try {
      mkdirSync(lock, { mode: 0o700 });
      acquired = true;
      if (existsSync(file)) {
        const saved = JSON.parse(
          readPrivateFile(file, {
            maxBytes: 65536,
            code: "PRIVATE_WALLET_JOURNAL_REQUIRED",
          }).data.toString("utf8"),
        );
        if (saved.binding !== binding || !saved.headers)
          fail("WALLET_BUDGET_RESERVED");
        inspectProof(
          saved.headers["payment-signature"],
          r,
          challenge.resource,
          { clock: () => new Date() },
        );
        return structuredClone(saved.headers);
      }
      const state = {
        version: "wave5-one-tinybar-v1",
        binding,
        requestHash,
        quoteId: quote.quoteId,
        maximumPayerDebitTinybars: "1",
        status: "reserved-before-signing",
        reservedAt: new Date().toISOString(),
      };
      save(state);
      const headers = await authorize(context);
      if (signal?.aborted) fail("ABORTED");
      const proof = inspectProof(
        headers["payment-signature"],
        r,
        challenge.resource,
        { clock: () => new Date() },
      );
      if (proof.payer !== HEDERA_PAYER) fail("PAYER_MISMATCH");
      Object.assign(state, {
        headers,
        transactionId: proof.transactionId,
        status: "signed-not-broadcast-by-wallet",
      });
      save(state);
      return headers;
    } finally {
      if (acquired) rmdirSync(lock);
    }
  };
}
export async function connect(options) {
  const entry = fileURLToPath(
    new URL("../packages/payments/scripts/live-smoke.mjs", import.meta.url),
  );
  if (
    resolve(process.argv[1] ?? "") !== entry ||
    !process.argv.includes("--execute") ||
    !process.argv.includes("--approved") ||
    process.env.EDITOR_LIVE_BUDGET_TINYBARS !== "1" ||
    options.network !== "hedera:testnet" ||
    options.maxAmountBaseUnits !== "1"
  )
    fail("APPROVED_LIVE_SMOKE_FLOW_REQUIRED");
  if (options.reconcileOnly === true) {
    const { connectReconciliation } = await import(
      "./hedera-reconciliation-connection.mjs"
    );
    return connectReconciliation(options);
  }
  const { createLivePaidConnection } = await import(
    "./hedera-live-connection.mjs"
  );
  return createLivePaidConnection(options);
}
