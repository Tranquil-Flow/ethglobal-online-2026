import test from "node:test";
import assert from "node:assert/strict";
import { validateNodeUpdate, updateNodeRecords } from "../ens-update-node.mjs";
const plan = {
  chainId: 11155111,
  owner: "0xb4f0b42fbB0fCAf62703475039A7E26EF6dD5EaE",
  nodes: ["a", "b"].map((n) => ({
    providerId: `service.ethonline-node-${n}.eth`,
    profileId: "sha256:" + n.repeat(64),
  })),
};
test("node update shape is closed and restricted to the two approved names", () => {
  assert.deepEqual(validateNodeUpdate(plan), plan);
  assert.throws(
    () => validateNodeUpdate({ ...plan, chainId: 1 }),
    /SEPOLIA_OWNER_REQUIRED/,
  );
  assert.throws(
    () =>
      validateNodeUpdate({ ...plan, nodes: [plan.nodes[0], plan.nodes[0]] }),
    /EXACT_WAVE5_NAMES_REQUIRED/,
  );
  assert.throws(
    () => validateNodeUpdate({ ...plan, extra: true }),
    /UNEXPECTED_UPDATE_FIELD/,
  );
  assert.throws(
    () =>
      validateNodeUpdate({
        ...plan,
        nodes: [{ ...plan.nodes[0], extra: true }, plan.nodes[1]],
      }),
    /UNEXPECTED_UPDATE_FIELD/,
  );
});
test("execute without approval refuses before network or wallet access", async (t) => {
  const network = t.mock.method(globalThis, "fetch", () => {
    throw Error("NETWORK_MUST_NOT_RUN");
  });
  await assert.rejects(
    updateNodeRecords({
      plan,
      execute: true,
      approved: false,
      walletFile: "/not-read",
      journalDirectory: "/not-created",
    }),
    /EXPLICIT_OWNER_APPROVAL_REQUIRED/,
  );
  assert.equal(network.mock.callCount(), 0);
});
