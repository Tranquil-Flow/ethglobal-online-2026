import { test } from "node:test";
import assert from "node:assert/strict";
import { safeGet, safeRpc } from "../src/url-policy.mjs";
test("transport rejects invalid bounds and write RPC methods without a socket", async () => {
  await assert.rejects(
    safeGet("http://127.0.0.1:1", {
      mode: "development",
      allowLoopback: true,
      maxBytes: 0,
    }),
    { code: "INVALID_CONFIG" },
  );
  await assert.rejects(
    safeRpc(
      "http://127.0.0.1:1",
      { method: "eth_sendTransaction", params: [] },
      { mode: "development", allowLoopback: true },
    ),
    { code: "RPC_METHOD_FORBIDDEN" },
  );
});
