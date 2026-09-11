import {
  loadManagedApplication,
  doctorApplication,
} from "./application-operator.mjs";
import { inspectApplicationHttps } from "./application-https.mjs";
import { digestOf } from "../packages/contracts/index.mjs";
/** Pure local preflight, not an executable deployment or resource grant. */
export async function planApplicationDeployment({ configFile, tlsConfigFile }) {
  const x = loadManagedApplication({ configFile });
  await doctorApplication({ configFile });
  const tls = inspectApplicationHttps({ configFile: tlsConfigFile });
  if (!x.config.port || !tls.port)
    throw Error("DEPLOYMENT_FIXED_PORTS_REQUIRED");
  if (x.config.port === tls.port) throw Error("TLS_APPLICATION_PORT_COLLISION");
  if (
    x.config.publicOrigin !== tls.publicOrigin ||
    new URL(tls.upstream).origin !== `http://127.0.0.1:${x.config.port}`
  )
    throw Error("TLS_APPLICATION_BINDING_MISMATCH");
  return {
    status: "deployment-plan-only",
    configurationDigest: digestOf({ ...x.config, dataDir: "." }),
    providerCount: x.entries.length,
    mode: x.config.mode,
    publicOrigin: tls.publicOrigin,
    applicationPort: x.config.port,
    tlsPort: tls.port,
    upstreamTimeoutMs: tls.upstreamTimeoutMs,
    certificateFingerprint: tls.certificateFingerprint,
    certificateValidTo: tls.validTo,
    networkContacted: false,
    modelLoaded: false,
    grantVerified: false,
    chainTrustVerified: false,
    publicDeployment: false,
    financialProtection: false,
    pending: [
      "explicit-host-and-public-action-approval",
      "actual-runtime-and-operator-qualification",
      "external-HTTPS-discovery-and-history-qualification",
      "separately-accepted-checker-and-financial-contract",
    ],
  };
}
