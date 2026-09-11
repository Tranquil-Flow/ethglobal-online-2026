import { createRequire } from "node:module";
import {
  createHistory,
  createGraphClient,
  validateDeployment,
} from "../packages/indexing/src/index.mjs";
import { validateRpc } from "./application-publication-config.mjs";
const { FetchRequest, JsonRpcProvider } = createRequire(
  new URL("../packages/indexing/package.json", import.meta.url),
)("ethers");
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
      ]
        .sort()
        .join()
  )
    fail("INVALID_MANAGED_HISTORY");
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
  };
  let provider,
    history,
    closed = false;
  function port() {
    if (closed) fail("HISTORY_CLOSED");
    if (!history) {
      if (rpcUrl) {
        const request = new FetchRequest(rpcUrl);
        request.timeout = 15000;
        provider = new JsonRpcProvider(request, undefined, {
          cacheTimeout: -1,
        });
      }
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
