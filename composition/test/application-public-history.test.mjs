import test from "node:test";
import assert from "node:assert/strict";
import { createManagedHistory } from "../application-history.mjs";
const address = "0x" + "1".repeat(40);
const spec = {
  endpoint: "http://127.0.0.1:45678/graphql",
  deploymentId: "fixture",
  deployment: {
    mode: "development",
    chainId: 31337,
    network: "localhost",
    address,
    publisher: address,
    startBlock: 1,
    confirmations: 1,
    codeHash: "0x" + "a".repeat(64),
  },
};
test("public History endpoint is explicitly opted in; transport URL is not automatically advertised", async () => {
  const hidden = createManagedHistory({ spec, mode: "development" });
  assert.equal(hidden.publicEndpoint, undefined);
  await hidden.close();
  const visible = createManagedHistory({
    spec: { ...spec, publicEndpoint: "https://graph.example/query/public" },
    mode: "development",
  });
  assert.equal(visible.publicEndpoint, "https://graph.example/query/public");
  await visible.close();
});
test("unsafe public History endpoints are refused offline", () => {
  for (const publicEndpoint of [
    "javascript:alert(1)",
    "https://user:credential@graph.example/query",
    "https://graph.example/query?token=x",
    "http://127.0.0.1:1",
  ])
    assert.throws(
      () =>
        createManagedHistory({
          spec: { ...spec, publicEndpoint },
          mode: "development",
        }),
      /INVALID_PUBLIC_HISTORY_ENDPOINT/,
    );
});
