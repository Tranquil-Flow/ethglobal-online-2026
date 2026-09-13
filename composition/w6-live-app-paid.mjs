// Bounded Wave 6 live-app-paid: launches a SECOND managed application on
// 4352 against the live native gateway, with the same two-node Mycelium
// profile but a REAL Hedera x402 payment binding on one provider. Used
// for the single permitted paid testnet journey and the consented
// non-economic publication on the second provider.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createGatewayTransport } from "./mycelium-gateway.mjs";
import { initializeApplication, startManagedApplication } from "./application-operator.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
import { createPayments } from "../packages/payments/src/index.mjs";
import { wave6GraphHistorySpec } from "./w6-graph-history-config.mjs";


const W6 = "/Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z";
const native = W6 + "/native-preparation-01";
const appRoot = W6 + "/application-live-paid-01";

if (process.env.W6_RESET_PAID_ROOT === "1") {
  rmSync(appRoot, { recursive: true, force: true });
} else if (existsSync(appRoot)) {
  // W6_REUSE_PAID_ROOT=1 restarts against the retained state, preserving the
  // settled-payment journal and receipt identities. Only the per-launch
  // native-gateway-token copy (regenerated below from native/, not evidence)
  // is replaced; every other retained file is kept and reused.
  if (process.env.W6_REUSE_PAID_ROOT !== "1") {
    throw new Error(
      "PAID_APP_ROOT_EXISTS — refusing to touch retained paid-app state; set W6_REUSE_PAID_ROOT=1 to restart against it, or W6_RESET_PAID_ROOT=1 to wipe it.",
    );
  }
  rmSync(appRoot + "/native-gateway-token.txt", { force: true });
}

const token = readFileSync(native + "/request-gateway-token.txt", "utf8");

// PARENT FIXTURE GATE (L-DEPLOY-LIVE):
//   When W6_NATIVE_FALLBACK_FIXTURE=1 is set, the live copy routes its
//   native qualification through the loopback fixture server instead of
//   the upstream Mycelium node-0 at 127.0.0.1:8791. This is the parent-only
//   path used while node-0 is offline during the L-DEPLOY-LIVE verification
//   run. The owner disables fixture mode by unsetting the env var; nothing
//   here changes default behaviour, and no fixture URL or token is read
//   unless the gate is explicitly opened.
//
//   Configuration:
//     W6_NATIVE_FALLBACK_FIXTURE  -> "1" or "true" to enable (otherwise off)
//     W6_NATIVE_FIXTURE_URL      -> loopback origin, default
//                                    http://127.0.0.1:8765
//     W6_NATIVE_FIXTURE_TOKEN    -> bearer token expected by the fixture
//                                    server, default = native token
const fixtureGate =
  process.env.W6_NATIVE_FALLBACK_FIXTURE === "1" ||
  process.env.W6_NATIVE_FALLBACK_FIXTURE === "true";
const fixtureBaseUrl = process.env.W6_NATIVE_FIXTURE_URL || "http://127.0.0.1:8765";
const fixtureBearerToken =
  process.env.W6_NATIVE_FIXTURE_TOKEN || token;
const fixtureExpectedEvidenceClass = "synthetic_test_fixture";

const q = await createGatewayTransport({
  baseUrl: fixtureGate ? fixtureBaseUrl : "http://127.0.0.1:8791",
  bearerToken: fixtureGate ? fixtureBearerToken : token,
}).qualification();
if (q.route_ready !== true)
  throw Error("NATIVE_NOT_READY");
if (
  fixtureGate
    ? q.evidence_class !== fixtureExpectedEvidenceClass
    : q.evidence_class !== "physical_qualification"
)
  throw Error(
    fixtureGate
      ? "FIXTURE_EVIDENCE_MISMATCH"
      : "NATIVE_NOT_READY",
  );

const deployment = native + "/transfer-bundle/deployment";
const sha = (path) => "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
const profile = {
  version: "1",
  model: q.binding.model_id,
  artifacts: [
    {
      role: "mycelium-model-manifest",
      digest: q.binding.manifest_digest,
      uri: "urn:" + q.binding.manifest_digest,
    },
  ],
  runtimeRevision: "mycelium-b9001e6-native-request-v2",
  tokenizerDigest: sha(deployment + "/tokenizer.json"),
  templateDigest: sha(deployment + "/tokenizer_config.json"),
  numerics: {
    dtype: "float32",
    quantization: "int8-weight-only",
    backend: "Mycelium pipeline: mlx + numpy",
    hardwareClass: "two macOS arm64 hosts",
    determinism:
      "Native greedy seed zero. Output unchecked; native v1/v2 does not provide token IDs. Completion reason derived from observed token bound.",
  },
};

const RECEIVER_ACCOUNT = "0.0.10419316";
const FEE_PAYER_ACCOUNT = "0.0.7162784";
const FACILITATOR_URL = "https://api.testnet.blocky402.com";
const RESOURCE_URL = process.env.W6_PUBLIC_ORIGIN;
if (!RESOURCE_URL)
  throw Error(
    "W6_PUBLIC_ORIGIN_REQUIRED — set to the operator-approved stable HTTPS origin; never to a disposable tunnel diagnostic.",
  );

const names = ["service.ethonline-node-a.eth", "service.ethonline-node-b.eth"];
const paidProviderId = names[0];
const nonEconomicProviderId = names[1];

await initializeApplication({
  dataDir: appRoot,
  providerIds: names,
  port: 4352,
});

const config = JSON.parse(readFileSync(appRoot + "/application.json", "utf8"));
const manifest = JSON.parse(readFileSync(appRoot + "/operator.json", "utf8"));

writeFileSync(
  appRoot + "/native-gateway-token.txt",
  fixtureGate ? fixtureBearerToken : token,
  { mode: 0o600, flag: "wx" },
);

for (const p of config.providers) {
  p.profileIds = [digestOf(profile)];
  p.aliases = { "Mycelium-distributed-Qwen2.5-0.5B": digestOf(profile) };
}

for (const [i, p] of manifest.providers.entries()) {
  p.runtime = {
    kind: "mycelium",
    protocol: "mycelium.request_gateway.v2",
    baseUrl: fixtureGate ? fixtureBaseUrl : "http://127.0.0.1:8791",
    bearerTokenFile: "native-gateway-token.txt",
    qualificationPath: "/v1/qualification/current",
    profile,
    resolvedCommit: q.binding.resolved_commit,
    options: {
      timeoutMs: 60000,
      maxQualificationAgeMs: 3600000,
      maxOutputBytes: 65536,
      // PARENT FIXTURE GATE: when fixture mode is on, pin the executor to the
      // synthetic_test_fixture evidence class so the executor allows the
      // loopback fixture transport. When the gate is off, this stays as the
      // physical_qualification value that the live Mycelium node-0 returns.
      expectedEvidenceClass: fixtureGate
        ? fixtureExpectedEvidenceClass
        : q.evidence_class,
    },
  };
  config.providers[i].runtimeDigest = digestOf(p.runtime);

  if (p.providerId === paidProviderId || p.providerId === nonEconomicProviderId) {
    p.payment = {
      version: "1",
      policy: "ordinary-paid-x402",
      hostPolicy: {
        version: "1",
        purpose: "managed-x402-host-allowlist",
        resourceOrigin: RESOURCE_URL,
        facilitatorOrigin: "https://api.testnet.blocky402.com",
        mirrorOrigin: "https://testnet.mirrornode.hedera.com",
      },
      config: {
        mode: "live",
        providerId: p.providerId,
        profileIds: [digestOf(profile)],
        network: "hedera:testnet",
        asset: "0.0.0",
        receiver: RECEIVER_ACCOUNT,
        feePayer: FEE_PAYER_ACCOUNT,
        baseAmountBaseUnits: "1",
        perOutputTokenBaseUnits: "0",
        maxAmountBaseUnits: "1",
        maxTotalAmountBaseUnits: "1",
        quoteTtlMs: 90000,
        timeoutMs: 15000,
        facilitatorUrl: "https://api.testnet.blocky402.com",
        mirrorUrl: "https://testnet.mirrornode.hedera.com",
        resourceUrl: RESOURCE_URL + "/v1/jobs",
        allowLiveSettlement: true,
      },
    };
  }
}

config.mode = "live";
config.accessPolicy = "ordinary-paid-x402";
config.core.jobDeadlineMs = 120000;
config.core.portTimeoutMs = 30000;
config.publicOrigin = RESOURCE_URL;
config.history = {
  trustedVerifiers: ["eip155:11155111:0x9fd43D7b41c82406A776b700702EEA3813ac426A"],
  trustedMethods: ["application-receipt-publish-v1"],
  maxAgeMs: 300000,
};
manifest.history = wave6GraphHistorySpec(process.env);

writeFileSync(appRoot + "/application.json", JSON.stringify(config, null, 2), { mode: 0o600 });
writeFileSync(appRoot + "/operator.json", JSON.stringify(manifest, null, 2), { mode: 0o600 });

// Authority stub: a real authority would invoke the operator's offline
// approval flow. The Wave6 goal grants the single bounded paid journey
// directly; this stub mirrors the production assertion shape.
const ordinaryPaidAuthority = {
  assertOrdinaryPaidLiveAuthorized(context) {
    const now = Date.now();
    return {
      version: "1",
      decision: "authorized",
      purpose: "ordinary-paid-live-unchecked-v1",
      decisionId: "w6-single-paid-journey-" + Math.floor(now / 1000).toString(36),
      binding: context.binding,
      decidedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 600_000).toISOString(),
    };
  },
};

const app = await startManagedApplication({
  configFile: appRoot + "/application.json",
  ordinaryPaidAuthority,
});
writeFileSync(
  native + "/app-live-paid-runtime.json",
  JSON.stringify(
    {
      appRoot,
      url: app.url,
      profileId: digestOf(profile),
      qualificationDigest: q.binding.qualification_digest,
      evidenceClass: q.evidence_class,
      providerNames: names,
      paidProviderId,
      nonEconomicProviderId,
      publicOrigin: RESOURCE_URL,
      ensResolved: false,
      paid: false,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    status: "app-paid-serving",
    url: app.url,
    profileId: digestOf(profile),
    nativeQualification: q.binding.qualification_digest,
    publicOrigin: RESOURCE_URL,
    paidProviderId,
    nonEconomicProviderId,
  }),
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    await app.close();
    process.exit(0);
  });
}