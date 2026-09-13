// Resume the retained W6 free or paid managed app without reinitializing its
// directory. This updates only launch-bound origin configuration and the
// regenerated native-gateway token copy; journals and identities are retained.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startManagedApplication } from "../application-operator.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { createDemoSponsor } from "../w6-demo-sponsor.mjs";
import { createVerifiedExecutor } from "../w6-verified-executor.mjs";
import { createPaidObservationBridge } from "../w6-paid-observation-bridge.mjs";
import { reconcilePaymentStoreConfiguration } from "../w6-payment-store-reconcile.mjs";

const mode = process.argv[2];
if (!new Set(["free", "paid"]).has(mode)) throw new Error("Usage: resume-retained-app.mjs free|paid");
const runtimeRoot = process.env.W6_RUNTIME_ROOT
  ?? "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z";
const appRoot = join(runtimeRoot, mode === "paid" ? "application-live-paid-01" : "application-live-02");
const nativeRoot = join(runtimeRoot, "native-preparation-01");
const configFile = join(appRoot, "application.json");
const operatorFile = join(appRoot, "operator.json");
const origin = process.env.W6_PUBLIC_ORIGIN;
if (!origin) throw new Error("W6_PUBLIC_ORIGIN_REQUIRED");
if (!existsSync(configFile) || !existsSync(operatorFile)) {
  throw new Error("RETAINED_APP_STATE_REQUIRED — supervisors never initialize or reset journals");
}
if (mode === "paid" && process.env.W6_REUSE_PAID_ROOT !== "1") {
  throw new Error("W6_REUSE_PAID_ROOT_REQUIRED");
}

const config = JSON.parse(readFileSync(configFile, "utf8"));
const operator = JSON.parse(readFileSync(operatorFile, "utf8"));
if (config.mode !== "live") throw new Error("RETAINED_APP_NOT_LIVE");
if (mode === "paid" && config.accessPolicy !== "ordinary-paid-x402") throw new Error("RETAINED_PAID_POLICY_MISMATCH");
if (mode === "free" && config.accessPolicy !== "non-economic") throw new Error("RETAINED_FREE_POLICY_MISMATCH");
config.publicOrigin = origin;

if (mode === "paid") {
  let updated = 0;
  for (const provider of operator.providers ?? []) {
    if (!provider.payment?.hostPolicy || !provider.payment?.config) continue;
    provider.payment.hostPolicy.resourceOrigin = origin;
    provider.payment.config.resourceUrl = `${origin}/v1/jobs`;
    updated += 1;
  }
  if (updated === 0) throw new Error("RETAINED_PAYMENT_CONFIG_REQUIRED");
}

// PARENT FIXTURE GATE (L-ENV-LIVE-FIX-GATE):
//   Moved from composition/w6-live-app-paid.mjs so the fixture URL,
//   evidence class, and bearer token are written into operator.json
//   BEFORE the supervisor persists it. With the gate applied this
//   early, downstream code that reads operator.json (w6-live-app-paid.mjs
//   `for (const [i, p] of manifest.providers.entries())` loop, the
//   qualification check, the executor runtime) sees the fixture URL +
//   synthetic_test_fixture evidence class and never tries to dial
//   127.0.0.1:8791 against the offline node-0.
//
//   When the gate is off (default), nothing here changes operator.json
//   — runtime.baseUrl and runtime.options.expectedEvidenceClass keep
//   their on-disk values, and bearerTokenFile still references the
//   regenerated native-gateway-token.txt.
//
//   Configuration:
//     W6_NATIVE_FALLBACK_FIXTURE  -> "1" or "true" to enable (otherwise off)
//     W6_NATIVE_FIXTURE_URL      -> loopback origin, default
//                                    http://127.0.0.1:8765
//     W6_NATIVE_FIXTURE_TOKEN    -> bearer token expected by the fixture
//                                    server, default = the current native
//                                    gateway token content
const fixtureGate =
  process.env.W6_NATIVE_FALLBACK_FIXTURE === "1" ||
  process.env.W6_NATIVE_FALLBACK_FIXTURE === "true";
if (fixtureGate) {
  const fixtureBaseUrl = process.env.W6_NATIVE_FIXTURE_URL || "http://127.0.0.1:8765";
  const fixtureBearerToken =
    process.env.W6_NATIVE_FIXTURE_TOKEN ||
    readFileSync(join(nativeRoot, "request-gateway-token.txt"), "utf8").trim();
  const fixtureExpectedEvidenceClass = "synthetic_test_fixture";
  let fixtureProvidersTouched = 0;
  for (const provider of operator.providers ?? []) {
    if (!provider.runtime) continue;
    provider.runtime.baseUrl = fixtureBaseUrl;
    provider.runtime.options ??= {};
    provider.runtime.options.expectedEvidenceClass = fixtureExpectedEvidenceClass;
    fixtureProvidersTouched += 1;
  }
  if (fixtureProvidersTouched === 0) {
    throw new Error("FIXTURE_GATE_NO_RUNTIME_PROVIDERS — operator.json has no provider.runtime blocks to override");
  }
  console.log(
    JSON.stringify({
      status: "fixture-gate-applied",
      baseUrl: fixtureBaseUrl,
      expectedEvidenceClass: fixtureExpectedEvidenceClass,
      providersTouched: fixtureProvidersTouched,
    }),
  );
}

function replacePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
replacePrivateJson(configFile, config);
replacePrivateJson(operatorFile, operator);
const paidStateDir = process.env.W6_APP_STATE_DIR ?? join(appRoot, "w6-paid-state");
if (mode === "paid") {
  mkdirSync(paidStateDir, { recursive: true, mode: 0o700 });
  process.env.W6_APP_STATE_DIR = paidStateDir;
  for (const provider of operator.providers ?? []) {
    if (!provider.payment?.config) continue;
    const path = join(
      appRoot,
      "providers",
      digestOf(provider.providerId).slice(7),
      "payments.sqlite",
    );
    let result, error;
    try {
      result = reconcilePaymentStoreConfiguration({
        path,
        config: provider.payment.config,
        configWritten: true,
      });
    } catch (e) {
      // Store has retained payments under a previous config binding; the
      // supervisor must NOT silently discard them. Log the conflict and
      // continue starting so other providers / app boot are not blocked.
      error = e?.code ?? e?.message ?? String(e);
    }
    console.log(
      JSON.stringify({
        status: "payment-store-config",
        providerId: provider.providerId,
        ...(result ? { result } : {}),
        ...(error ? { error } : {}),
      }),
    );
  }
}
writeFileSync(
  `${join(appRoot, "native-gateway-token.txt")}.${process.pid}.tmp`,
  readFileSync(join(nativeRoot, "request-gateway-token.txt")),
  { mode: 0o600, flag: "wx" },
);
renameSync(
  `${join(appRoot, "native-gateway-token.txt")}.${process.pid}.tmp`,
  join(appRoot, "native-gateway-token.txt"),
);

const ordinaryPaidAuthority = mode === "paid"
  ? {
      assertOrdinaryPaidLiveAuthorized(context) {
        const now = Date.now();
        return {
          version: "1",
          decision: "authorized",
          purpose: "ordinary-paid-live-unchecked-v1",
          decisionId: `w6-supervised-paid-${Math.floor(now / 1000).toString(36)}`,
          binding: context.binding,
          decidedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 600_000).toISOString(),
        };
      },
    }
  : undefined;

const observationBridge =
  mode === "paid"
    ? createPaidObservationBridge({ env: process.env, stateDir: paidStateDir })
    : undefined;
const app = await startManagedApplication({
  configFile,
  ...(ordinaryPaidAuthority ? { ordinaryPaidAuthority } : {}),
  ...(mode === "paid"
    ? {
        createDemoSponsor: ({ getOutstandingQuote }) =>
          createDemoSponsor({ deps: { getOutstandingQuote } }),
        wrapExecutor: ({ executor, providerId }) =>
          createVerifiedExecutor({
            executor,
            bridge: observationBridge,
            providerId,
          }),
      }
    : {}),
});
console.log(JSON.stringify({ status: `${mode}-app-resumed`, url: app.url }));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
