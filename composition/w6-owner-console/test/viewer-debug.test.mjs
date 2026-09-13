import test from "node:test";
import assert from "node:assert/strict";
import { startLiveViewer, compressedCapabilityMatrix } from "../../live-viewer.mjs";

test("public viewer debug matrix is allowlisted and never serializes secrets", () => {
  const matrix = compressedCapabilityMatrix({ inferenceEnabled: true, apiKey: "do-not-leak", capabilities: { graphStats: true }, nested: { bearer: "no" } });
  assert.equal(matrix.length, 15);
  assert.equal(matrix.find((x) => x.id === "0.5b").enabled, true);
  assert.equal(JSON.stringify(matrix).includes("do-not-leak"), false);
  assert(matrix.every((row) => typeof row.reason === "string" && row.reason));
});

test("public viewer ?debug=1 is self-contained without owner console", async (t) => {
  const viewer = await startLiveViewer({ coreUrl: "http://127.0.0.1:65534", port: 0, config: { accessPolicy: "ordinary-paid-x402", inferenceEnabled: true } });
  t.after(() => viewer.close());
  const response = await fetch(`${viewer.url}/?debug=1`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /debug-drawer\.js/);
  const script = await fetch(`${viewer.url}/debug-drawer.js`).then((r) => r.text());
  assert.match(script, /searchParams\.get\("debug"\)!=="1"/);
  const body = await fetch(`${viewer.url}/debug-capabilities.json`).then((r) => r.json());
  assert.equal(body.capabilities.find((x) => x.id === "0.5b").enabled, true);
});
