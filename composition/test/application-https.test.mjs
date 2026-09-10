import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { spawnSync } from "node:child_process";
import { startWorkbench } from "../workbench.mjs";
import { setup } from "./fixtures/application.mjs";
import { startApplicationHttps } from "../application-https.mjs";
import {
  createClient,
  createRequest,
} from "../../packages/access/src/index.mjs";
test("configured HTTPS origin binds actual proxy offers, quotes and recovery without disabling TLS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "application-tls-"));
  let app, proxy;
  try {
    const probe = createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const origin = "https://localhost:" + port,
      f = setup(dir);
    f.config.publicOrigin = origin;
    app = await startWorkbench({ config: f.config, bindings: f.bindings });
    const keyPath = join(dir, "tls-key.pem"),
      certPath = join(dir, "tls-cert.pem");
    const made = spawnSync(
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
        keyPath,
        "-out",
        certPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(made.status, 0, made.stderr);
    const ca = await readFile(certPath),
      tlsConfig = join(dir, "tls.json");
    await chmod(certPath, 0o600);
    await chmod(keyPath, 0o600);
    await writeFile(
      tlsConfig,
      JSON.stringify({
        upstream: app.url,
        publicOrigin: origin,
        certFile: certPath,
        keyFile: keyPath,
        port,
      }),
      { mode: 0o600 },
    );
    proxy = await startApplicationHttps({ configFile: tlsConfig });
    const transport = (url, options = {}) =>
      new Promise((resolve, reject) => {
        const req = httpsRequest(
          url,
          { ...options, family: 4, ca, servername: "localhost" },
          (res) => {
            const chunks = [];
            res.on("data", (b) => chunks.push(b));
            res.on("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: res.statusCode,
                  headers: res.headers,
                }),
              ),
            );
          },
        );
        req.on("error", reject);
        req.end(options.body);
      });
    const publicConfig = await (
      await transport(origin + "/config.json")
    ).json();
    assert.equal(publicConfig.apiUrl, origin);
    const client = createClient({
      baseUrl: origin,
      fetch: transport,
      pins: app.pins[f.providers[0].providerId],
    });
    await client.connect();
    const offer = (await client.listOffers()).offers[0].payload;
    assert.equal(offer.endpoint, origin);
    const request = await createRequest({
        providerId: offer.providerId,
        profileId: offer.profileIds[0],
        prompt: "synthetic TLS binding",
        maxOutputTokens: 2,
        seed: 0,
      }),
      quote = await client.createQuote(request);
    assert.equal(quote.providerId, offer.providerId);
    assert.equal(quote.amountBaseUnits, "0");
    const archive = await client.exportRecovery({
      request,
      quote,
      idempotencyKey: "tls-bound",
      passphrase: "synthetic TLS recovery passphrase",
    });
    const recovered = await client.importRecovery(
      archive,
      "synthetic TLS recovery passphrase",
    );
    assert.equal(recovered.status, "unresolved");
    const bad = await transport(origin + "/config.json", {
      headers: { origin: "https://wrong.invalid" },
    });
    assert.equal(bad.status, 403);
  } finally {
    await proxy?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
