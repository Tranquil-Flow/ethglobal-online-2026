# W6 W2 — Graph receipt-history report

## Status: locally implemented — contract green, logic green, live wiring pending W6

## What landed

- `packages/indexing/src/history.mjs` (additive, ~70 lines):
  - Exports `HISTORY_UNKNOWN`, `RECEIPT_HISTORY_FRESH`, `RECEIPT_HISTORY_STALE`,
    `RECEIPT_HISTORY_INDEXED_NOT_ASSESSED`, `RECEIPT_HISTORY_REORGED`,
    `RECEIPT_HISTORY_CONFLICTING`.
  - New pure `receiptHistoryReasons(report, { reorged, attributionConflicts })`
    implementing the design's classification and dominance ordering
    (unavailable > reorg > conflict > fresh/stale + indexed-not-assessed).
  - `historyReasons()`, History DTO validation, and all existing behavior
    unchanged.
- `composition/test/w6-graph-history.test.mjs`: 6 contract tests + 10 behavior
  tests covering every acceptance case in
  `docs/handoffs/w6-graph-design.md` §"Acceptance and failure cases".

## Real test counts

- `node --test composition/test/w6-graph-history.test.mjs` → **16/16 pass**
- `npm --prefix packages/indexing test` → **46/46 pass** (no regression)
- `npm --prefix packages/indexing run check` → **12/12 pass**
- `node --test composition/test/application-history.test.mjs composition/test/application-history-rpc.test.mjs composition/test/application-public-history.test.mjs` → **4/4 pass**

## What this proves

Receipt-claim history is now classifiable: fresh/stale/stale attribution,
reorg fail-closed, cross-provider conflict detection, and the honest
INDEXED_NOT_ASSESSED disclaimer are all implemented and tested as pure logic.

## What this does NOT prove — pending owner/W6 execution

- The selection call-site does not yet call `receiptHistoryReasons()`; the
  comparative ranking (fresh > stale > unknown, newest block, larger sample)
  needs the live two-provider composition to wire in.
- No live Subgraph Studio query has been issued in this workstream.
- No real consented receipts have been published to either provider — the
  "two providers show different attributed history" browser claim requires
  W6 fleet + publication.
- The browser Graph-history comparison card is not yet rendered; W5's
  `renderDemoNarrative` surfaces a single narrative, not the comparative view.
