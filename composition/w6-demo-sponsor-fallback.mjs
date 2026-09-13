// OT1-fallback Tier A: Provision a dedicated DEMO sponsor account with a SMALLER
// initial balance (3 HBAR) so the operator (currently ~9.17 HBAR) can fund it
// even when faucet top-ups are exhausted. Reuses the explicit ECDSA parser — the
// operator key is 66-char ECDSA, NOT ED25519.
//
// This is a sibling helper to scripts/w6-provision-demo-sponsor.mjs but it:
//   * Reads initial-balance from argv (default 3 HBAR)
//   * Writes the sponsor key to a caller-supplied path
//   * Writes an evidence-only reservation file (operator-internal)
//   * Does NOT auto-set env vars (parent must do that explicitly)
//
// Constraints honored:
//   * Sponsor != recipient (0.0.10419316) and != fee payer (0.0.7162784)
//   * Sponsor key file written mode 0600
//   * Operator key file is read only via assertPayerIdentity for verification
//   * No private key bytes echoed anywhere except the file at SPONSOR_KEY_FILE

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createECDH } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPayerIdentity } from "../scripts/w6-single-payment-guard.mjs";

const OPERATOR = "0.0.10419268";
const OPERATOR_FILE = "/Users/evinova-self/.ethonline-testnet/hedera-payer.json";
const MIRROR = "https://testnet.mirrornode.hedera.com";
const RECEIVER_GUARDED = "0.0.10419316";
const FEE_PAYER_GUARDED = "0.0.7162784";

const paymentRequire = createRequire(
  new URL("../packages/payments/package.json", import.meta.url),
);
const sdkRequire = createRequire(paymentRequire.resolve("@x402/hedera"));
const sdk = sdkRequire("@hiero-ledger/sdk");

function privateFile(path) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error("PRIVATE_FILE_REQUIRED");
}

function replacePrivate(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export async function provisionDemoSponsorFallback({
  initialBalanceHbar = 3,
  sponsorKeyFile = "/Users/evinova-self/.ethonline-testnet/sponsor.json",
  reservationFile = "/Users/evinova-self/.ethonline-testnet/sponsor-fallback-reservation.json",
  fetchImpl = globalThis.fetch,
  sdk: sdkOverride,
} = {}) {
  if (!Number.isInteger(initialBalanceHbar) || initialBalanceHbar < 1 || initialBalanceHbar > 5) {
    throw new Error("INITIAL_BALANCE_OUT_OF_RANGE");
  }
  if (existsSync(sponsorKeyFile)) throw new Error("SPONSOR_ALREADY_EXISTS");
  if (existsSync(reservationFile)) throw new Error("RESERVATION_ALREADY_EXISTS");

  const sdkLib = sdkOverride ?? sdk;

  privateFile(OPERATOR_FILE);
  const operatorConfig = JSON.parse(readFileSync(OPERATOR_FILE, "utf8"));

  // EXPLICIT ECDSA parser — operator key is 66-char ECDSA, not ED25519
  const operatorKey = sdkLib.PrivateKey.fromStringECDSA(operatorConfig.privateKey);

  const mirrorResponse = await fetchImpl(`${MIRROR}/api/v1/accounts/${OPERATOR}`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!mirrorResponse.ok) throw new Error("OPERATOR_MIRROR_UNAVAILABLE");
  const mirror = await mirrorResponse.json();

  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(operatorKey.toStringRaw(), "hex"));
  const derivedPublicKey = ecdh.getPublicKey("hex", "compressed");
  assertPayerIdentity({
    config: operatorConfig,
    accountId: OPERATOR,
    mirror,
    derivedPublicKey,
  });

  // Sanity: operator has enough for initial balance + account-create fee (~0.5 HBAR)
  const operatorBalanceTinybar = Number(mirror.balance?.balance ?? 0);
  const requiredTinybar = (initialBalanceHbar + 1) * 100_000_000;
  if (operatorBalanceTinybar < requiredTinybar) {
    throw new Error(
      `OPERATOR_BALANCE_INSUFFICIENT: have=${operatorBalanceTinybar} tinybar need>=${requiredTinybar} tinybar`,
    );
  }

  // Reserve before submit
  const reservation = {
    version: "w6-ot1-fallback-sponsor-provision-v1",
    status: "reserved-before-submit",
    operatorAccountId: OPERATOR,
    initialBalanceHbar: String(initialBalanceHbar),
    operatorBalanceTinybarAtReserve: String(operatorBalanceTinybar),
    reservedAt: new Date().toISOString(),
  };
  replacePrivate(reservationFile, reservation);

  // Generate a fresh ECDSA sponsor key
  const sponsorKey = sdkLib.PrivateKey.generateECDSA();

  const client = sdkLib.Client.forTestnet().setOperator(OPERATOR, operatorKey);
  let transactionId;
  try {
    const submitted = await new sdkLib.AccountCreateTransaction()
      .setKey(sponsorKey.publicKey)
      .setInitialBalance(new sdkLib.Hbar(initialBalanceHbar))
      .execute(client);
    transactionId = submitted.transactionId.toString();
    replacePrivate(reservationFile, {
      ...reservation,
      status: "submitted-awaiting-receipt",
      transactionId,
      submittedAt: new Date().toISOString(),
    });
    const receipt = await submitted.getReceipt(client);
    const accountId = receipt.accountId?.toString();
    if (!/^0\.0\.[1-9][0-9]*$/.test(accountId ?? ""))
      throw new Error("SPONSOR_ACCOUNT_ID_UNAVAILABLE");

    // Guard: sponsor must NOT equal recipient or fee payer
    if (accountId === RECEIVER_GUARDED || accountId === FEE_PAYER_GUARDED) {
      throw new Error(`SPONSOR_GUARDED_ACCOUNT: ${accountId}`);
    }

    replacePrivate(sponsorKeyFile, {
      accountId,
      privateKey: sponsorKey.toString(),
      keyType: "ECDSA",
      purpose: "mycelium-wave6-ot1-fallback-demo-sponsor-testnet-only",
    });
    const final = {
      ...reservation,
      status: "confirmed",
      sponsorAccountId: accountId,
      transactionId,
      sponsorKeyFile,
      confirmedAt: new Date().toISOString(),
    };
    replacePrivate(reservationFile, final);
    return {
      sponsorAccountId: accountId,
      transactionId,
      initialBalanceHbar: String(initialBalanceHbar),
      sponsorKeyFile,
      reservationFile,
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await provisionDemoSponsorFallback({
    initialBalanceHbar: Number(process.argv.find((a) => a.startsWith("--hbar="))?.split("=")[1] ?? 3),
  });
  // Print only non-secret fields
  console.log(JSON.stringify(result, null, 2));
}