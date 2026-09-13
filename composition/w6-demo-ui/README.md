# RETIRED (2026-09-13)

This app is retired. The unified frontend at `mycelium.now` (`packages/access/viewer`) is the single judge-facing surface; the
Requests ledger, verifier verdicts and audits that lived here have been rebuilt on live data behind `/v2/requests`.

# w6-demo-ui — Mycelium product demo frontend

A feature-complete, standalone demo UI for users and judges that exposes every working
Mycelium surface in one place:

- **Home / Start** with capability status badges
- **Try Inference** — real prompt → real 0.5B distributed route via the isolated-free
  app at `http://127.0.0.1:4350` (server-side proxy; no CORS exposure)
- **Receipts / Payments** — canonical paid G01 `08020e41-…` decoded, HashScan, Hedera mirror, Ed25519 receipt
- **Provider Trust / The Graph** — live Graph `_meta` + entity probes
- **Verifier / TEE** — live SEV compute probe at `34.7.61.130:8765/healthz` and `/info`;
  honest YELLOW when T6 tee-launcher endpoints are absent
- **ENS / Provenance** — current known DNS/ENS state with honest "broadcast pending" label
- **How it works** — judge-friendly explanation with architecture diagram in pure SVG
- **Judge verification guide** — copy-paste curl commands from SUBMISSION-REPORT.md

Run from `composition/w6-demo-ui/`:

```
node server.mjs
# → http://127.0.0.1:4362/
```

Designed for the w6 ETHOnline 2026 submission window. The UI is honest about partial gates
and never fabricates data — every status badge and table cell is filled from a real
artifact or a live probe.

## Architecture

- **Plain Node 20+ HTTP server** — no Express, no npm install required
- **Static assets** at `/styles.css`, `/app.js`, `/index.html`
- **Server APIs** under `/api/*` proxy local artifacts + live surfaces
- **No secrets**, no wallet keys, no payments, no ENS broadcast
- **XSS-safe** — all dynamic text rendered with `textContent` on the client

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Home / start page |
| GET | `/how-it-works` | Architecture explainer |
| GET | `/api/status` | Aggregate status for the home page |
| POST | `/api/inference/free` | Submit a free (non-economic) prompt via 127.0.0.1:4350 |
| GET | `/api/receipt/canonical` | Canonical paid G01 receipt + HashScan + mirror links |
| GET | `/api/graph` | Live Graph `_meta`, provider/audit probes |
| GET | `/api/tee` | SEV verifier probes (8765 + optional 8766) |
| GET | `/api/ens` | ENS / DNS state (honest "broadcast pending") |
| GET | `/api/evidence` | Evidence report + SHAs from `l6/evidence-sha256.txt` |
| GET | `/api/judge/curls` | Judge verification curl block |

## Files

- `server.mjs` — HTTP server + API proxy logic
- `public/index.html` — Home UI (multi-view SPA)
- `public/styles.css` — Stylesheet
- `public/app.js` — Client JS (XSS-safe rendering)
- `public/diagram.svg` — Inline architecture diagram (currently embedded in HTML)

## Constraints honored

- No edits to `composition/w6-trust-cards/` or `composition/w6-public-edge.mjs`
- No payment, signing, ENS broadcast, or secret access
- No git commit/push/PR; no launchd restart; no Docker rebuild
- Independent server on port 4362 — does not disturb current launchd services

## Public-edge integration proposal

See `artifacts/w6-v2/product-demo-ui/public-edge-integration-proposal.md` for the
cleanest way to expose this UI at `https://mycelium.now/demo` once the owner decides
to mount it (NOT applied here — `deleg_99c9f9af` owns `w6-public-edge.mjs`).
