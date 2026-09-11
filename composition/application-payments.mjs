import { createPayments } from "../packages/payments/src/index.mjs";
import { createNonEconomicAccess } from "../packages/payments/src/non-economic.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
const fail = (c) => {
  const e = Error(c);
  e.code = c;
  throw e;
};
const object = (x) => x && typeof x === "object" && !Array.isArray(x);
const exact = (x, keys) =>
  object(x) && Object.keys(x).sort().join() === keys.sort().join();
const freeze = (x) => {
  if (object(x) || Array.isArray(x)) {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
const configFields = [
  "mode",
  "network",
  "asset",
  "receiver",
  "feePayer",
  "providerId",
  "profileIds",
  "facilitatorUrl",
  "mirrorUrl",
  "resourceUrl",
  "baseAmountBaseUnits",
  "perOutputTokenBaseUnits",
  "maxAmountBaseUnits",
  "maxTotalAmountBaseUnits",
  "quoteTtlMs",
  "timeoutMs",
  "maxQuotesPerPrincipal",
  "maxQuotes",
  "allowLiveSettlement",
  "allowDevelopmentTls",
];
/** An offline config descriptor, not financial authorization. */
export function inspectManagedPayments({
  spec: input,
  mode,
  providerId,
  profileIds,
}) {
  if (
    !["live", "development"].includes(mode) ||
    typeof providerId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(providerId) ||
    !Array.isArray(profileIds) ||
    !profileIds.length ||
    profileIds.length > 128 ||
    new Set(profileIds).size !== profileIds.length ||
    profileIds.some((p) => !/^sha256:[a-f0-9]{64}$/.test(p))
  )
    fail("INVALID_MANAGED_PAYMENT_CONTEXT");
  profileIds = [...profileIds];
  const spec = structuredClone(
    input ?? { version: "1", policy: "non-economic" },
  );
  if (spec?.policy === "protected-verifier-contingent")
    fail("PROTECTED_PAYMENT_UNAVAILABLE");
  if (
    !object(spec) ||
    spec.version !== "1" ||
    !["non-economic", "ordinary-paid-x402"].includes(spec.policy)
  )
    fail("INVALID_MANAGED_PAYMENT_POLICY");
  if (spec.policy === "non-economic") {
    if (
      !exact(spec, [
        "version",
        "policy",
        ...(spec.maxRecords === undefined ? [] : ["maxRecords"]),
        ...(spec.quoteTtlMs === undefined ? [] : ["quoteTtlMs"]),
      ])
    )
      fail("INVALID_MANAGED_PAYMENT_POLICY");
    for (const [key, max] of [
      ["maxRecords", 1000000],
      ["quoteTtlMs", 120000],
    ])
      if (
        spec[key] !== undefined &&
        (!Number.isSafeInteger(spec[key]) || spec[key] < 1 || spec[key] > max)
      )
        fail("INVALID_MANAGED_PAYMENT_POLICY");
    const offerTerms = freeze({
      network: "non-economic",
      asset: "none",
      receiver: providerId,
      mode,
    });
    return Object.freeze({
      offerTerms,
      description: "non-economic zero-value admission; no settlement",
      create({ store }) {
        return createNonEconomicAccess({
          store,
          mode,
          providerId,
          profileIds: [...profileIds],
          ...Object.fromEntries(
            ["maxRecords", "quoteTtlMs"]
              .filter((k) => spec[k] !== undefined)
              .map((k) => [k, spec[k]]),
          ),
        });
      },
    });
  }
  if (
    !exact(spec, ["version", "policy", "hostPolicy", "config"]) ||
    !exact(spec.hostPolicy, [
      "version",
      "purpose",
      "resourceOrigin",
      "facilitatorOrigin",
      "mirrorOrigin",
    ]) ||
    spec.hostPolicy.version !== "1" ||
    spec.hostPolicy.purpose !== "managed-x402-host-allowlist"
  )
    fail("INVALID_MANAGED_PAYMENT_POLICY");
  const c = spec.config;
  if (!object(c) || Object.keys(c).some((k) => !configFields.includes(k)))
    fail("INVALID_MANAGED_PAYMENT_CONFIG");
  if (c.mode !== mode) fail("PAYMENT_MODE_MISMATCH");
  if (c.providerId !== providerId) fail("PAYMENT_PROVIDER_MISMATCH");
  if (
    !Array.isArray(c.profileIds) ||
    c.profileIds.length !== profileIds.length ||
    [...c.profileIds].sort().join() !== [...profileIds].sort().join()
  )
    fail("PAYMENT_PROFILE_MISMATCH");
  for (const name of ["resource", "facilitator", "mirror"]) {
    let origin;
    try {
      origin = new URL(c[name + "Url"]).origin;
    } catch {
      fail("INVALID_CONFIG");
    }
    if (origin !== spec.hostPolicy[name + "Origin"])
      fail("PAYMENT_HOST_POLICY_MISMATCH");
  }
  // Reuse the production parser. This private in-memory validation store performs
  // no filesystem, network, signing or caller-store activity.
  createPayments({
    config: c,
    store: {
      transaction: (f) => f(),
      getMetadata: () => undefined,
      setMetadata() {},
      close() {},
    },
  }).close();
  const offerTerms = freeze({
    network: c.network,
    asset: c.asset,
    receiver: c.receiver,
    mode,
  });
  const context = freeze({
    providerId,
    profileIds: [...profileIds],
    mode,
    hostPolicy: spec.hostPolicy,
    offerTerms,
    maxTotalAmountBaseUnits: c.maxTotalAmountBaseUnits,
    binding: digestOf({ providerId, profileIds: [...profileIds].sort(), spec }),
  });
  return Object.freeze({
    offerTerms,
    description:
      mode === "development"
        ? "synthetic development x402; no external calls unless explicitly invoked against local fixtures"
        : "ordinary paid unchecked service; not protected financial settlement",
    create({ store, ordinaryPaidAuthority }) {
      function authority() {
        if (mode !== "live") return;
        if (
          typeof ordinaryPaidAuthority?.assertOrdinaryPaidLiveAuthorized !==
          "function"
        )
          fail("ORDINARY_PAID_AUTHORITY_REQUIRED");
        let d;
        try {
          d = ordinaryPaidAuthority.assertOrdinaryPaidLiveAuthorized(context);
        } catch {
          fail("INVALID_ORDINARY_PAID_AUTHORITY");
        }
        const now = Date.now();
        if (
          !exact(d, [
            "version",
            "decision",
            "purpose",
            "decisionId",
            "binding",
            "decidedAt",
            "expiresAt",
          ]) ||
          d.version !== "1" ||
          d.decision !== "authorized" ||
          d.purpose !== "ordinary-paid-live-unchecked-v1" ||
          typeof d.decisionId !== "string" ||
          !d.decisionId ||
          d.binding !== context.binding ||
          !Number.isFinite(Date.parse(d.decidedAt)) ||
          !Number.isFinite(Date.parse(d.expiresAt)) ||
          Date.parse(d.decidedAt) > now ||
          Date.parse(d.expiresAt) <= now
        )
          fail("INVALID_ORDINARY_PAID_AUTHORITY");
      }
      authority();
      const port = createPayments({ config: c, store });
      return Object.freeze(
        Object.fromEntries(
          Object.entries(port).map(([key, value]) => [
            key,
            typeof value === "function" && key !== "close"
              ? async (...args) => {
                  authority();
                  return value(...args);
                }
              : value,
          ]),
        ),
      );
    },
  });
}
