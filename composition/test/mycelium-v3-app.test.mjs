import test from "node:test";
import assert from "node:assert/strict";
import { startGatewayFixture } from "./fixtures/v3-gateway.mjs";
import { conformanceOptions } from "./fixtures/v3-bindings.mjs";
import { createMyceliumRuntimeBinding } from "../mycelium-binding.mjs";
import { startWorkbench } from "../workbench.mjs";

test(
  "v3 application factory binds real producer rather than legacy proposal",
  { timeout: 30000 },
  async () => {
    const fixture = await startGatewayFixture();
    try {
      const options = conformanceOptions(fixture.descriptor);
      const binding = await createMyceliumRuntimeBinding(options);
      assert.equal(binding.protocol, "mycelium.request_gateway.v3");
      assert.equal(binding.kind, "mycelium-v3-conformance");
      assert.equal(binding.mode, "development");
      assert.equal(
        binding.profile.tokenizerDigest,
        options.runtimeProfile.codec.tokenizer_digest,
      );
      const config = {
        version: "1",
        mode: "simulation",
        dataDir: "/unused",
        port: 0,
        providers: [{ providerId: "alpha.example.eth", amountBaseUnits: "1" }],
      };
      await assert.rejects(
        startWorkbench({ config, runtime: binding }),
        /LIVE_BINDINGS_FORBIDDEN_IN_SIMULATION/,
      );
      await assert.rejects(
        startWorkbench({
          config: { ...config, mode: "mycelium-v3-conformance" },
          runtime: { ...binding, kind: "mycelium-conformance" },
        }),
        /V3_CONFORMANCE_RUNTIME_REQUIRED/,
      );
      await assert.rejects(
        startWorkbench({
          config: { ...config, mode: "mycelium-v3-conformance", delayMs: 1 },
          runtime: binding,
        }),
        /V3_GATEWAY_OWNS_RUNTIME_INPUTS/,
      );
      assert.deepEqual(
        (await fixture.command("stats")).peers.map((p) => p.submissions),
        [0, 0],
      );
    } finally {
      await fixture.close();
    }
  },
);
test("v3 startup requires explicit matching runtime; never simulator fallback", async () => {
  await assert.rejects(
    startWorkbench({
      config: {
        version: "1",
        mode: "mycelium-v3-conformance",
        dataDir: "/unused",
        port: 0,
        providers: [{ providerId: "alpha.example.eth", amountBaseUnits: "1" }],
      },
    }),
    /V3_CONFORMANCE_RUNTIME_REQUIRED/,
  );
});
