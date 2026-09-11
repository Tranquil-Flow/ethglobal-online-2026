import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { request } from "node:https";
import { spawnSync } from "node:child_process";
import {
  startApplicationHttps,
  inspectApplicationHttps,
} from "../application-https.mjs";

test(
  "managed TLS enforces an explicit bounded upstream idle timeout",
  { timeout: 10000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "application-idle-"));
    let ingress, resolveUpstreamClosed;
    const upstreamClosed = new Promise((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    const upstream = createServer((req, res) => {
      if (req.url === "/control") res.end("live transport control");
      else
        res.once("close", () => {
          closedUpstream += 1;
          resolveUpstreamClosed();
        });
    });
    let closedUpstream = 0;
    t.after(async () => {
      await ingress?.close();
      upstream.closeAllConnections();
      await new Promise((done) => upstream.close(done));
      await rm(dir, { recursive: true, force: true });
    });
    await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
    const certFile = join(dir, "cert.pem"),
      keyFile = join(dir, "key.pem"),
      configFile = join(dir, "tls.json");
    const generated = spawnSync(
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
        keyFile,
        "-out",
        certFile,
      ],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    await chmod(certFile, 0o600);
    await chmod(keyFile, 0o600);
    const ca = await readFile(certFile);
    // Reserve a listener port independently; the production start owns its actual bind.
    const probe = createServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const port = probe.address().port;
    await new Promise((done) => probe.close(done));
    const config = {
      upstream: `http://127.0.0.1:${upstream.address().port}`,
      publicOrigin: `https://localhost:${port}`,
      certFile,
      keyFile,
      port,
    };
    const save = async (extra = {}) =>
      writeFile(configFile, JSON.stringify({ ...config, ...extra }), {
        mode: 0o600,
      });
    await save();
    assert.equal(
      inspectApplicationHttps({ configFile }).upstreamTimeoutMs,
      30000,
    );
    await save({ upstreamTimeoutMs: 120000 });
    assert.equal(
      inspectApplicationHttps({ configFile }).upstreamTimeoutMs,
      120000,
    );
    for (const bad of [0, -1, 300001, 1.5, "1000", null]) {
      await save({ upstreamTimeoutMs: bad });
      assert.throws(
        () => inspectApplicationHttps({ configFile }),
        /INVALID_TLS_TIMEOUT/,
      );
    }
    await save({ upstreamTimeoutMs: 200, unexpected: true });
    assert.throws(
      () => inspectApplicationHttps({ configFile }),
      /INVALID_TLS_CONFIG/,
    );
    await save({ upstreamTimeoutMs: 200 });
    ingress = await startApplicationHttps({ configFile });
    const get = (path) =>
      new Promise((done, fail) => {
        const req = request(
          config.publicOrigin + path,
          { ca, family: 4, servername: "localhost", timeout: 3000 },
          (res) => {
            const body = [];
            res.on("data", (bytes) => body.push(bytes));
            res.on("end", () =>
              done({
                status: res.statusCode,
                body: Buffer.concat(body).toString(),
              }),
            );
          },
        );
        req.on("error", fail);
        req.on("timeout", () => req.destroy(Error("test transport deadline")));
        req.end();
      });
    const control = await get("/control");
    assert.equal(control.status, 200);
    assert.equal(control.body, "live transport control");
    const timed = await get("/withheld-output");
    // The existing proxy deliberately maps timeout/transport errors to 503.
    assert.equal(timed.status, 503);
    assert.deepEqual(JSON.parse(timed.body), { error: "upstream unavailable" });
    // Wait for the upstream server's own close observation, not just a local HTTP error.
    await ingress.close();
    ingress = undefined;
    await upstreamClosed;
    assert.equal(closedUpstream, 1);
  },
);
