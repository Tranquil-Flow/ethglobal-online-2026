const NETWORK_CODES = new Set([
  "INVALID_RESPONSE",
  "UPSTREAM_UNAVAILABLE",
  "NETWORK_ERROR",
  "TIMEOUT",
  "SSE_INTERRUPTED",
]);

const BUSY_CODES = new Set([
  "STALE_QUALIFICATION",
  "RUNTIME_BUSY",
  "PROVIDER_BUSY",
  "JOB_IN_PROGRESS",
  "NATIVE_TIMEOUT",
  "NATIVE_BUSY",
  "INVALID_NATIVE_BINDING",
  "RUNTIME_BINDING_MISMATCH",
  "NATIVE_MODEL_MISMATCH",
  "RUNTIME_PROFILE_CATALOG_MISMATCH",
]);

const IDENTITY_CODES = new Set([
  "INVALID_OFFER_SIGNATURE",
  "INVALID_SIGNED_OFFER",
  "PROFILE_MISMATCH",
  "KEY_PIN_REQUIRED",
  "MODE_MISMATCH",
]);

// Payment-layer outcomes. These are deliberately NOT collapsed into a generic
// "try again": once a sponsored payment has been signed, the honest answer is
// whether it settled, and whether anything was served for it.
const PAYMENT_CODES = new Map([
  [
    "PAYMENT_PENDING",
    {
      tone: "danger",
      message:
        "The sponsored payment was submitted but Hedera had not confirmed it when we stopped waiting. No job was started for it — check the attempt's Hedera transaction before asking again.",
      action: "none",
      retryable: false,
    },
  ],
  [
    "SETTLEMENT_AMBIGUOUS",
    {
      tone: "danger",
      message:
        "The sponsored payment may have settled, but the confirmation was ambiguous. No job was started — check the Hedera transaction before asking again.",
      action: "none",
      retryable: false,
    },
  ],
  [
    "PAYMENT_UNAVAILABLE",
    {
      tone: "danger",
      message:
        "The payment step failed before the request was accepted, so no answer was produced. If a Hedera transfer for this attempt exists, do not pay again — report it.",
      action: "none",
      retryable: false,
    },
  ],
  [
    "FACILITATOR_UNAVAILABLE",
    {
      tone: "warning",
      message:
        "The Hedera payment facilitator could not be reached. Nothing was charged; try again shortly.",
      action: "retry",
      retryable: true,
    },
  ],
  [
    "QUOTE_EXPIRED",
    {
      tone: "warning",
      message: "The quote expired before payment. Nothing was charged — ask again for a fresh quote.",
      action: "fresh-quote",
      retryable: true,
    },
  ],
  [
    "CONFLICT",
    {
      tone: "danger",
      message:
        "This request already has a payment on file under a different proof. Nothing new was charged; ask a fresh question instead of resubmitting this one.",
      action: "fresh-quote",
      retryable: false,
    },
  ],
]);

const DEMO_CODES = new Set([
  "DEMO_UNAVAILABLE",
  "DEMO_SPONSOR_UNAVAILABLE",
  "DEMO_SPONSOR_FAILED",
  "RATE_LIMITED",
  "DEMO_RATE_LIMITED",
  "DEMO_QUEUE_FULL",
  "DEMO_QUOTE_CONSUMED",
]);

function readCode(error) {
  if (!error) return "UNKNOWN";
  if (typeof error === "string") return error;
  if (typeof error.code === "string") return error.code;
  if (typeof error.message === "string" && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return "UNKNOWN";
}

export function friendlyError(error, context = {}) {
  const code = readCode(error);
  const lowered = String(error?.message ?? code).toLowerCase();
  if (context.pendingSubmission || code === "SUBMISSION_UNCERTAIN") {
    return {
      code,
      tone: "warning",
      message: "We're not sure your request went through. Don't pay again — we're checking.",
      action: "poll",
      retryable: false,
    };
  }
  if (NETWORK_CODES.has(code) || lowered.includes("network") || lowered.includes("timeout")) {
    return {
      code,
      tone: "warning",
      message: context.retryExhausted
        ? "Still down — try again in a minute."
        : "We're having trouble reaching the network. Trying again…",
      action: "retry",
      retryable: true,
    };
  }
  if (BUSY_CODES.has(code) || code.startsWith("NATIVE_")) {
    return {
      code,
      tone: "warning",
      message: "The model is busy or warming up. Try again shortly.",
      action: "retry",
      retryable: true,
    };
  }
  if (IDENTITY_CODES.has(code)) {
    return {
      code,
      tone: "danger",
      message: "We couldn't verify this provider's identity, so we stopped before paying.",
      action: "change-provider",
      retryable: false,
    };
  }
  if (PAYMENT_CODES.has(code)) {
    return { code, ...PAYMENT_CODES.get(code) };
  }
  if (DEMO_CODES.has(code)) {
    return {
      code,
      tone: "warning",
      message: "Free demo credit is used up for now. Try later or pay with a Hedera wallet.",
      action: "wallet",
      retryable: false,
    };
  }
  if (code === "DEMO_SCOPE_MISMATCH") {
    return {
      code,
      tone: "warning",
      message:
        "Demo credit did not match the quote the server stored for this request, so the attempt stopped before any payment was signed. Ask again for a fresh quote.",
      action: "fresh-quote",
      retryable: true,
    };
  }
  if (code === "WALLET_NOT_CONNECTED" || code === "HASHPACK_NOT_INSTALLED") {
    return {
      code,
      tone: "warning",
      message:
        code === "HASHPACK_NOT_INSTALLED"
          ? "HashPack was not detected in this browser — install the extension, make sure it has site access for mycelium.now, and unlock it. Then try again, or use free demo credit."
          : "HashPack did not finish connecting — open the extension, unlock it, and approve the connection. Or use free demo credit.",
      action: "demo",
      retryable: false,
    };
  }
  if (code === "WALLET_REJECTED" || lowered.includes("reject") || lowered.includes("cancel")) {
    return {
      code,
      tone: "neutral",
      message: "Payment cancelled — nothing was charged.",
      action: "none",
      retryable: false,
    };
  }
  if (code === "CAPABILITY_EXPIRED" || code === "AUTH_REQUIRED") {
    return {
      code,
      tone: "warning",
      message: "Your session expired — nothing was charged. Ask again.",
      action: "reconnect",
      retryable: true,
    };
  }
  return {
    code,
    tone: "warning",
    message: "Something went wrong before the answer finished. Nothing will be paid twice.",
    action: "retry",
    retryable: Boolean(error?.retryable),
  };
}

export function codeLine(error) {
  const code = readCode(error);
  return code && code !== "UNKNOWN" ? `Error code: ${code}` : "";
}

export { readCode };
