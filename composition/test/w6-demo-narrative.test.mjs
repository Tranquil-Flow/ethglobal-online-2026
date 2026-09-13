import test from "node:test";
import assert from "node:assert/strict";

import {
  advancedControlsCollapsed,
  renderDemoNarrative,
} from "../live-viewer.mjs";

const input = {
  ensName: "worker.demo.eth",
  resolvedEndpoint: "https://worker.example/v1",
  placement: "provider → node-0 + node-2",
  quote: "0.25 HBAR · testnet · expires in 90s",
  hederaTxId: "0.0.7162784@1789193044.396402824",
  streamedText: "A streamed answer.",
  receiptDigest: "sha256:abc123",
  graphObservation: { source: "Graph Studio", freshness: "12 seconds old" },
  selectionDecision: "Selected the freshest eligible two-node route.",
  network: {
    ethereum: "sepolia",
    hedera: "testnet",
    ensResolverAddress: "0x4a1817d13e9cf196f471725176355c1234b63c70",
    studioQueryUrl:
      "https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0",
  },
};

test("exports renderDemoNarrative and the collapsed default", () => {
  assert.equal(typeof renderDemoNarrative, "function");
  assert.equal(advancedControlsCollapsed, true);
});

test("snapshot contains all nine narrative labels", () => {
  const html = renderDemoNarrative(input);
  for (const label of [
    "ENS name → resolved record",
    "Node topology / placement",
    "Quote",
    "Hedera tx",
    "Streamed output",
    "Signed receipt",
    "Graph observation",
    "Selection decision",
    "Honest state badges",
  ]) {
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("renders the four honest states as four distinct badge nodes", () => {
  const html = renderDemoNarrative(input);
  const badges = [
    ...html.matchAll(
      /<span class="demo-state-badge" data-state="([^"]+)">([^<]+)<\/span>/g,
    ),
  ];
  assert.equal(badges.length, 4);
  assert.deepEqual(
    badges.map((badge) => badge[1]),
    [
      "execution-completed",
      "output-unchecked",
      "receipt-integrity-valid",
      "assessment-unavailable",
    ],
  );
});

test("wraps advanced controls in details only when collapsed", () => {
  const collapsed = renderDemoNarrative(input);
  assert.match(collapsed, /<details class="demo-narrative__advanced"/);
  assert.match(collapsed, /<summary>Advanced evidence &amp; export controls<\/summary>/);

  const inline = renderDemoNarrative({
    ...input,
    advancedControlsCollapsed: false,
  });
  assert.doesNotMatch(inline, /<details class="demo-narrative__advanced"/);
  assert.match(inline, /<section class="demo-narrative__advanced"/);
});

test("constructs ENS, Hedera, and Graph live-link anchors from network", () => {
  const html = renderDemoNarrative(input);
  assert.match(
    html,
    /href="https:\/\/sepolia\.etherscan\.io\/address\/0x4a1817d13e9cf196f471725176355c1234b63c70"/,
  );
  assert.match(
    html,
    /href="https:\/\/hashscan\.org\/testnet\/transaction\/0\.0\.7162784%401789193044\.396402824"/,
  );
  assert.match(
    html,
    /href="https:\/\/api\.studio\.thegraph\.com\/query\/1758934\/ethonline-sepolia-receipts\/v0\.2\.0"/,
  );
});
