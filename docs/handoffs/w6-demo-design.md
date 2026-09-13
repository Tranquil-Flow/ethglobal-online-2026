# W6 W5 demo narrative design

## Outcome and boundaries

Build one judge-facing screen that can be read top-to-bottom in under four minutes while preserving the existing request lifecycle and its truthful distinctions. The screen is a presentation of existing application data, not a new execution, discovery, payment, indexing, or verification protocol. It remains vanilla HTML, CSS, and JavaScript; no dependency or framework is added.

The primary path is an ordered nine-beat narrative. Existing recovery, publication, evidence export/import, deletion, and offline-check controls move inside a native `<details>` region labelled **Advanced evidence & export details**. Their IDs and handlers remain unchanged so existing automation can still locate them. The details region remains keyboard operable through the native summary control.

## Single-screen layout

A compact header gives the product statement and permanent runtime qualification note. Directly beneath it, four independent claim badges remain visible throughout the journey. A numbered narrative rail then presents these beats in DOM and reading order:

1. **ENS name** — selected provider name (`#provider-ens-name`).
2. **Resolved record** — endpoint and record-set chain/block provenance from the Provider DTO (`#resolved-record`), plus a live Etherscan link to the pinned ENSv2 Sepolia Universal Resolver.
3. **Node topology / placement** — provider → selected runtime profile, with any server-supplied topology text; otherwise it explicitly says placement was not supplied (`#node-topology`). It must not infer physical hosts from an ENS record or digest.
4. **Bounded quote** — amount, asset, network, and expiry (`#quote`).
5. **Hedera transaction** — server-supplied transaction reference linked to HashScan testnet when its shape is valid (`#payment-tx`). No transaction is invented when absent.
6. **Streamed output** — append-only text rendered through `textContent` / text nodes (`#answer`).
7. **Signed receipt** — receipt-integrity state only (`#receipt-state`); it never implies execution correctness.
8. **Graph observation** — freshness/observation statement and a live Studio query URL when supplied by the resolved Provider DTO (`#history`, `#history-url`).
9. **Selection decision** — selected provider and returned reason codes when selection is available, or an honest pending/unavailable explanation (`#selection-decision`).

The request controls remain adjacent to the narrative on wide screens so a judge can drive the sequence without leaving the page. At narrow width, request controls precede the narrative so keyboard and touch users can produce the states before reading them.

## Four-claim badge system

The badge rail contains four separate status elements; it must never be replaced by one aggregate status:

- `#execution-claim`: **Execution — completed** only after the job reports `succeeded`; otherwise pending/failed/cancelled truthfully.
- `#output-claim`: **Output — unchecked** when output is present. This is intentionally independent of receipt integrity and assessment.
- `#receipt-claim`: **Receipt integrity — valid** only after local signature verification against the configured pin; otherwise not checked/unavailable/invalid.
- `#assessment-claim`: **Assessment — unavailable** when the assessment endpoint returns that outcome, or not requested/pending/other returned outcome as applicable.

The existing detailed states (job, output, payment, financial protection, receipt, assessment, publication) remain available inside the advanced details region. The primary badges summarize exactly one claim each.

## Advanced controls placement

`<details id="advanced-details">` follows the nine-beat narrative. Its labelled summary is the single disclosure control. The following existing controls remain inside it with unchanged IDs:

- encrypted attempt recovery passphrase/file, download, import, and revoke controls;
- retained-job resume and publication refresh;
- assessment request and receipt-integrity verification;
- private evidence, buyer context, and attempt context exports;
- offline buyer/evidence file check;
- server evidence deletion;
- detailed payment, protection, publication, and integrity explanations.

The disclosure is open in the static HTML so legacy tests and no-script inspection retain access; application viewer enhancement collapses it after initialization for the judge-facing application. Automated tests open it explicitly before advanced actions.

## Keyboard order

DOM order defines the keyboard order; no positive `tabindex` is used:

1. Connect, revoke.
2. Configured provider/profile selects (when application configuration exposes them).
3. Provider name, profile digest, find provider.
4. Prompt, maximum tokens, quote, budget, publication consent, payment consent, submit, cancel.
5. Sponsor links encountered in narrative order: Etherscan resolver, HashScan transaction (when present), Studio query, then Sepolia publication links in advanced details.
6. Advanced details summary.
7. Recovery, retained-job, verification, assessment, export/import, offline-check, and deletion controls in their existing workflow order.

Tests retain a DOM trace of focusable element IDs/hrefs and exercise Tab from the document into the first control and through the disclosure. All focusable elements use the existing high-contrast `:focus-visible` outline.

## Narrow viewport

- Breakpoint: `700px`.
- Wide layout: two columns, request controls and narrative; narrative cards use a compact vertical rail.
- At `<=700px`: one column, no fixed widths, card padding reduces, controls occupy available width, and long identifiers wrap.
- At `320px`: no horizontal overflow; tap targets remain at least 44px high; the claim rail and topology tokens wrap rather than clip.
- Screenshots and DOM transcripts are retained at 1280×800 and 375×800; an additional automated width assertion covers 320px.

## Live-link policy

All external links are explicit-click only, open in a new tab, and carry `rel="noopener noreferrer"` plus `referrerpolicy="no-referrer"`.

- **HashScan:** `https://hashscan.org/testnet/transaction/<encoded server transactionRef>` only for a validated Hedera transaction ID.
- **Sepolia Etherscan ENS resolver:** `https://sepolia.etherscan.io/address/0x4a1817d13e9cf196f471725176355c1234b63c70`, the pinned ENSv2 Sepolia Universal Resolver artifact already vendored by discovery.
- **Studio query URL:** the validated HTTPS `historyEndpoint` returned in the resolved Provider DTO (the current live deployment is `https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.2.0-unchecked-20260911`).

Unsafe, credential-bearing, non-HTTPS, or absent server URLs render as unavailable text, never as anchors. Merely rendering links must not trigger external requests.

## Acceptance and retention

Browser acceptance covers: nine ordered beats, four distinct badges, safe live-link targets, advanced details disclosure, completed asynchronous terminal state, signed-receipt integrity state, assessment unavailable state, 320px no-overflow, and keyboard focus order. The retained test run writes:

- `artifacts/w6-demo/desktop-1280x800.png`
- `artifacts/w6-demo/narrow-375x800.png`
- `artifacts/w6-demo/desktop-dom.txt`
- `artifacts/w6-demo/narrow-dom.txt`
- `artifacts/w6-demo/keyboard-tab-order.json`

Artifacts contain only synthetic local test data. The handoff report records exact commands, counts, paths, and any failure disposition.

## W6 reduction

W5 is reduced to an additive HTML renderer in `composition/live-viewer.mjs`; the existing live rendering pipeline and viewer package remain unchanged.
`renderDemoNarrative` carries the nine judge-facing beats, four independent state badges, network-derived sponsor links, and collapsed-by-default advanced evidence/export markup.
Focused snapshot-style contract tests cover the generated HTML only.
Real-browser desktop/narrow capture and integration into the live page are deferred to the W6 owner.
