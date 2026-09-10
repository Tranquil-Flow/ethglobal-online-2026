import test from "node:test";
import assert from "node:assert/strict";
import { inputFixture } from "./mycelium-operator.test.mjs";
import { validateOperatorInputs } from "../mycelium-operator.mjs";
test("versioned native operator input supports primary-only access, never optional replay authority", () => {
  const input = inputFixture();
  input.schema = "mycelium.workbench.operator.v2";
  delete input.replayGateway;
  delete input.access.replayOrigin;
  input.access.maxReplayRequests = 0;
  const result = validateOperatorInputs(input);
  assert.equal(result.networkContacted, false);
  assert.equal(result.checking, "unavailable");
  for (const mutation of [
    (x) => (x.access.maxReplayRequests = 1),
    (x) => (x.access.replayOrigin = "https://unrequested.invalid"),
    (x) => (x.access.expiresAt = "2000-01-01T00:00:00Z"),
  ]) {
    const bad = structuredClone(input);
    mutation(bad);
    assert.throws(() => validateOperatorInputs(bad));
  }
});
