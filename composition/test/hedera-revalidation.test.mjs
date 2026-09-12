import test from "node:test";
import assert from "node:assert/strict";
import { revalidateHederaEvidence } from "../hedera-revalidation.mjs";
const evidence = {
  network: "hedera:testnet",
  payer: "0.0.10419268",
  receiver: "0.0.10419316",
  feePayer: "0.0.7162784",
  transactionId: "0.0.7162784@100.000000001",
  amountTinybars: "1",
  memo: "ethonline:" + "a".repeat(64),
};
function body() {
  return {
    transactions: [
      {
        transaction_id: "0.0.7162784-100-000000001",
        name: "CRYPTOTRANSFER",
        nonce: 0,
        scheduled: false,
        result: "SUCCESS",
        consensus_timestamp: "100.1",
        memo_base64: Buffer.from(evidence.memo).toString("base64"),
        token_transfers: [],
        transfers: [
          { account: evidence.payer, amount: -1 },
          { account: evidence.receiver, amount: 1 },
          { account: evidence.feePayer, amount: -10 },
          { account: "0.0.3", amount: 10 },
        ],
      },
    ],
  };
}
test("read-only Hedera verifier checks exact debit, credit, memo and fee payer", async () => {
  const r = await revalidateHederaEvidence(evidence, {
    fetchImpl: async () => new Response(JSON.stringify(body())),
  });
  assert.equal(r.status, "passed");
  assert.equal(r.inferenceVerified, false);
  assert.equal(r.broadcast, false);
});
test("readback rejects an unpinned fee payer and mismatched transaction payer before fetching", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify(body()));
  };
  for (const change of [
    { feePayer: "0.0.9" },
    { transactionId: "0.0.9@100.000000001" },
  ])
    await assert.rejects(
      revalidateHederaEvidence({ ...evidence, ...change }, { fetchImpl }),
    );
  assert.equal(calls, 0);
});
test("wrong memo or payer debit cannot become confirmed evidence", async () => {
  for (const mutation of [
    (b) => (b.transactions[0].memo_base64 = "bad"),
    (b) => (b.transactions[0].transfers[0].amount = -2),
  ]) {
    const b = body();
    mutation(b);
    await assert.rejects(
      revalidateHederaEvidence(evidence, {
        fetchImpl: async () => new Response(JSON.stringify(b)),
      }),
    );
  }
});
