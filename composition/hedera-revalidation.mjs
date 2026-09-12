// Public, read-only payment readback. This never loads a wallet or submits a tx.
import { createHash } from "node:crypto";
import { mirrorTransactionId } from "../packages/payments/src/protocol.mjs";
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export async function revalidateHederaEvidence(
  e,
  { fetchImpl = globalThis.fetch, signal } = {},
) {
  if (
    e.network !== "hedera:testnet" ||
    e.payer !== "0.0.10419268" ||
    e.receiver !== "0.0.10419316" ||
    e.amountTinybars !== "1" ||
    e.feePayer !== "0.0.7162784" ||
    !/^0\.0\.7162784@[0-9]+\.[0-9]{9}$/.test(e.transactionId) ||
    !/^ethonline:[0-9a-f]{64}$/.test(e.memo)
  )
    fail("ONE_TINYBAR_EVIDENCE_REQUIRED");
  const id = mirrorTransactionId(e.transactionId);
  const r = await fetchImpl(
    "https://testnet.mirrornode.hedera.com/api/v1/transactions/" + id,
    {
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(15000),
      ]),
    },
  );
  if (r.status !== 200) fail("MIRROR_UNAVAILABLE");
  const text = await r.text();
  if (Buffer.byteLength(text) > 262144) fail("MIRROR_RESPONSE_LIMIT");
  const body = JSON.parse(text);
  const candidates = body.transactions?.filter(
    (t) =>
      t.transaction_id === id &&
      t.nonce === 0 &&
      t.scheduled === false &&
      t.name === "CRYPTOTRANSFER" &&
      t.result === "SUCCESS",
  );
  if (candidates?.length !== 1) fail("TRANSFER_NOT_CONFIRMED");
  const tx = candidates[0];
  if (
    tx.memo_base64 !== Buffer.from(e.memo).toString("base64") ||
    !Array.isArray(tx.transfers) ||
    tx.transfers.length > 100 ||
    (tx.token_transfers?.length ?? 0) !== 0
  )
    fail("TRANSFER_BINDING_MISMATCH");
  const net = new Map();
  for (const t of tx.transfers) {
    if (!Number.isSafeInteger(t.amount) || !/^0\.0\.\d+$/.test(t.account))
      fail("TRANSFER_AMOUNT_INVALID");
    net.set(t.account, (net.get(t.account) ?? 0n) + BigInt(t.amount));
  }
  if (net.get(e.payer) !== -1n || net.get(e.receiver) !== 1n)
    fail("PAYER_OR_RECEIVER_AMOUNT_MISMATCH");
  for (const [id, value] of net)
    if (value < 0n && id !== e.payer && id !== e.feePayer)
      fail("UNEXPECTED_FEE_PAYER");
  return {
    status: "passed",
    network: e.network,
    transactionId: e.transactionId,
    payer: e.payer,
    receiver: e.receiver,
    feePayer: e.feePayer,
    amountTinybars: "1",
    consensusTimestamp: tx.consensus_timestamp,
    mirrorResponseSha256: createHash("sha256").update(text).digest("hex"),
    mirror: tx,
    broadcast: false,
    privateKeysLoaded: false,
    inferenceVerified: false,
    scope:
      "Exact payment/memo readback only; inference verification is not performed",
  };
}
