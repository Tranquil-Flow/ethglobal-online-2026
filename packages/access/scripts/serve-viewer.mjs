import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { safeBaseUrl } from "../src/index.mjs";
export function createViewerServer({ apiUrl, fixture = false }) {
  const api = safeBaseUrl(apiUrl);
  let url;
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${api}; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(url).host) {
        res.writeHead(403);
        return res.end();
      }
      res.setHeader("Content-Security-Policy", csp);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      if (req.method !== "GET") {
        res.writeHead(405);
        return res.end();
      }
      if (req.url === "/config.json") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ apiUrl: api, fixture }));
      }
      const file = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
      }[req.url];
      if (!file) {
        res.writeHead(404);
        return res.end();
      }
      res.setHeader(
        "content-type",
        file.endsWith("html")
          ? "text/html; charset=utf-8"
          : file.endsWith("css")
            ? "text/css"
            : "text/javascript",
      );
      res.end(await readFile(new URL("../dist/" + file, import.meta.url)));
    } catch {
      res.writeHead(503);
      res.end();
    }
  });
  return {
    async listen({ host = "127.0.0.1", port = 0 } = {}) {
      if (host !== "127.0.0.1") throw Error("LOOPBACK_ONLY");
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      url = `http://${host}:${server.address().port}`;
      return { url };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let fixture, apiUrl;
  const development = process.argv.includes("--development-fixture");
  if (development) {
    const { createFixtureServer } = await import("../src/fixture.mjs");
    fixture = createFixtureServer();
    apiUrl = (await fixture.listen()).url;
  } else {
    const i = process.argv.indexOf("--api-url");
    if (i < 0)
      throw Error("Explicit --api-url or --development-fixture required");
    apiUrl = process.argv[i + 1];
  }
  const viewer = createViewerServer({ apiUrl, fixture: development });
  const { url } = await viewer.listen({ port: 4350 });
  fixture?.allowOrigin(url);
  console.log(
    "Access viewer " +
      url +
      "; " +
      (development ? "DEVELOPMENT fixture only" : "external API unqualified"),
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, async () => {
      await viewer.close();
      await fixture?.close();
    });
}
