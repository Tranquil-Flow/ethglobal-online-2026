import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHttpsProxy } from "../src/proxy.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const request = (url, ca, { method = "GET", path = "/api/echo", headers = {}, body } = {}) =>
  new Promise((resolveRequest, reject) => {
    const req = httpsRequest(new URL(path, url), { method, ca, headers, servername: "localhost" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

async function listen(server) {
  await new Promise((ok, no) => server.listen(0, "127.0.0.1", ok).once("error", no));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "operations-proxy-"));
  const keyPath = join(dir, "key.pem"), certPath = join(dir, "cert.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", keyPath, "-out", certPath], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const ca = await readFile(certPath);
  const seen = [], state = { aborted: 0 };
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, forwarded: req.headers["x-forwarded-for"], authorization: req.headers.authorization });
    if (req.url === "/healthz") return void res.end("ok");
    if (req.url === "/api/hang") { req.once("close", () => state.aborted++); return; }
    if (req.url === "/api/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      res.write("data: one\n\n"); setTimeout(() => res.end("data: two\n\n"), 20); return;
    }
    let body = ""; req.on("data", (c) => body += c); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ url: req.url, body })); });
  });
  const upstreamUrl = await listen(upstream);
  const childCode = `import {readFile} from 'node:fs/promises'; import {createHttpsProxy} from ${JSON.stringify(new URL("../src/proxy.mjs", import.meta.url).href)}; const p=createHttpsProxy({upstream:${JSON.stringify(upstreamUrl)},cert:await readFile(${JSON.stringify(certPath)}),key:await readFile(${JSON.stringify(keyPath)}),allowedOrigins:['https://app.example'],allowedHosts:['localhost'],allowedPaths:['/api/'],maxBodyBytes:32,requestTimeoutMs:1000,upstreamTimeoutMs:500}); const x=await p.listen({host:'127.0.0.1',port:0}); console.log(JSON.stringify(x)); for (const s of ['SIGTERM','SIGINT']) process.on(s,async()=>{await p.close();process.exit(0)});`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childCode], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (c) => stderr += c);
  let startTimer;
  const line = await Promise.race([
    new Promise((ok, no) => { let b=""; child.stdout.on("data", c => { b += c; if (b.includes("\n")) ok(b.split("\n")[0]); }); child.once("exit", c => no(Error(`proxy exited ${c}: ${stderr}`))); }),
    new Promise((_, no) => { startTimer = setTimeout(() => no(Error("proxy start timeout")), 3000); }),
  ]).finally(() => clearTimeout(startTimer));
  const url = JSON.parse(line).url.replace("127.0.0.1", "localhost");
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(r => child.once("exit", r)), sleep(1500).then(() => child.kill("SIGKILL"))]); } await new Promise(r => upstream.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { url, ca, seen, state, child, stderr: () => stderr, upstream, upstreamUrl };
}

test("configuration rejects non-loopback or request-selectable upstreams", () => {
  const base = { cert: "x", key: "x", allowedOrigins: ["https://app.example"], allowedHosts: ["localhost"] };
  for (const upstream of ["http://example.com", "http://127.0.0.1/core", "http://user:pass@127.0.0.1", "file:///tmp/socket"])
    assert.throws(() => createHttpsProxy({ ...base, upstream }), /loopback origin/);
  assert.throws(() => createHttpsProxy({ ...base, upstream: "http://127.0.0.1", cert: undefined }), /explicit cert/);
});

test("actual HTTPS child process enforces the deployment boundary", async (t) => {
  const f = await fixture(t);
  const good = { host: "localhost", origin: "https://app.example", authorization: "Bearer private-token", "x-forwarded-for": "203.0.113.9" };
  const ok = await request(f.url, f.ca, { path: "/api/echo?next=http://169.254.169.254/", headers: good });
  assert.equal(ok.status, 200); assert.match(ok.headers["strict-transport-security"], /max-age/);
  assert.equal(f.seen[0].host, new URL(f.upstreamUrl).host);
  assert.equal(f.seen[0].forwarded, undefined); assert.equal(f.seen[0].authorization, "Bearer private-token");
  assert.match(ok.body, /169\.254\.169\.254/); assert.doesNotMatch(f.stderr(), /private-token/);

  assert.equal((await request(f.url, f.ca, { headers: { ...good, origin: "https://evil.example" } })).status, 403);
  assert.equal((await request(f.url, f.ca, { headers: ["Host", "localhost", "Origin", "https://app.example", "Origin", "https://evil.example"] })).status, 400);
  assert.equal((await request(f.url, f.ca, { headers: { ...good, host: "evil.example" } })).status, 403);
  assert.equal((await request(f.url, f.ca, { path: "/admin", headers: good })).status, 404);
  assert.equal((await request(f.url, f.ca, { path: "/api/echo", headers: ["Host","localhost","Idempotency-Key","a","Idempotency-Key","b"] })).status,400);
  assert.equal((await request(f.url, f.ca, { method: "POST", headers: { ...good, "content-length": "33" }, body: "x".repeat(33) })).status, 413);

  const sse = await request(f.url, f.ca, { path: "/api/sse", headers: good });
  assert.equal(sse.status, 200); assert.equal(sse.body, "data: one\n\ndata: two\n\n");
  const reconnect = await request(f.url, f.ca, { path: "/api/sse", headers: { ...good, "last-event-id": "1" } });
  assert.equal(reconnect.status, 200); assert.match(reconnect.body, /data: two/);
  await new Promise((done) => {
    const req = httpsRequest(new URL("/api/hang", f.url), { ca: f.ca, servername: "localhost", headers: good });
    req.on("error", () => done()); req.end(); setTimeout(() => req.destroy(), 30);
  });
  await sleep(30); assert.equal(f.state.aborted, 1);
  assert.equal((await request(f.url, f.ca, { path: "/readyz", headers: { host: "localhost" } })).status, 200);
  await new Promise(r => f.upstream.close(r));
  assert.equal((await request(f.url, f.ca, { path: "/readyz", headers: { host: "localhost" } })).status, 503);
});
