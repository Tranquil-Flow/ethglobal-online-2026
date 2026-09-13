import { strict as assert } from "node:assert";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  ISOLATED_FREE_ORIGIN,
  installIsolatedFreeViewer,
} from "../browser.mjs";

const upstreamConfig = Object.freeze({
  apiUrl: "https://mycelium.now",
  isolatedFree: true,
  applicationVersion: "2",
  fixture: false,
});

function response(config) {
  return new Response(JSON.stringify(config), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function fixture(origin) {
  const dom = new JSDOM("<!doctype html><header></header>", { url: `${origin}/` });
  const requests = [];
  dom.window.fetch = async (input) => {
    requests.push(String(input));
    return response(upstreamConfig);
  };
  await installIsolatedFreeViewer(dom.window);
  const config = await dom.window.fetch("/config.json").then((value) => value.json());
  return { dom, config, requests };
}

test("loopback 4350 plus isolatedFree uses the viewer origin and shows the warning badge", async () => {
  const { dom, config, requests } = await fixture(ISOLATED_FREE_ORIGIN);
  assert.equal(config.apiUrl, ISOLATED_FREE_ORIGIN);
  assert.deepEqual(requests, ["/config.json"]);
  assert.equal(dom.window.__MYCELIUM_VIEWER_CONFIG__.apiUrl, ISOLATED_FREE_ORIGIN);
  assert.equal(
    dom.window.document.querySelector("[data-isolated-free-path]")?.textContent,
    "Isolated Free Path — loopback only",
  );
});

test("the same flag on any other origin leaves apiUrl and UI unchanged", async () => {
  const { dom, config } = await fixture("https://mycelium.now");
  assert.equal(config.apiUrl, "https://mycelium.now");
  assert.equal(dom.window.__MYCELIUM_VIEWER_CONFIG__, undefined);
  assert.equal(dom.window.document.querySelector("[data-isolated-free-path]"), null);
});

test("loopback without the explicit flag leaves apiUrl unchanged", async () => {
  const dom = new JSDOM("<!doctype html><header></header>", { url: `${ISOLATED_FREE_ORIGIN}/` });
  dom.window.fetch = async () => response({ ...upstreamConfig, isolatedFree: false });
  await installIsolatedFreeViewer(dom.window);
  const config = await dom.window.fetch("/config.json").then((value) => value.json());
  assert.equal(config.apiUrl, "https://mycelium.now");
  assert.equal(dom.window.document.querySelector("[data-isolated-free-path]"), null);
});
