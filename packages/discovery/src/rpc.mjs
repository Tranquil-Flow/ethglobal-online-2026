import { createPublicClient, custom } from "viem";
import { safeRpc } from "./url-policy.mjs";
export function rpcClient(rpcUrl, { mode, signal, timeoutMs = 5000 } = {}) {
  return createPublicClient({
    transport: custom(
      {
        request: ({ method, params }) =>
          safeRpc(
            rpcUrl,
            { method, params: params ?? [] },
            { mode, allowLoopback: mode === "development", signal, timeoutMs },
          ),
      },
      { retryCount: 0 },
    ),
    ccipRead: false,
  });
}
