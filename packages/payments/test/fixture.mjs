import { createServer } from "node:http";
import { stringify } from "lossless-json";
import { once } from "node:events";
import {
  PrivateKey,
  AccountId,
  Transaction,
  TransactionId,
  TransferTransaction,
  Hbar,
  inspectHederaTransaction,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/facilitator";
import { ExactHederaScheme as ClientScheme } from "@x402/hedera/exact/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
export const profileId = "sha256:" + "a".repeat(64);
export const request = {
  version: "1",
  nonce: "b".repeat(64),
  providerId: "synthetic.eth",
  profileId,
  prompt: "PRIVATE_CANARY_SYNTHETIC_REQUEST_7f3c",
  maxOutputTokens: 4,
  seed: 0,
  sampling: "greedy",
  publishConsent: false,
};
export const defaults = {
  mode: "development",
  network: "hedera:testnet",
  asset: "0.0.0",
  receiver: "0.0.1002",
  feePayer: "0.0.7162784",
  providerId: "synthetic.eth",
  profileIds: [profileId],
  baseAmountBaseUnits: "100",
  perOutputTokenBaseUnits: "10",
  maxAmountBaseUnits: "1000000",
  maxTotalAmountBaseUnits: "2000000",
  quoteTtlMs: 60000,
  timeoutMs: 1000,
};
export async function proof(
  challenge,
  change = {},
  key = PrivateKey.generateECDSA(),
  { expired = false } = {},
) {
  const req = { ...challenge.accepts[0], ...change };
  const signer = {
    accountId: "0.0.1001",
    async createPartiallySignedTransferTransaction(r) {
      let tx = new TransferTransaction()
        .setTransactionId(
          expired
            ? TransactionId.fromString(r.extra.feePayer + "@1.000000001")
            : TransactionId.generate(r.extra.feePayer),
        )
        .setNodeAccountIds([AccountId.fromString("0.0.3")])
        .setTransactionValidDuration(120)
        .setTransactionMemo(r.extra.memo ?? "")
        .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
        .addHbarTransfer("0.0.1001", Hbar.fromTinybars("-" + r.amount))
        .addHbarTransfer(r.payTo, Hbar.fromTinybars(r.amount))
        .freeze();
      await tx.sign(key);
      return Buffer.from(tx.toBytes()).toString("base64");
    },
  };
  const partial = await new ClientScheme(signer).createPaymentPayload(2, req);
  const payload = { ...partial, resource: challenge.resource, accepted: req };
  return {
    payload,
    key,
    headers: { "payment-signature": encodePaymentSignatureHeader(payload) },
  };
}
export async function facilitatorFixture() {
  const state = {
    verify: 0,
    settle: 0,
    mirror: 0,
    fault: null,
    keys: new Map(),
    ledger: new Map(),
  };
  const scheme = new ExactHederaScheme({
    getAddresses: () => [defaults.feePayer],
    verifyPayerSignature: async ({ transaction }) => ({
      ok: [...state.keys.values()].some((k) =>
        k.publicKey.verifyTransaction(
          Transaction.fromBytes(Buffer.from(transaction, "base64")),
        ),
      ),
    }),
    preflightTransfer: async () => ({ ok: true }), // Explicit synthetic balances; no ledger/network access.
    signAndSubmitTransaction: async (bytes) => {
      const tx = Transaction.fromBytes(Buffer.from(bytes, "base64"));
      const view = inspectHederaTransaction(bytes);
      const id = view.transactionId
        .replace("@", "-")
        .replace(/\.(\d+)$/, "-$1");
      state.ledger.set(id, {
        transaction_id: id,
        name: "CRYPTOTRANSFER",
        result: "SUCCESS",
        nonce: 0,
        scheduled: false,
        memo_base64: Buffer.from(tx.transactionMemo).toString("base64"),
        transfers: view.hbarTransfers.map((t) => ({
          account: t.accountId,
          amount: BigInt(t.amount),
        })),
        token_transfers: [],
      });
      return { transactionId: view.transactionId }; // Simulated consensus, never broadcast.
    },
  });
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/v1/transactions/")) {
        state.mirror++;
        const t = state.ledger.get(
          decodeURIComponent(req.url.split("/").at(-1)),
        );
        if (state.fault === "mirror-outage") {
          res.writeHead(503).end("{}");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(stringify({ transactions: t ? [t] : [] }));
        return;
      }
      if (req.url === "/supported") {
        res.end(
          JSON.stringify({
            kinds: [
              {
                x402Version: 2,
                scheme: "exact",
                network: defaults.network,
                extra: { feePayer: defaults.feePayer },
              },
            ],
            extensions: [],
            signers: { "hedera:*": [defaults.feePayer] },
          }),
        );
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const { paymentPayload, paymentRequirements } = JSON.parse(
        Buffer.concat(chunks),
      );
      if (req.url === "/verify") {
        state.verify++;
        if (state.fault === "outage") {
          res.writeHead(503).end("synthetic private error");
          return;
        }
        const result = await scheme.verify(paymentPayload, paymentRequirements);
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === "/settle") {
        state.settle++;
        if (state.fault === "forged-result") {
          res.end(
            JSON.stringify({
              success: true,
              network: defaults.network,
              transaction: "0.0.9@1.000000000",
              payer: "0.0.1001",
            }),
          );
          return;
        }
        const result = await scheme.settle(paymentPayload, paymentRequirements);
        if (state.fault === "delayed-response") await state.responseGate;
        if (state.fault === "disconnect") {
          req.socket.destroy();
          return;
        }
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404).end("{}");
    } catch {
      res.writeHead(400).end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    url,
    config: {
      ...defaults,
      facilitatorUrl: url,
      mirrorUrl: url,
      resourceUrl: url + "/operation",
    },
    register: (p) => {
      state.keys.set("payer", p.key);
      return p;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
