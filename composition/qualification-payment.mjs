import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestOf } from "../packages/contracts/index.mjs";
import { createApp, createStore } from "../packages/core/src/index.mjs";
import { createPayments } from "../packages/payments/src/index.mjs";
import { createClient } from "../packages/access/src/index.mjs";

const APPROVAL = "hedera-testnet-live-settlement";

/**
 * Profile for a deterministic utility service. It counts UTF-8 input bytes; it
 * neither loads nor executes an inference model, and its byte IDs are not model tokens.
 */
export const NON_INFERENCE_PROFILE = Object.freeze({
  version: "1",
  model: "deterministic-utf8-byte-count-not-inference",
  artifacts: [],
  runtimeRevision: "qualification-utf8-count-v1",
  tokenizerDigest: digestOf("utf8-output-bytes-not-model-tokens-v1"),
  templateDigest: digestOf("decimal-utf8-input-byte-count-v1"),
  numerics: Object.freeze({
    dtype: "not-applicable",
    quantization: "none",
    backend: "javascript-buffer-byte-length",
    hardwareClass: "not-model-execution",
    determinism: "UTF-8 input byte count rendered in ASCII decimal; output byte IDs are not model tokens",
  }),
});

/** A live-mode-compatible ExecutionPort for a precisely non-inference service. */
export function createUtf8CountNonInferenceExecutor() {
  return Object.freeze({
    mode: "live",
    serviceKind: "deterministic-noninference",
    async *execute({ request, profile, signal }) {
      if (signal?.aborted) throw signal.reason ?? new Error("ABORTED");
      const complete = String(Buffer.byteLength(request.prompt, "utf8"));
      const bytes = [...Buffer.from(complete, "utf8")];
      const selected = bytes.slice(0, request.maxOutputTokens);
      const text = Buffer.from(selected).toString("utf8");
      if (selected.length) yield { type: "delta", text, tokenIds: selected };
      yield {
        type: "completed",
        output: {
          text,
          tokenIds: selected,
          finishReason: selected.length < bytes.length ? "length" : "stop",
        },
        profileId: digestOf(profile),
      };
    },
  });
}

function privateDirectory(dataDir) {
  if (typeof dataDir !== "string" || !dataDir) throw Error("PRIVATE_DATA_DIRECTORY_REQUIRED");
  const dir = resolve(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.uid !== process.getuid())
    throw Error("PRIVATE_DATA_DIRECTORY_REQUIRED");
  return dir;
}

function httpsResourceIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw Error("HTTPS_RESOURCE_IDENTITY_REQUIRED");
  }
}

/**
 * Narrow qualification bootstrap. The public HTTPS resource identity is an
 * explicit x402 identity only; the core HTTP listener and SDK transport stay loopback.
 * Construction performs no wallet operation and no settlement. A submitted paid
 * job can settle only through the caller-injected SDK paymentAuthorizer.
 */
export async function startTestnetPaymentQualification({
  approval,
  dataDir,
  port = 0,
  resourceUrl,
  paymentConfig,
  signer,
  receiptKeyId,
  paymentAuthorizer,
  profile = NON_INFERENCE_PROFILE,
  executor = createUtf8CountNonInferenceExecutor(),
  ...unknown
} = {}) {
  if (Object.keys(unknown).length) throw Error("UNKNOWN_QUALIFICATION_OPTION");
  if (approval !== APPROVAL) throw Error("LIVE_TESTNET_APPROVAL_REQUIRED");
  if (!paymentConfig || paymentConfig.mode !== "live" || paymentConfig.network !== "hedera:testnet")
    throw Error("HEDERA_TESTNET_REQUIRED");
  if (paymentConfig.allowLiveSettlement !== undefined && paymentConfig.allowLiveSettlement !== true)
    throw Error("LIVE_TESTNET_APPROVAL_REQUIRED");
  if (paymentConfig.resourceUrl !== undefined || paymentConfig.databasePath !== undefined)
    throw Error("BOOTSTRAP_OWNS_PRIVATE_PAYMENT_STATE_AND_RESOURCE_IDENTITY");
  if (!signer || typeof signer.sign !== "function" || typeof signer.publicKey !== "function")
    throw Error("EXPLICIT_RECEIPT_SIGNER_REQUIRED");
  if (typeof receiptKeyId !== "string" || !receiptKeyId) throw Error("RECEIPT_KEY_ID_REQUIRED");
  if (typeof paymentAuthorizer !== "function") throw Error("EXPLICIT_PAYMENT_AUTHORIZER_REQUIRED");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("INVALID_LOOPBACK_PORT");
  if (executor?.mode !== "live" || executor?.serviceKind !== "deterministic-noninference" || typeof executor.execute !== "function")
    throw Error("NONINFERENCE_EXECUTOR_REQUIRED");

  const identity = httpsResourceIdentity(resourceUrl);
  const dir = privateDirectory(dataDir);
  const profileId = digestOf(profile);
  const publicKey = signer.publicKey(receiptKeyId);
  let store;
  let payments;
  let app;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const release of [() => app?.close(), () => payments?.close(), () => store?.close()]) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "QUALIFICATION_CLEANUP_FAILED");
  };

  try {
    store = createStore({ path: join(dir, "core.sqlite") });
    payments = createPayments({
      config: {
        ...structuredClone(paymentConfig),
        mode: "live",
        network: "hedera:testnet",
        allowLiveSettlement: true,
        profileIds: [profileId],
        databasePath: join(dir, "payments.sqlite"),
        resourceUrl: identity,
      },
    });
    app = createApp({
      config: {
        mode: "live",
        profiles: [profile],
        providerIds: [paymentConfig.providerId],
      },
      store,
      signer,
      executor,
      payments,
    });
    const { url } = await app.listen({ host: "127.0.0.1", port });
    const client = createClient({
      baseUrl: url,
      paymentAuthorizer,
      pins: {
        providerId: paymentConfig.providerId,
        keyId: receiptKeyId,
        publicKeyJwk: publicKey.publicKeyJwk,
      },
    });
    return Object.freeze({
      url,
      resourceUrl: identity,
      providerId: paymentConfig.providerId,
      profileId,
      profile,
      pins: Object.freeze({
        providerId: paymentConfig.providerId,
        keyId: receiptKeyId,
        publicKeyJwk: publicKey.publicKeyJwk,
      }),
      client,
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
