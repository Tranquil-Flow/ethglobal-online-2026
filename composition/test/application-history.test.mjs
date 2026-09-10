import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWorkbench } from "../workbench.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
import { setup } from "./fixtures/application.mjs";

test("application selection rejects explicitly trusted open-history mismatch without treating history as proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-v2-history-"));
  let app;
  try {
    const f = setup(dir);
    const trustedVerifier = "open-checker";
    const trustedMethod = "open-method";
    f.config.history = {
      trustedVerifiers: [trustedVerifier],
      trustedMethods: [trustedMethod],
      maxAgeMs: 60000,
    };
    const alpha = f.providers[0];
    const observation = {
      version: "1",
      assessmentId: "open-mismatch",
      receiptDigest: digestOf("open-receipt"),
      method: trustedMethod,
      profileId: alpha.profileIds[0],
      verifierId: trustedVerifier,
      outcome: "mismatch",
      mode: "development",
      createdAt: new Date().toISOString(),
    };
    f.bindings.history = {
      async getHistory({ providerId }) {
        return {
          version: "1",
          providerId,
          observations: providerId === alpha.providerId ? [observation] : [],
          freshness: "fresh",
          chainId: "31337",
          observedAt: new Date().toISOString(),
          mode: "development",
        };
      },
    };
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
    const cfg = await (await fetch(app.url + "/config.json")).json();
    assert.equal(cfg.history, "configured-open-attributed-not-proof");
    const client = createClient({ baseUrl: app.url });
    await client.connect();
    const listed = await client.listProviders([alpha.providerId]);
    assert.equal(listed.providers.length, 1);
    assert.equal(listed.providers[0].endpoint, app.url);
    assert.equal(listed.providers[0].paymentNetwork, "non-economic");
    const request = await createRequest({
      providerId: alpha.providerId,
      profileId: alpha.profileIds[0],
      prompt: "public synthetic input",
      maxOutputTokens: 2,
      seed: 1,
    });
    const quote = await client.createQuote(request);
    const decision = await client.selectProviders({
      providers: listed.providers,
      quotes: [quote],
      profileId: alpha.profileIds[0],
      maxAmountBaseUnits: "0",
      network: "non-economic",
      asset: "none",
    });
    assert.equal(decision.selected, null);
    assert.deepEqual(decision.reasons[0], {
      providerId: alpha.providerId,
      eligible: false,
      codes: ["OBSERVED_MISMATCH"],
    });
    const publicHistory = await (
      await fetch(
        app.url +
          "/v1/providers/" +
          encodeURIComponent(alpha.providerId) +
          "/history",
      )
    ).json();
    assert.equal(publicHistory.observations[0].outcome, "mismatch");
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
