import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeterministicTestExecutor,
  runExecutorPortConformance,
} from "./executor-port.mjs";

test("deterministic executor conforms through the actual core port", async () => {
  const passed = await runExecutorPortConformance({
    factory: createDeterministicTestExecutor,
  });
  assert.deepEqual(passed, [
    "binding-stream-receipt",
    "output-token-bound",
    "output-byte-bound",
    "profile-mismatch",
    "failure",
    "timeout-aborts",
    "cancellation-aborts",
  ]);
});
