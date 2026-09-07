// Explicit offline transport simulation. SDK bytes/signatures are real; balances,
// consensus and mirror records are synthetic. This module has NO network client.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { digestOf } from "../packages/contracts/index.mjs";
const require = createRequire(
  new URL("../packages/payments/package.json", import.meta.url),
);
const {
  PrivateKey,
  AccountId,
  Transaction,
  TransactionId,
  TransferTransaction,
  Hbar,
  inspectHederaTransaction,
} = require("@x402/hedera");
const { ExactHederaScheme } = require("@x402/hedera/exact/facilitator");
const { encodePaymentSignatureHeader } = require("@x402/core/http");
const { stringify } = require("lossless-json");
export const terms = {
  network: "hedera:testnet",
  asset: "0.0.0",
  receiver: "0.0.1002",
  feePayer: "0.0.7162784",
};
export async function readJson(req, limit = 65536) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Error("BOUNDS");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks));
}
export function json(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(stringify(value));
}
export async function createSyntheticTransport({ store }) {
  const keys = new Map();
  let fault = null,
    ageMs = 0,
    url;
  const stats = () =>
    store.get("synthetic-stats", "counts") ?? {
      settlements: 0,
      verifications: 0,
      graphQueries: 0,
    };
  const bump = (k) => {
    const s = stats();
    s[k]++;
    store.set("synthetic-stats", "counts", s);
  };
  const scheme = new ExactHederaScheme({
    getAddresses: () => [terms.feePayer],
    verifyPayerSignature: async ({ transaction }) => ({
      ok: [...keys.values()].some((k) =>
        k.publicKey.verifyTransaction(
          Transaction.fromBytes(Buffer.from(transaction, "base64")),
        ),
      ),
    }),
    preflightTransfer: async () => ({ ok: true }), // Synthetic funds only.
    signAndSubmitTransaction: async (bytes) => {
      const v = inspectHederaTransaction(bytes),
        tx = Transaction.fromBytes(Buffer.from(bytes, "base64"));
      const id = v.transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
      store.transaction(() => {
        if (!store.get("synthetic-ledger", id)) {
          store.set("synthetic-ledger", id, {
            transaction_id: id,
            name: "CRYPTOTRANSFER",
            result: "SUCCESS",
            nonce: 0,
            scheduled: false,
            memo_base64: Buffer.from(tx.transactionMemo).toString("base64"),
            transfers: v.hbarTransfers.map((t) => ({
              account: t.accountId,
              amount: String(t.amount),
            })),
            token_transfers: [],
          });
          bump("settlements");
        }
      });
      return { transactionId: v.transactionId }; // Never broadcast.
    },
  });
  const deployment = {
    mode: "development",
    chainId: 31337,
    network: "localhost",
    startBlock: 0,
    confirmations: 1,
    address: "0x" + "1".repeat(40),
    publisher: "0x" + "2".repeat(40),
    codeHash: "0x" + "3".repeat(64),
  };
  const deploymentId = "synthetic-graph-shaped-not-a-deployment";
  const server = createServer(async (req, res) => {
    try {
      if (
        req.headers.host !== new URL(url).host ||
        req.headers.authorization ||
        req.headers.cookie
      )
        return json(res, {}, 403);
      if (req.url.startsWith("/api/v1/transactions/") && req.method === "GET") {
        if (fault === "mirror-outage") return json(res, {}, 503);
        const row = store.get(
          "synthetic-ledger",
          decodeURIComponent(req.url.split("/").at(-1)),
        );
        if (row)
          row.transfers = row.transfers.map((t) => ({
            ...t,
            amount: BigInt(t.amount),
          }));
        return json(res, { transactions: row ? [row] : [] });
      }
      if (req.url === "/supported" && req.method === "GET")
        return json(res, {
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: terms.network,
              extra: { feePayer: terms.feePayer },
            },
          ],
          extensions: [],
          signers: { "hedera:*": [terms.feePayer] },
        });
      if (req.method !== "POST") return json(res, {}, 405);
      const body = await readJson(req);
      if (req.url === "/graph") {
        bump("graphQueries");
        if (fault === "graph-outage") return json(res, {}, 503);
        const block = {
          number: 1,
          hash: "0x" + digestOf("synthetic-index-block").slice(7),
          timestamp: Math.floor((Date.now() - ageMs) / 1000),
        };
        const meta = {
          deployment: deploymentId,
          hasIndexingErrors: false,
          block,
        };
        // Empty samples are UNKNOWN, not passed. No private core bundle is indexed.
        return json(res, { data: { _meta: meta, assessmentClaims: [] } });
      }
      if (fault === "outage") return json(res, {}, 503);
      if (req.url === "/verify") {
        bump("verifications");
        return json(
          res,
          await scheme.verify(body.paymentPayload, body.paymentRequirements),
        );
      }
      if (req.url === "/settle") {
        const result = await scheme.settle(
          body.paymentPayload,
          body.paymentRequirements,
        );
        if (fault === "disconnect") {
          req.socket.destroy();
          return;
        }
        return json(res, result);
      }
      json(res, {}, 404);
    } catch {
      if (!res.headersSent) json(res, {}, 400);
      else res.destroy();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 32;
  await new Promise((r, j) => {
    server.once("error", j);
    server.listen(
      store.get("synthetic-config", "port")?.port ?? 0,
      "127.0.0.1",
      r,
    );
  });
  url = `http://127.0.0.1:${server.address().port}`;
  store.set("synthetic-config", "port", { port: server.address().port });
  return {
    url,
    deployment,
    deploymentId,
    stats,
    setFault: (v) => {
      fault = v;
    },
    setAge: (v) => {
      ageMs = v;
    },
    async authorize({ body, quote }) {
      const r = body?.accepts?.[0];
      if (
        quote?.mode !== "development" ||
        body.x402Version !== 2 ||
        body.accepts.length !== 1 ||
        r?.network !== terms.network ||
        r.asset !== terms.asset ||
        r.payTo !== terms.receiver ||
        r.extra?.feePayer !== terms.feePayer ||
        !/^\d{1,2}$/.test(r.amount) ||
        BigInt(r.amount) > 10n ||
        r.amount !== quote.amountBaseUnits ||
        !/^ethonline:/.test(r.extra.memo) ||
        r.extra.memo.length > 100
      )
        throw Error("DEVELOPMENT_PAYMENT_ONLY");
      if (keys.size >= 1000) throw Error("DEVELOPMENT_KEY_LIMIT");
      const key = PrivateKey.generateECDSA();
      const tx = new TransferTransaction()
        .setTransactionId(TransactionId.generate(terms.feePayer))
        .setNodeAccountIds([AccountId.fromString("0.0.3")])
        .setTransactionValidDuration(120)
        .setTransactionMemo(r.extra.memo)
        .setMaxTransactionFee(Hbar.fromTinybars("100000000"))
        .addHbarTransfer("0.0.1001", Hbar.fromTinybars("-" + r.amount))
        .addHbarTransfer(r.payTo, Hbar.fromTinybars(r.amount))
        .freeze();
      await tx.sign(key);
      const bytes = Buffer.from(tx.toBytes()).toString("base64");
      keys.set(digestOf(bytes), key);
      return {
        "payment-signature": encodePaymentSignatureHeader({
          x402Version: 2,
          resource: body.resource,
          accepted: r,
          payload: { transaction: bytes },
        }),
      };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      keys.clear();
    },
  };
}
