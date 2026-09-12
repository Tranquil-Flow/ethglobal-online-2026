// Existing-attempt recovery only: no wallet key, signing, quote or public listener.
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPrivateFile,
  assertPrivateDirectory,
} from "../operations/src/private-files.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import { readJson } from "../packages/payments/src/safety.mjs";
import { validateEvidence } from "../packages/access/src/index.mjs";
import { startManagedApplication } from "./application-operator.mjs";
import { startPaidCoreBridge } from "./hedera-live-connection.mjs";
import { revalidateHederaEvidence } from "./hedera-revalidation.mjs";
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const load = (file) =>
  JSON.parse(
    readPrivateFile(file, {
      maxBytes: 2097152,
      code: "PRIVATE_RECOVERY_INPUT_REQUIRED",
    }).data.toString(),
  );
const save = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
export async function connectReconciliation({
  network,
  maxAmountBaseUnits,
  signal,
}) {
  if (network !== "hedera:testnet" || maxAmountBaseUnits !== "1")
    fail("ONE_TINYBAR_RECONCILIATION_REQUIRED");
  const wave = resolve(
    fileURLToPath(new URL("../../.private/wave5", import.meta.url)),
  );
  const configFile = resolve(process.env.WAVE5_HEDERA_CONFIG_FILE ?? "");
  if (!configFile.startsWith(wave + "/")) fail("PRIVATE_WAVE5_CONFIG_REQUIRED");
  const cfg = load(configFile),
    root = resolve(cfg.privateRoot);
  if (!root.startsWith(wave + "/")) fail("PRIVATE_WAVE5_CONFIG_REQUIRED");
  assertPrivateDirectory(root);
  const original = load(join(root, "request.json")),
    quote = load(join(root, "quote.json")),
    session = load(join(root, "session.json")),
    journal = load(join(root, "wallet-journal.json"));
  if (
    journal.status !== "signed-not-broadcast-by-wallet" ||
    journal.requestHash !== digestOf(original) ||
    journal.quoteId !== quote.quoteId ||
    quote.amountBaseUnits !== "1"
  )
    fail("ORIGINAL_PAYMENT_REQUIRED");
  const payload = JSON.parse(
    Buffer.from(journal.headers["payment-signature"], "base64").toString(),
  );
  const payment = {
    network,
    payer: "0.0.10419268",
    receiver: "0.0.10419316",
    feePayer: "0.0.7162784",
    transactionId: journal.transactionId,
    amountTinybars: "1",
    memo: payload.accepted.extra.memo,
  };
  const readback = await revalidateHederaEvidence(payment, { signal });
  const dataDir = join(root, "app"),
    operator = load(join(dataDir, "operator.json")),
    spec = operator.providers[0].payment;
  const providerId = original.providerId,
    profileId = original.profileId,
    binding = digestOf({ providerId, profileIds: [profileId], spec });
  if (
    spec.config.maxTotalAmountBaseUnits !== "1" ||
    spec.config.providerId !== providerId
  )
    fail("ORIGINAL_PAYMENT_POLICY_REQUIRED");
  let app, bridge;
  const close = async () => {
    try {
      await bridge?.close();
    } finally {
      await app?.close();
    }
    save(join(root, "reconciliation-closed.json"), {
      closedAt: new Date().toISOString(),
      publicListenerOpened: false,
      payerKeyLoaded: false,
    });
  };
  try {
    app = await startManagedApplication({
      configFile: join(dataDir, "application.json"),
      ordinaryPaidAuthority: {
        assertOrdinaryPaidLiveAuthorized(context) {
          if (context.binding !== binding)
            fail("PAYMENT_AUTHORITY_BINDING_MISMATCH");
          return {
            version: "1",
            decision: "authorized",
            purpose: "ordinary-paid-live-unchecked-v1",
            decisionId: "wave5-existing-paid-attempt",
            binding,
            decidedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 180000).toISOString(),
          };
        },
      },
    });
    bridge = await startPaidCoreBridge({
      appUrl: app.url,
      capability: session.capability,
      request: original,
      stateDirectory: root,
      inference: true,
    });
    return {
      url: bridge.url,
      expected: { mode: "live", network, ...spec.config },
      request: original,
      capability: session.capability,
      reconciliation: {
        ...payment,
        quoteId: quote.quoteId,
        requestHash: digestOf(original),
        payerKeyLoaded: false,
      },
      walletAuthorize: async () => fail("RECONCILIATION_CANNOT_SIGN"),
      close,
      async recordResult(result) {
        const outcome = result.body;
        const response = await fetch(
          app.url +
            "/v1/jobs/" +
            encodeURIComponent(outcome.jobId) +
            "/evidence",
          {
            headers: { authorization: "Bearer " + session.capability },
            signal,
          },
        );
        if (!response.ok) fail("PAID_EVIDENCE_UNAVAILABLE");
        const bundle = await readJson(response, 2097152);
        await validateEvidence(bundle, {
          ...app.pins[providerId],
          expected: {
            request: original,
            jobId: outcome.jobId,
            quoteId: quote.quoteId,
            paymentId: outcome.payment.paymentId,
            output: outcome.output,
          },
        });
        if (
          outcome.payment.transactionRef !== journal.transactionId ||
          digestOf(bundle.receipt) !== digestOf(outcome.receipt)
        )
          fail("PAID_TRANSACTION_MISMATCH");
        save(join(root, "evidence-private.json"), bundle);
        save(join(root, "public-evidence.json"), {
          ...payment,
          readback,
          mode: "live",
          paymentStatus: outcome.payment.status,
          executionStatus: outcome.execution,
          jobId: outcome.jobId,
          receiptDigest: digestOf(bundle.receipt),
          profileId,
          providerId,
          outputBytes: Buffer.byteLength(outcome.output.text),
          receiptIntegrity: true,
          originalRequestBound: true,
          inference: true,
          inferenceVerified: false,
          verificationMethodSelected: false,
          publishConsent: false,
          consumptionTransport: "loopback-same-attempt-reconciliation",
          publicPaidCompletionQualified: false,
          initialPublicTls: load(join(root, "tls-observation.json")),
          publicListenerOpened: false,
          payerKeyLoaded: false,
          newSignatures: 0,
          observedAt: new Date().toISOString(),
        });
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
