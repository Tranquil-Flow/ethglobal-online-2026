import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  initializeApplication,
  startManagedApplication,
} from "../application-operator.mjs";
import { startPaidCoreBridge } from "../hedera-live-connection.mjs";
import { createSingleTinybarWallet } from "../hedera-wallet-adapter.mjs";
import { createBoundedConsumer } from "../../packages/payments/src/client.mjs";
import { facilitatorFixture } from "../../packages/payments/test/fixture.mjs";
import {
  createRequest,
  verifyReceiptIntegrity,
} from "../../packages/access/src/index.mjs";
import { digestOf } from "../../packages/contracts/index.mjs";
const { PrivateKey } = createRequire(
  new URL("../../packages/payments/package.json", import.meta.url),
)("@x402/hedera");

test(
  "native wallet -> bridge -> managed core -> actual SDK settlement fixture -> retained signed receipt",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "step6-composed-"));
    let app, bridge, fixture;
    try {
      fixture = await facilitatorFixture();
      const probe = createServer();
      await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      const root = join(dir, "app");
      await initializeApplication({
        dataDir: root,
        providerIds: ["paid.local"],
        port,
      });
      const configFile = join(root, "application.json"),
        operatorFile = join(root, "operator.json");
      const config = JSON.parse(await readFile(configFile)),
        operator = JSON.parse(await readFile(operatorFile));
      config.accessPolicy = "ordinary-paid-x402";
      const profileId = digestOf(operator.providers[0].runtime.profile);
      const paymentConfig = {
        ...fixture.config,
        providerId: "paid.local",
        profileIds: [profileId],
        receiver: "0.0.10419316",
        baseAmountBaseUnits: "1",
        perOutputTokenBaseUnits: "0",
        maxAmountBaseUnits: "1",
        maxTotalAmountBaseUnits: "1",
        resourceUrl: `http://127.0.0.1:${port}/v1/jobs`,
      };
      operator.providers[0].payment = {
        version: "1",
        policy: "ordinary-paid-x402",
        config: paymentConfig,
        hostPolicy: {
          version: "1",
          purpose: "managed-x402-host-allowlist",
          resourceOrigin: new URL(paymentConfig.resourceUrl).origin,
          facilitatorOrigin: fixture.url,
          mirrorOrigin: fixture.url,
        },
      };
      await writeFile(configFile, JSON.stringify(config));
      await writeFile(operatorFile, JSON.stringify(operator));
      app = await startManagedApplication({ configFile });
      const session = await (
        await fetch(app.url + "/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      const request = await createRequest({
        providerId: "paid.local",
        profileId,
        prompt: "SYNTHETIC_LIVE_SMOKE: local composition only",
        maxOutputTokens: 1,
        seed: 0,
        publishConsent: false,
      });
      bridge = await startPaidCoreBridge({
        appUrl: app.url,
        capability: session.capability,
        request,
        stateDirectory: dir,
        inference: false,
      });
      const quote = await (
        await fetch(bridge.url + "/quote", {
          method: "POST",
          headers: {
            authorization: "Bearer " + session.capability,
            "content-type": "application/json",
          },
          body: JSON.stringify({ request }),
        })
      ).json();
      const key = PrivateKey.generateECDSA();
      fixture.register({ key });
      let signs = 0;
      const walletAuthorize = createSingleTinybarWallet({
        journalFile: join(dir, "wallet.json"),
        request,
        mode: "development",
        feePayer: paymentConfig.feePayer,
        resourceUrl: paymentConfig.resourceUrl,
        signTransaction: (tx) => {
          signs++;
          return tx.sign(key);
        },
      });
      const consumer = createBoundedConsumer({
        url: bridge.url + "/operation",
        expected: paymentConfig,
        maxAmountBaseUnits: "1",
        maxTotalAmountBaseUnits: "1",
        walletAuthorize,
        timeoutMs: 10000,
      });
      fixture.state.fault = "mirror-outage";
      let result = await consumer.consume({
        request,
        quote,
        capability: session.capability,
        idempotencyKey: "one-attempt",
      });
      assert.equal(result.status, 503);
      assert.equal(signs, 1);
      assert.equal(fixture.state.settle, 1);
      fixture.state.fault = null;
      const recoveredResponse = await fetch(bridge.url + "/operation", {
        method: "POST",
        headers: {
          authorization: "Bearer " + session.capability,
          "content-type": "application/json",
          "idempotency-key": "one-attempt",
        },
        body: JSON.stringify({ request, quoteId: quote.quoteId }),
      });
      result = {
        status: recoveredResponse.status,
        body: await recoveredResponse.json(),
      };
      assert.equal(result.status, 200);
      assert.equal(result.body.execution, "succeeded");
      assert.equal(result.body.payment.status, "settled");
      assert.equal(result.body.inference, false);
      assert.equal(result.body.inferenceVerified, false);
      assert.equal(signs, 1);
      assert.equal(fixture.state.settle, 1);
      const pins = app.pins["paid.local"];
      assert.equal(
        (await verifyReceiptIntegrity(result.body.receipt, pins.publicKeyJwk))
          .integrity,
        true,
      );
      const stored = JSON.parse(await readFile(join(dir, "outcome.json")));
      assert.deepEqual(stored.receipt, result.body.receipt);
      const replay = await fetch(bridge.url + "/operation", {
        method: "POST",
        headers: {
          authorization: "Bearer " + session.capability,
          "content-type": "application/json",
          "idempotency-key": "one-attempt",
        },
        body: JSON.stringify({ request, quoteId: quote.quoteId }),
      });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).jobId, result.body.jobId);
      assert.equal(signs, 1);
      assert.equal(fixture.state.settle, 1);
    } finally {
      await bridge?.close();
      await app?.close();
      await fixture?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Step 6 runner is preflight-only unless the live approval is explicitly present",
  { timeout: 240000 },
  async () => {
    const execute = process.env.WAVE5_HEDERA_LIVE_APPROVED === "1";
    const script = fileURLToPath(
      new URL(
        "../../packages/payments/scripts/live-smoke.mjs",
        import.meta.url,
      ),
    );
    const args = [script, "--network", "hedera:testnet", "--budget", "1"];
    if (execute) {
      assert.equal(process.env.EDITOR_LIVE_BUDGET_TINYBARS, "1");
      assert.equal(process.env.WAVE5_HEDERA_PUBLIC_APPROVED, "1");
      args.push(
        "--execute",
        "--approved",
        "--adapter",
        fileURLToPath(new URL("../hedera-wallet-adapter.mjs", import.meta.url)),
      );
    }
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, out, err }));
    });
    assert.equal(result.code, 0, result.err);
    const value = JSON.parse(result.out);
    assert.equal(value.inferenceVerified ?? false, false);
    if (execute) {
      assert.equal(value.payment, "settled");
      assert.equal(value.inference, true);
      assert.ok(value.transactionRef);
    } else {
      assert.equal(value.walletLoaded, false);
      assert.equal(value.broadcast, false);
      assert.equal(value.liveQualified, false);
    }
  },
);
