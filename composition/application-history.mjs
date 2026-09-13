import {
  createHistory,
  createHistoryRpcProvider,
  createGraphClient,
  validateDeployment,
} from "../packages/indexing/src/index.mjs";
import { rpcClient } from "../packages/discovery/src/rpc.mjs";
import { validateRpc } from "./application-publication-config.mjs";
const fail = (c) => {
  const e = Error(c);
  e.code = c;
  throw e;
};
/** Closed operator-owned history input. Doctor construction performs no RPC. */
export function createManagedHistory({ spec: input, mode }) {
  const spec = structuredClone(input);
  if (
    !spec ||
    typeof spec !== "object" ||
    Array.isArray(spec) ||
    Object.keys(spec).sort().join() !==
      [
        "endpoint",
        "deployment",
        "deploymentId",
        ...(spec.rpcUrl === undefined ? [] : ["rpcUrl"]),
        ...(spec.publicEndpoint === undefined ? [] : ["publicEndpoint"]),
        ...(spec.subgraph === undefined ? [] : ["subgraph"]),
      ]
        .sort()
        .join()
  )
    fail("INVALID_MANAGED_HISTORY");
  if (spec.publicEndpoint !== undefined) {
    let u;
    try {
      u = new URL(spec.publicEndpoint);
    } catch {
      fail("INVALID_PUBLIC_HISTORY_ENDPOINT");
    }
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      spec.publicEndpoint.length > 2048
    )
      fail("INVALID_PUBLIC_HISTORY_ENDPOINT");
  }
  const deployment = validateDeployment(spec.deployment);
  if (deployment.mode !== mode) fail("HISTORY_MODE_MISMATCH");
  if (
    typeof spec.deploymentId !== "string" ||
    !spec.deploymentId ||
    spec.deploymentId.length > 256
  )
    fail("INVALID_MANAGED_HISTORY");
  const rpcUrl =
    spec.rpcUrl === undefined ? undefined : validateRpc(spec.rpcUrl, mode);
  const client = createGraphClient({
    endpoint: spec.endpoint,
    allowLocal: mode === "development",
  });
  const config = {
    mode,
    chainId: String(deployment.chainId),
    deployment,
    deploymentId: spec.deploymentId,
    ...(spec.subgraph === undefined ? {} : { subgraph: spec.subgraph }),
  };
  let provider,
    history,
    closed = false;
  function port() {
    if (closed) fail("HISTORY_CLOSED");
    if (!history) {
      if (rpcUrl)
        provider = createHistoryRpcProvider(
          rpcClient(rpcUrl, { mode, timeoutMs: 15000 }),
        );
      try {
        history = createHistory({ config, client, provider });
      } catch (e) {
        provider?.destroy();
        throw e;
      }
    }
    return history;
  }
  return {
    source: { deploymentId: spec.deploymentId, chainId: String(deployment.chainId), registryAddress: deployment.address,
      ...(spec.subgraph === undefined ? {} : { subgraph: spec.subgraph }) },
    ...(spec.publicEndpoint === undefined
      ? {}
      : { publicEndpoint: spec.publicEndpoint }),
    async getHistory(args) {
      return port().getHistory(args);
    },
    async getReport(args) {
      return port().getReport(args);
    },
    async close() {
      if (closed) return;
      closed = true;
      provider?.destroy();
    },
  };
}
