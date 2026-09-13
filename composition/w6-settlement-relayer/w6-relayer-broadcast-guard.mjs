// Guard for relayer broadcasts; not invoked by offline tests.
export function createRelayerBroadcastGuard({
  network = "hedera:testnet",
  chainId = 296,
  maxTinybarBudget = 0n,
  reserveNonce = async () => {},
  authorize,
  recordReceipt = async () => {},
} = {}) {
  if (!authorize) throw new Error("MISSING_BROADCAST_AUTHORIZER");
  const consumedNonces = new Set();
  let spentTinybar = 0n;
  return async function guardedBroadcast(context) {
    const c = structuredClone(context);
    if (c.network !== network || Number(c.chainId) !== Number(chainId)) throw new Error("RELAYER_SCOPE_MISMATCH");
    if (!c.to || !/^0x[0-9a-fA-F]{40}$/.test(c.to)) throw new Error("RELAYER_DESTINATION_MISSING");
    if (!c.calldata || !/^0x[0-9a-fA-F]+$/.test(c.calldata)) throw new Error("RELAYER_CALLDATA_MISSING");
    if (c.broadcast !== true) throw new Error("RELAYER_BROADCAST_FLAG_REQUIRED");
    const nonceKey = String(c.nonce);
    if (!nonceKey || nonceKey === "undefined") throw new Error("RELAYER_NONCE_REQUIRED");
    if (consumedNonces.has(nonceKey)) throw new Error("RELAYER_NONCE_CONSUMED");
    const amount = BigInt(c.maxTinybarCost ?? c.tinybarCost ?? 0);
    if (amount < 0n || spentTinybar + amount > BigInt(maxTinybarBudget)) {
      throw new Error("RELAYER_BUDGET_EXCEEDED");
    }
    consumedNonces.add(nonceKey);
    await reserveNonce({ nonce: nonceKey, context: c });
    let result;
    try {
      result = await authorize(c);
    } catch (error) {
      // Nonce remains consumed: ambiguous wallet/RPC failure must not be retried blindly.
      throw error;
    }
    if (!result?.receipt || !result.receipt.transactionId || !result.receipt.status) {
      throw new Error("RELAYER_RECEIPT_REQUIRED");
    }
    spentTinybar += amount;
    await recordReceipt({ nonce: nonceKey, context: c, receipt: result.receipt });
    return result;
  };
}
