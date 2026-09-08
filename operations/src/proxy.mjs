import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const SPOOFABLE = new Set(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-real-ip", "via"]);
const SINGLE = new Set(["host", "origin", "authorization", "content-length", "transfer-encoding"]);

function fail(code, message) { const e = Error(message); e.code = code; throw e; }
function normalizedSet(values, name) {
  if (!Array.isArray(values) || !values.length || values.some((x) => typeof x !== "string" || !x)) fail("INVALID_PROXY_CONFIG", name);
  return new Set(values.map((x) => x.toLowerCase()));
}
function duplicates(rawHeaders) {
  const counts = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) { const n = rawHeaders[i].toLowerCase(); counts.set(n, (counts.get(n) || 0) + 1); }
  return [...counts.values()].some((count) => count > 1);
}
function send(res, status, body) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: body }));
}
function secure(res) {
  res.setHeader("strict-transport-security", "max-age=31536000");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("cache-control", "no-store");
}

/**
 * Construct, but do not start, a dependency-free HTTPS boundary.
 * The upstream must be an explicit loopback origin and can never be request-selected.
 */
export function createHttpsProxy({ upstream, cert, key, allowedOrigins, allowedHosts, allowedPaths = ["/v1/", "/healthz"], maxBodyBytes = 1_048_576, requestTimeoutMs = 30_000, upstreamTimeoutMs = 5_000, maxConnections = 128, maxRequestsPerSocket = 100 } = {}) {
  let target;
  try { target = new URL(upstream); } catch { fail("INVALID_PROXY_CONFIG", "upstream"); }
  if (!["http:", "https:"].includes(target.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname) || target.username || target.password || target.pathname !== "/" || target.search || target.hash) fail("INVALID_PROXY_CONFIG", "upstream must be a loopback origin");
  if (!cert || !key) fail("INVALID_PROXY_CONFIG", "explicit cert and key required");
  const origins = normalizedSet(allowedOrigins, "allowedOrigins");
  const hosts = normalizedSet(allowedHosts, "allowedHosts");
  if (!Array.isArray(allowedPaths) || !allowedPaths.length || allowedPaths.some((p) => typeof p !== "string" || !p.startsWith("/") || p.includes("?") || p.includes("#"))) fail("INVALID_PROXY_CONFIG", "allowedPaths");
  for (const [v, n] of [[maxBodyBytes,"maxBodyBytes"],[requestTimeoutMs,"requestTimeoutMs"],[upstreamTimeoutMs,"upstreamTimeoutMs"],[maxConnections,"maxConnections"],[maxRequestsPerSocket,"maxRequestsPerSocket"]]) if (!Number.isSafeInteger(v) || v < 1) fail("INVALID_PROXY_CONFIG", n);

  const sockets = new Set(), active = new Set(); let server, closing = false;
  const handler = (req, res) => {
    secure(res);
    if (closing) return send(res, 503, "unavailable");
    if (duplicates(req.rawHeaders)) return send(res, 400, "duplicate security header");
    const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    if (!hosts.has(host)) return send(res, 403, "host denied");
    const origin = req.headers.origin;
    if (origin && !origins.has(String(origin).toLowerCase())) return send(res, 403, "origin denied");
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return send(res, 400, "invalid target");
    let parsed; try { parsed = new URL(req.url, target); } catch { return send(res, 400, "invalid target"); }
    if(parsed.origin!==target.origin || req.url.includes("\\"))return send(res,400,"invalid target");
    const pathAllowed = allowedPaths.some((p) => p.endsWith("/") ? parsed.pathname.startsWith(p) : parsed.pathname === p);
    const readiness = parsed.pathname === "/readyz";
    if (readiness && req.method !== "GET") return send(res, 405, "method not allowed");
    if (!pathAllowed && !readiness) return send(res, 404, "not found");
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || BigInt(length) > BigInt(maxBodyBytes))) return send(res, 413, "payload too large");

    const headers = {};
    const connectionTokens = new Set(String(req.headers.connection || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean));
    for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name) && !SPOOFABLE.has(name) && !connectionTokens.has(name) && name !== "host" && value !== undefined) headers[name] = value;
    headers.host = target.host;
    if(origin)headers.origin=target.origin;
    if (readiness) { delete headers.authorization; parsed = new URL("/healthz", target); }
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamReq = transport(parsed, { method: readiness ? "GET" : req.method, headers, timeout: upstreamTimeoutMs }, (upstreamRes) => {
      if (readiness) { upstreamRes.resume(); upstreamRes.on("end", () => send(res, upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300 ? 200 : 503, upstreamRes.statusCode < 300 ? "ready" : "upstream unavailable")); return; }
      for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP.has(name) && name !== "set-cookie" && value !== undefined) res.setHeader(name, value);
      secure(res); res.writeHead(upstreamRes.statusCode || 502);
      pipeline(upstreamRes, res, () => {});
    });
    active.add(upstreamReq); upstreamReq.once("close", () => active.delete(upstreamReq));
    upstreamReq.on("timeout", () => upstreamReq.destroy(Error("UPSTREAM_TIMEOUT")));
    upstreamReq.on("error", () => { if (!res.headersSent) send(res, 503, "upstream unavailable"); else res.destroy(); });
    let bytes = 0, rejected = false;
    req.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBodyBytes && !rejected) { rejected = true; send(res, 413, "payload too large"); upstreamReq.destroy(); req.destroy(); } });
    req.once("aborted", () => upstreamReq.destroy()); res.once("close", () => { if (!res.writableEnded) upstreamReq.destroy(); });
    if (readiness) upstreamReq.end(); else pipeline(req, upstreamReq, () => {});
  };

  return {
    async listen({ host = "127.0.0.1", port = 0 } = {}) {
      if (server) fail("PROXY_ALREADY_STARTED", "already started");
      if (!["127.0.0.1", "::1", "localhost"].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535) fail("INVALID_LISTEN_CONFIG", "loopback host and valid port required");
      server = createServer({ cert, key, requestTimeout: requestTimeoutMs, headersTimeout: Math.min(requestTimeoutMs, 10_000), keepAliveTimeout: 5_000, maxHeaderSize: 16_384 }, handler);
      server.maxConnections = maxConnections;
      server.maxRequestsPerSocket = maxRequestsPerSocket;
      server.on("connection", (s) => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
      await new Promise((ok, no) => server.listen(port, host, ok).once("error", no));
      const a = server.address(); return { url: `https://${host.includes(":") ? `[${host}]` : host}:${a.port}` };
    },
    async close({ graceMs = 1_000 } = {}) {
      if (!server) return; closing = true;
      server.closeIdleConnections?.();
      const done = new Promise((ok) => server.close(ok));
      const timer = setTimeout(() => { for (const r of active) r.destroy(); for (const s of sockets) s.destroy(); }, graceMs); timer.unref();
      await done; clearTimeout(timer); server = undefined;
    },
  };
}
