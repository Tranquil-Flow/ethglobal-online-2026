import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevelopment } from "../index.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { developmentProfile } from "../../packages/core/src/index.mjs";
test("normal composition supports explicit provider catalog and quote routing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-"));
  let app;
  try {
    app = await startDevelopment({
      development: true,
      dataDir: dir,
      port: 0,
      providerCatalog: [
        { providerId: "alpha.example.eth", amountBaseUnits: "2" },
        { providerId: "beta.example.eth", amountBaseUnits: "3" },
      ],
    });
    const c = createClient({ baseUrl: app.url });
    await c.connect();
    const listed = await c.listProviders([
      "alpha.example.eth",
      "beta.example.eth",
    ]);
    assert.equal(listed.providers.length, 2);
    const quotes = [];
    for (const p of listed.providers) {
      const r = await createRequest({
        providerId: p.providerId,
        profileId: app.profileId,
        prompt: "catalog test",
        maxOutputTokens: 4,
        seed: 0,
      });
      quotes.push(await c.createQuote(r));
    }
    assert.deepEqual(
      quotes.map((x) => x.amountBaseUnits),
      ["2", "3"],
    );
    const selection = await c.selectProviders({
      providers: listed.providers,
      quotes,
      profileId: app.profileId,
      maxAmountBaseUnits: "3",
      network: quotes[0].network,
      asset: quotes[0].asset,
    });
    assert.equal(selection.selected.providerId, "alpha.example.eth");
    assert.equal(
      app.providerPins["beta.example.eth"].providerId,
      "beta.example.eth",
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("runtime descriptor rejects relabelled live execution before startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bad-runtime-"));
  try {
    await assert.rejects(
      startDevelopment({
        development: true,
        dataDir: dir,
        port: 0,
        runtimeDefinition: {
          mode: "live",
          profile: developmentProfile,
          create() {
            throw Error("should not construct");
          },
        },
      }),
      /SIMULATOR_RUNTIME_REQUIRED/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
