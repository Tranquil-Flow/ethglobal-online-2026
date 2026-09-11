import test from "node:test";
import assert from "node:assert/strict";
import { inputFixture } from "./mycelium-operator.test.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { createMyceliumProfile } from "../mycelium-profile.mjs";
import { validateOperatorInputs } from "../mycelium-operator.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
const raw = {
  algorithm: "raw-logit-greedy",
  tieBreak: "lowest-token-id",
  nonfinite: "reject",
};
test("v2 raw-logit metadata is representable without coercing or changing v1 profile bytes", () => {
  const input = inputFixture(),
    old = createMyceliumProfile(input.metadata);
  assert.equal(
    old.profileId,
    "sha256:0e34ab827c13e65cbabbeed4381c69afbf87ceb5c41ad9605ddc8b6d2bb70202",
  );
  input.metadata.version = "2";
  input.metadata.selector = structuredClone(raw);
  const p = createMyceliumProfile(input.metadata);
  assert.equal(p.metadata.selector.nonfinite, "reject");
  assert.notEqual(p.profileId, old.profileId);
  assert.ok(
    p.profile.artifacts.some(
      (x) => x.role.endsWith("-v2") && x.digest === digestOf(p.metadata),
    ),
  );
  assert.equal(validateOperatorInputs(input).profileId, p.profileId);
  for (const mutate of [
    (x) => (x.metadata.version = "1"),
    (x) => (x.metadata.selector.logitQuantum = "0.00001"),
    (x) => (x.metadata.selector.nonfinite = "allow"),
    (x) => (x.metadata.selector.tieBreak = "random"),
  ]) {
    const bad = structuredClone(input);
    mutate(bad);
    assert.throws(() => createMyceliumProfile(bad.metadata));
  }
});
test("raw metadata cannot relabel the legacy quantized protocol", async () => {
  const input = inputFixture();
  input.metadata.version = "2";
  input.metadata.selector = structuredClone(raw);
  await assert.rejects(
    createMyceliumRuntimeBinding({
      mode: "live",
      profileMetadata: input.metadata,
      providers: input.providers,
    }),
    /UNSUPPORTED_METADATA_PROTOCOL/,
  );
  await assert.rejects(
    createMyceliumRuntimeBinding({
      mode: "development",
      profilePolicy: createMyceliumProfile(input.metadata),
      providers: input.providers,
    }),
    /UNSUPPORTED_METADATA_PROTOCOL/,
  );
});
