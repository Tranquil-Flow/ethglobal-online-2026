import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { TopicMessageSubmitTransaction, Hbar } from "@hiero-ledger/sdk";
import { canonicalBytes } from "../../contracts/index.mjs";
import { account, amount, fail } from "../src/safety.mjs";
try {
  const { values: v } = parseArgs({
    options: {
      network: { type: "string" },
      mode: { type: "string" },
      topic: { type: "string" },
      digest: { type: "string" },
      consent: { type: "boolean" },
      submit: { type: "boolean" },
      approved: { type: "boolean" },
      budget: { type: "string" },
      adapter: { type: "string" },
    },
  });
  if (
    v.network !== "hedera:testnet" ||
    !["development", "live"].includes(v.mode) ||
    v.consent !== true ||
    !/^sha256:[0-9a-f]{64}$/.test(v.digest)
  )
    fail("EXPLICIT_NETWORK_MODE_DIGEST_CONSENT_REQUIRED");
  account(v.topic);
  const message = canonicalBytes({
    version: "1",
    mode: v.mode,
    objectDigest: v.digest,
    claim: "digest-audit-only",
  });
  const transaction = new TopicMessageSubmitTransaction()
    .setTopicId(v.topic)
    .setMessage(message)
    .setMaxChunks(1);
  if (!v.submit) {
    console.log(
      JSON.stringify({
        mode: v.mode,
        network: v.network,
        messageBytes: message.length,
        nativeSerializedBytes: transaction.toBytes().length,
        broadcast: false,
        integrity: "not_verified",
        execution: "not_verified",
        payment: "not_verified",
        assessment: "not_performed",
      }),
    );
  } else {
    if (
      v.approved !== true ||
      !v.adapter ||
      !isAbsolute(v.adapter) ||
      amount(v.budget) <= 0n
    )
      fail("HCS_APPROVAL_BUDGET_ADAPTER_REQUIRED");
    transaction.setMaxTransactionFee(Hbar.fromTinybars(v.budget));
    const { submitHcs } = await import(pathToFileURL(v.adapter));
    // Operator adapter must use a funded authorized testnet signer, enforce custom
    // topic fees against budget, wait for consensus receipt and return SUCCESS.
    const result = await submitHcs({
      transaction,
      network: v.network,
      maxAmountBaseUnits: v.budget,
      signal: AbortSignal.timeout(30000),
    });
    if (
      result?.status !== "SUCCESS" ||
      typeof result.transactionId !== "string"
    )
      fail("HCS_NOT_CONFIRMED");
    console.log(
      JSON.stringify({
        mode: v.mode,
        transactionRef: result.transactionId,
        claim: "digest-audit-only",
        broadcast: true,
      }),
    );
  }
} catch (e) {
  console.error(e.code ?? "HCS_AUDIT_FAILED");
  process.exitCode = 1;
}
