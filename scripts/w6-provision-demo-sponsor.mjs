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
import { assertPayerIdentity } from "./w6-single-payment-guard.mjs";

const OPERATOR = "0.0.10419268";
const OPERATOR_FILE = "/Users/evinova-self/.ethonline-testnet/hedera-payer.json";
const SPONSOR_FILE = "/Users/evinova-self/.ethonline-testnet/sponsor.json";
const FIRST_RESERVATION_FILE =
  "/Users/evinova-self/.ethonline-testnet/sponsor-provision-reservation.json";
const MIRROR = "https://testnet.mirrornode.hedera.com";

const paymentRequire = createRequire(
  new URL("../packages/payments/package.json", import.meta.url),
);
const sdkRequire = createRequire(paymentRequire.resolve("@x402/hedera"));

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

export async function provisionDemoSponsor({
  approved = false,
  fetchImpl = globalThis.fetch,
  sdk = sdkRequire("@hiero-ledger/sdk"),
} = {}) {
  if (approved !== true) throw new Error("EXPLICIT_APPROVAL_REQUIRED");
  if (existsSync(SPONSOR_FILE)) throw new Error("SPONSOR_ALREADY_EXISTS");
  let reservationFile = FIRST_RESERVATION_FILE;
  if (existsSync(FIRST_RESERVATION_FILE)) {
    privateFile(FIRST_RESERVATION_FILE);
    const first = JSON.parse(readFileSync(FIRST_RESERVATION_FILE, "utf8"));
    if (first.status !== "rejected-precheck-no-consensus")
      throw new Error("PROVISION_ATTEMPT_ALREADY_RESERVED");
    reservationFile =
      "/Users/evinova-self/.ethonline-testnet/sponsor-provision-reservation-attempt-2.json";
    if (existsSync(reservationFile))
      throw new Error("PROVISION_ATTEMPT_ALREADY_RESERVED");
  }
  privateFile(OPERATOR_FILE);
  const operatorConfig = JSON.parse(readFileSync(OPERATOR_FILE, "utf8"));
  const operatorKey = sdk.PrivateKey.fromStringECDSA(operatorConfig.privateKey);
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

  const sponsorKey = sdk.PrivateKey.generateECDSA();
  replacePrivate(reservationFile, {
    version: "w6-demo-sponsor-provision-v1",
    status: "reserved-before-submit",
    operatorAccountId: OPERATOR,
    initialBalanceHbar: "10",
    reservedAt: new Date().toISOString(),
  });

  const client = sdk.Client.forTestnet().setOperator(OPERATOR, operatorKey);
  let transactionId;
  try {
    const submitted = await new sdk.AccountCreateTransaction()
      .setKey(sponsorKey.publicKey)
      .setInitialBalance(new sdk.Hbar(10))
      .execute(client);
    transactionId = submitted.transactionId.toString();
    replacePrivate(reservationFile, {
      version: "w6-demo-sponsor-provision-v1",
      status: "submitted-awaiting-receipt",
      operatorAccountId: OPERATOR,
      initialBalanceHbar: "10",
      transactionId,
      submittedAt: new Date().toISOString(),
    });
    const receipt = await submitted.getReceipt(client);
    const accountId = receipt.accountId?.toString();
    if (!/^0\.0\.[1-9][0-9]*$/.test(accountId ?? ""))
      throw new Error("SPONSOR_ACCOUNT_ID_UNAVAILABLE");
    replacePrivate(SPONSOR_FILE, {
      accountId,
      privateKey: sponsorKey.toString(),
      purpose: "mycelium-wave6-demo-sponsor-testnet-only",
    });
    replacePrivate(reservationFile, {
      version: "w6-demo-sponsor-provision-v1",
      status: "confirmed",
      operatorAccountId: OPERATOR,
      sponsorAccountId: accountId,
      initialBalanceHbar: "10",
      transactionId,
      confirmedAt: new Date().toISOString(),
    });
    return { accountId, transactionId, initialBalanceHbar: "10" };
  } finally {
    client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await provisionDemoSponsor({
    approved: process.argv.includes("--execute") && process.argv.includes("--approved"),
  });
  console.log(JSON.stringify(result));
}
