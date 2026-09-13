// OT4 focused acceptance: end-to-end with the LIVE running viewer at 127.0.0.1:4350.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { ISOLATED_FREE_ORIGIN, installIsolatedFreeViewer } from "../browser.mjs";

const LOOPBACK_VIEWER = "http://127.0.0.1:4350";

async function isLoopbackAlive() {
  try {
    const response = await fetch(`${LOOPBACK_VIEWER}/`, { method: "GET" });
    return response.ok;
  } catch { return false; }
}

function makeJsdom(origin, html, baseUrl) {
  const dom = new JSDOM(html, {
    url: `${origin}/`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  // jsdom's window.fetch does NOT resolve relative URLs against the JSDOM location,
  // so we substitute a fetch that hits the real loopback server when the path is "/config.json".
  dom.window.fetch = async (input, init) => {
    const url = typeof input === "string" && input.startsWith("/")
      ? `${baseUrl}${input}`
      : input;
    return await fetch(url, init);
  };
  return dom;
}

test("end-to-end: live loopback viewer (127.0.0.1:4350) serves apiUrl=loopback origin", async (t) => {
  if (!(await isLoopbackAlive())) return t.skip("loopback viewer not running on 127.0.0.1:4350");
  const html = await (await fetch(`${LOOPBACK_VIEWER}/`)).text();
  const dom = makeJsdom(ISOLATED_FREE_ORIGIN, html, LOOPBACK_VIEWER);
  installIsolatedFreeViewer(dom.window);
  const config = await dom.window.fetch("/config.json").then(r => r.json());
  assert.equal(config.apiUrl, ISOLATED_FREE_ORIGIN, "served apiUrl must equal viewer origin");
  assert.equal(config.isolatedFree, true, "served config must carry isolatedFree:true");
  assert.equal(dom.window.__MYCELIUM_VIEWER_CONFIG__.apiUrl, ISOLATED_FREE_ORIGIN);
  const badge = dom.window.document.querySelector("[data-isolated-free-path]");
  assert.ok(badge, "operator badge must be present");
  assert.equal(badge.textContent, "Isolated Free Path — loopback only");
});

test("end-to-end: same client-side seam on a stubbed non-loopback origin does NOT rewrite apiUrl", async () => {
  // Use a stub HTML (no live server required): the client seam only inspects
  // window.location.origin and the parsed /config.json body.
  const upstreamConfig = {
    apiUrl: "https://mycelium.now",
    isolatedFree: true,
    applicationVersion: "2",
  };
  const dom = new JSDOM("<!doctype html><header></header>", {
    url: "https://mycelium.now/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.fetch = async () => new Response(JSON.stringify(upstreamConfig), {
    status: 200, headers: { "content-type": "application/json" },
  });
  installIsolatedFreeViewer(dom.window);
  const config = await dom.window.fetch("/config.json").then(r => r.json());
  assert.equal(config.apiUrl, "https://mycelium.now", "non-loopback must keep public apiUrl");
  assert.equal(dom.window.__MYCELIUM_VIEWER_CONFIG__, undefined);
  assert.equal(dom.window.document.querySelector("[data-isolated-free-path]"), null);
});
