import { createFixtureServer, fixtureProfile } from "../src/fixture.mjs";
import { createClient, createRequest } from "../src/index.mjs";
import { decideProvider } from "../src/decision.mjs";
for (const staleHistory of [false, true]) {
  const fixture = createFixtureServer({ staleHistory });
  const { url } = await fixture.listen();
  try {
    const c = createClient({ baseUrl: url });
    await c.connect();
    const request = await createRequest({
      providerId: "safe.eth",
      profileId: fixtureProfile.profileId,
      prompt: "explicit synthetic example",
      maxOutputTokens: 8,
      seed: 0,
    });
    const quote = await c.createQuote(request);
    const base = {
      names: ["safe.eth"],
      quotes: [quote],
      profileId: quote.profileId,
      maxAmountBaseUnits: "10",
      asset: quote.asset,
      network: quote.network,
    };
    const result = await decideProvider(c, base);
    console.log(
      JSON.stringify({
        mode: "development",
        source: "synthetic Graph-derived History DTO, not actual Graph",
        staleHistory,
        selected: result.selected?.providerId || null,
        decision: result.decision,
        withoutQuote: (await decideProvider(c, { ...base, quotes: [] }))
          .selected,
      }),
    );
    await c.revoke();
  } finally {
    await fixture.close();
  }
}
