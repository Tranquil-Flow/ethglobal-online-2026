export const DEFAULT_MIRROR_BASE = "https://testnet.mirrornode.hedera.com/api/v1";
export const MIN_HEDERA_CONFIRMATIONS = 12;

export async function checkMirrorConfirmation({
  txId,
  fetch: fetchImpl = globalThis.fetch,
  mirrorBase = DEFAULT_MIRROR_BASE,
  minConfirmations = MIN_HEDERA_CONFIRMATIONS,
} = {}) {
  if (!txId) throw new Error("MISSING_HEDERA_TX_ID");
  if (!fetchImpl) throw new Error("MISSING_FETCH");
  const url = `${mirrorBase.replace(/\/$/, "")}/transactions/${encodeURIComponent(txId)}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    return { confirmed: false, confirmations: 0, txId, url, status: response.status, reason: "MIRROR_HTTP_ERROR" };
  }
  const body = await response.json();
  const tx = Array.isArray(body.transactions) ? body.transactions[0] : body.transaction ?? body;
  const result = tx?.result ?? body.result;
  const confirmations = Number(body.confirmations ?? tx?.confirmations ?? tx?.confirmation_count ?? 0);
  const resultOk = !result || result === "SUCCESS" || result === "CONTRACTCALL" || result === "OK";
  return {
    confirmed: resultOk && confirmations >= minConfirmations,
    confirmations,
    txId,
    url,
    result,
    consensusTimestamp: tx?.consensus_timestamp ?? body.consensus_timestamp,
    reason: resultOk ? (confirmations >= minConfirmations ? "CONFIRMED" : "INSUFFICIENT_CONFIRMATIONS") : "MIRROR_TX_NOT_SUCCESS",
    raw: body,
  };
}
