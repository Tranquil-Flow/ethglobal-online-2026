import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { createHttpsProxy } from "../../operations/src/proxy.mjs";
import { startDevelopment } from "../index.mjs";
import { createSimulatorBinding } from "../runtime-binding.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
test(
  "certificate-pinned HTTPS -> private composition -> real simulator/payment/receipt/replay",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "workbench-tls-"));
    let app, proxy;
    try {
      const reserved = createServer();
      await new Promise((r) => reserved.listen(0, "127.0.0.1", r));
      const port = reserved.address().port;
      await new Promise((r) => reserved.close(r));
      const origin = "https://localhost:" + port;
      const key = join(dir, "tls.key"),
        cert = join(dir, "tls.pem");
      assert.equal(
        spawnSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost",
            "-keyout",
            key,
            "-out",
            cert,
          ],
          { stdio: "ignore" },
        ).status,
        0,
      );
      const ca = await readFile(cert);
      app = await startDevelopment({
        development: true,
        dataDir: join(dir, "state"),
        port: 0,
        resourceOrigin: origin,
        runtimeDefinition: createSimulatorBinding({
          providers: [{ providerId: "synthetic.local.eth" }],
        }),
      });
      proxy = createHttpsProxy({
        upstream: app.url,
        cert: ca,
        key: await readFile(key),
        allowedOrigins: [origin],
        allowedHosts: ["localhost"],
        allowedPaths: [
          "/v1/",
          "/healthz",
          "/config.json",
          "/",
          "/viewer.js",
          "/styles.css",
          "/browser.mjs",
          "/development/authorize",
        ],
      });
      await proxy.listen({ port });
      const fetchTls = (url, options = {}) =>
        new Promise((ok, no) => {
          const req = httpsRequest(
            url,
            {
              ca,
              method: options.method ?? "GET",
              headers: {
                ...Object.fromEntries(new Headers(options.headers)),
                origin,
              },
              signal: options.signal,
            },
            (res) => {
              const parts = [];
              res.on("data", (b) => parts.push(b));
              res.on("error", no);
              res.on("end", () =>
                ok(
                  new Response(
                    res.statusCode === 204 ? null : Buffer.concat(parts),
                    { status: res.statusCode, headers: res.headers },
                  ),
                ),
              );
            },
          );
          req.on("error", no);
          req.end(options.body);
        });
      const config = await (await fetchTls(origin + "/config.json")).json();
      assert.equal(config.apiUrl, origin);
      const c = createClient({
        baseUrl: origin,
        fetch: fetchTls,
        pins: app.pins,
        paymentAuthorizer: (context) => {
          assert.equal(
            context.body.resource.url,
            origin + "/v1/jobs/quotes/" + context.quote.quoteId,
          );
          return app.authorizeDevelopment(context);
        },
      });
      await c.connect();
      const request = await createRequest({
        providerId: app.providerId,
        profileId: app.profileId,
        prompt: "actual private TLS staged workload",
        maxOutputTokens: 64,
        seed: 4,
      });
      const quote = await c.createQuote(request);
      assert.equal(quote.mode, "development");
      const approval = {
        maxAmountBaseUnits: "1",
        asset: quote.asset,
        network: quote.network,
      };
      const { job } = await c.submitJob({
        request,
        quoteId: quote.quoteId,
        idempotencyKey: "tls-job",
        authorization: approval,
      });
      for await (const e of c.streamJob(job.jobId)) {
      }
      assert.equal(
        (await c.getEvidence(job.jobId)).receipt.payload.jobId,
        job.jobId,
      );
      assert.equal(
        (
          await c.createAssessment(
            job.jobId,
            app.replayMethod,
            "tls-assessment",
          )
        ).outcome,
        "passed",
      );
      assert.equal((await c.getPublication(job.jobId)).consent, false);
      assert.equal((await fetchTls(origin + "/readyz")).status, 200);
      await app.close();
      app = undefined;
      assert.equal((await fetchTls(origin + "/readyz")).status, 503);
    } finally {
      await proxy?.close();
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("development TLS is explicit, loopback-only, and cannot enable a live route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tls-guard-"));
  const { createPayments } = await import(
    "../../packages/payments/src/index.mjs"
  );
  const config = {
    mode: "development",
    network: "hedera:testnet",
    asset: "0.0.0",
    receiver: "0.0.1002",
    feePayer: "0.0.1003",
    providerId: "test.example.eth",
    profileIds: ["sha256:" + "a".repeat(64)],
    baseAmountBaseUnits: "1",
    perOutputTokenBaseUnits: "0",
    maxAmountBaseUnits: "10",
    maxTotalAmountBaseUnits: "10",
    facilitatorUrl: "http://127.0.0.1:1",
    mirrorUrl: "http://127.0.0.1:2",
    resourceUrl: "https://localhost:3/v1/jobs",
    databasePath: join(dir, "payment.sqlite"),
  };
  try {
    assert.throws(() => createPayments({ config }), /INVALID_CONFIG/);
    assert.throws(
      () =>
        createPayments({
          config: {
            ...config,
            allowDevelopmentTls: true,
            resourceUrl: "https://public.example/v1/jobs",
          },
        }),
      /INVALID_CONFIG/,
    );
    assert.throws(() =>
      createPayments({
        config: { ...config, allowDevelopmentTls: true, mode: "live" },
      }),
    );
    const valid = createPayments({
      config: { ...config, allowDevelopmentTls: true },
    });
    await valid.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
