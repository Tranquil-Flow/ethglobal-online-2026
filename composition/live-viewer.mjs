import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";

/** A loopback-only viewer boundary with a fixed core destination. No wallet or
 * development authorization endpoint is provided; the SDK uses a trusted wallet.
 */
export async function startLiveViewer({ coreUrl, port = 0, config }) {
  const files = new Map();
  for (const [path, file, type] of [
    ["/", "../packages/access/dist/index.html", "text/html"],
    ["/style.css", "../packages/access/dist/style.css", "text/css"],
    ["/viewer.js", "../packages/access/dist/app.js", "text/javascript"],
    [
      "/app.js",
      config.applicationVersion === "2"
        ? "./application-browser.mjs"
        : "./live-browser.mjs",
      "text/javascript",
    ],
  ])
    files.set(path, {
      data: await readFile(new URL(file, import.meta.url)),
      type,
    });
  const configBytes = () =>
    JSON.stringify({ ...config, apiUrl: config.apiUrl ?? url });
  const core = new URL(coreUrl);
  if (
    core.protocol !== "http:" ||
    core.hostname !== "127.0.0.1" ||
    core.origin !== coreUrl
  )
    throw Error("INVALID_VIEWER_UPSTREAM");
  let url;
  const json = (res, code, status) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ code }));
  };
  const server = createServer((req, res) => {
    if (
      req.headers.host !== new URL(url).host ||
      (req.headers.origin && ![url, config.apiUrl].includes(req.headers.origin))
    )
      return json(res, "ORIGIN_DENIED", 403);
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    if (
      req.url.startsWith("/v1/") ||
      req.url.startsWith("/v2/") ||
      req.url === "/healthz"
    ) {
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i].toLowerCase();
        if (k === "host") headers.push(req.rawHeaders[i], core.host);
        else if (k === "origin") headers.push(req.rawHeaders[i], coreUrl);
        else headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
      }
      const proxy = httpRequest(
        coreUrl + req.url,
        { method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      proxy.on("error", () => {
        if (!res.headersSent) json(res, "UPSTREAM_UNAVAILABLE", 503);
        else res.destroy();
      });
      req.on("aborted", () => proxy.destroy());
      res.on("close", () => proxy.destroy());
      req.pipe(proxy);
      return;
    }
    if (req.url === "/config.json" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(configBytes());
      return;
    }
    const file = files.get(req.url);
    if (!file) return json(res, "NOT_FOUND", 404);
    if (req.method !== "GET") return json(res, "METHOD_NOT_ALLOWED", 405);
    res.setHeader("content-type", file.type);
    res.end(file.data);
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.maxConnections = 128;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
