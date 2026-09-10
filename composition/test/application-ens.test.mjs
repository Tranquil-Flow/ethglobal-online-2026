import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { localChain } from "../../packages/discovery/test/local-chain.mjs";
import {
  initializeApplication,
  startManagedApplication,
  doctorApplication,
} from "../application-operator.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
const { namehash } = createRequire(
  new URL("../../packages/discovery/package.json", import.meta.url),
)("viem");
test("managed v2 consumes actual ENS records, rejects changed bindings, preserves direct offers and offline doctor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "application-ens-"));
  let chain, app;
  try {
    chain = await localChain();
    const root = join(dir, "state"),
      configFile = join(root, "application.json"),
      operatorFile = join(root, "operator.json"),
      id = "worker.example.eth";
    await initializeApplication({
      dataDir: root,
      providerIds: [id, "second.example.eth"],
    });
    const op = JSON.parse(await readFile(operatorFile, "utf8"));
    op.discovery = {
      mode: "development",
      rpcUrl: chain.url,
      universal: chain.universal,
      root: chain.root,
      allowLoopback: true,
      names: [id],
      ttlMs: 100,
    };
    await writeFile(operatorFile, JSON.stringify(op), { mode: 0o600 });
    app = await startManagedApplication({ configFile });
    const c = createClient({ baseUrl: app.url, pins: app.pins[id] });
    await c.connect();
    const offer = (await c.listOffers()).offers.find(
      (o) => o.payload.providerId === id,
    ).payload;
    const records = {
      "ethonline.endpoint": app.url,
      "ethonline.profiles": JSON.stringify(offer.profileIds),
      "ethonline.payment.network": "non-economic",
      "ethonline.payment.asset": "none",
      "ethonline.payment.receiver": id,
      "ethonline.history":
        app.url + "/v1/providers/" + encodeURIComponent(id) + "/history",
    };
    for (const [key, value] of Object.entries(records))
      await chain.write(chain.resolver, "PermissionedResolverImpl", "setText", [
        namehash(id),
        key,
        value,
      ]);
    const listed = await c.listProviders([id]);
    assert.equal(listed.providers.length, 1, JSON.stringify(listed.errors));
    assert.notEqual(listed.providers[0].source.chainId, "application-direct");
    assert.ok(listed.providers[0].source.blockNumber > 0);
    const request = await createRequest({
        providerId: id,
        profileId: offer.profileIds[0],
        prompt: "public synthetic ENS input",
        maxOutputTokens: 2,
        seed: 0,
      }),
      quote = await c.createQuote(request);
    const select = () =>
      c.selectProviders({
        providers: listed.providers,
        quotes: [quote],
        profileId: request.profileId,
        maxAmountBaseUnits: "0",
        network: "non-economic",
        asset: "none",
      });
    assert.equal((await select()).selected.providerId, id);
    await chain.write(chain.resolver, "PermissionedResolverImpl", "setText", [
      namehash(id),
      "ethonline.profiles",
      JSON.stringify([digestOf("unsupported")]),
    ]);
    let changed;
    for (let i = 0; i < 40; i++) {
      changed = await c.listProviders([id]);
      if (!changed.providers.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(changed.providers.length, 0);
    assert.equal(changed.errors[0].code, "OFFER_RECORD_MISMATCH");
    await assert.rejects(select, /PROVIDER_CHANGED/);
    assert.equal(
      (await c.listOffers()).offers.find((o) => o.payload.providerId === id)
        .payload.profileIds[0],
      request.profileId,
    );
    await app.close();
    app = undefined;
    await chain.close();
    chain = undefined;
    const doctor = await doctorApplication({ configFile });
    assert.equal(doctor.status, "ok");
    assert.equal(doctor.networkContacted, false);
  } finally {
    await app?.close();
    await chain?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
