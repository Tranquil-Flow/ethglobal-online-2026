import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as operator from "../application-operator.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";

test("fresh private operator setup, offline doctor, independent identities and restart without source edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-app-"));
  let app;
  try {
    const root = join(dir, "state");
    await operator.initializeApplication({
      dataDir: root,
      providerIds: ["independent-a", "independent-b"],
    });
    const configFile = join(root, "application.json");
    const before = await readFile(configFile, "utf8");
    const report = await operator.doctorApplication({ configFile });
    assert.equal(report.status, "ok");
    assert.equal(report.networkContacted, false);
    assert.equal(report.modelLoaded, false);
    assert.equal(report.providerCount, 2);
    assert.equal(await readFile(configFile, "utf8"), before);
    const cli = spawnSync(
      process.execPath,
      [
        "composition/application-operator-cli.mjs",
        "doctor",
        "--config",
        configFile,
      ],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).status, "ok");
    app = await operator.startManagedApplication({ configFile });
    const c = createClient({
      baseUrl: app.url,
      pins: app.pins["independent-b"],
    });
    await c.connect();
    const all = await (await fetch(app.url + "/v2/offers")).json();
    assert.equal(all.offers.length, 2);
    const offers = await c.listOffers();
    assert.equal(offers.offers.length, 1);
    assert.notDeepEqual(app.pins["independent-a"], app.pins["independent-b"]);
    const p = offers.offers[0].payload,
      r = await createRequest({
        providerId: p.providerId,
        profileId: p.profileIds[0],
        prompt: "🌙 safe synthetic",
        maxOutputTokens: 2,
        seed: 0,
      });
    const q = await c.createQuote(r),
      j = await c.submitJob({
        request: r,
        quoteId: q.quoteId,
        idempotencyKey: "managed-one",
        authorization: {
          maxAmountBaseUnits: "0",
          network: q.network,
          asset: q.asset,
        },
      });
    for await (const e of c.streamJob(j.job.jobId)) {
    }
    assert.equal((await c.getJob(j.job.jobId)).output.text, "🌙 ");
    const pins = app.pins;
    await app.close();
    app = await operator.startManagedApplication({ configFile });
    assert.deepEqual(app.pins, pins);
    await app.close();
    app = undefined;
    await chmod(configFile, 0o644);
    await assert.rejects(
      operator.doctorApplication({ configFile }),
      /PRIVATE_CONFIG_REQUIRED/,
    );
    await chmod(configFile, 0o600);
    const config = JSON.parse(before);
    config.core.concurrency = 999;
    await writeFile(configFile, JSON.stringify(config));
    await assert.rejects(
      operator.doctorApplication({ configFile }),
      /INVALID_CORE_LIMIT/,
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
