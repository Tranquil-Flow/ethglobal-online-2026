# Wave 6 v3 — L-POPULATE evidence (blocked: live origin unavailable)

**Worker:** L-POPULATE (parent-dispatched leaf)
**Dispatched:** 2026-09-13
**Outcome:** **BLOCKED** — live origin `https://mycelium.now` is returning HTTP 502 from the Cloudflare edge on every probe. No inference requests were issued. Per task contract, this worker did not retry-blast.

## 1. Probe results

All three probe targets (`/healthz`, `/config.json`, `/`) return `HTTP/2 502` with a `cloudflare` server banner and a 16-byte body of literal text `error code: 502`. The response is from the Cloudflare edge, not the origin — the gateway has no upstream to forward to.

```
attempt 1   /healthz       HTTP 502   time=0.368s   body="error code: 502"
attempt 2   /healthz       HTTP 502   time=0.404s   body="error code: 502"
attempt 3   /healthz       HTTP 502   time=0.296s   body="error code: 502"
             /config.json   HTTP 502   time=0.232s   body="error code: 502"
             /              HTTP 502   time=0.201s   body="error code: 502"
```

Headers observed: `server: cloudflare`, `cf-ray: a3a495efdc7c6cb2-CDG`, `alt-svc: h3=":443"`. No `x-mycelium-*` headers — origin was never reached.

Raw probe transcript: `artifacts/w6-v2/w6v3/l-populate/live-origin-probe.txt`.

## 2. Why no DEMO traffic was sent

Per the L-POPULATE task brief: *"If the live origin is still failing (STALE_QUALIFICATION or 503), STOP and write a clear blocker report. Do NOT spam retries."* The 502 from Cloudflare is a stricter version of that condition — there is no origin at all, so any "request" would either be queued by Cloudflare's edge or hit the deadline with the same body. Issuing requests under these conditions would:

- Burn DEMO sponsor budget against edge errors (no upstream means no payment header gets a real response).
- Pollute the local operator's incident timeline with false-positive errors.
- Generate no TheGraph indexable events (no `publishReceipt` fires without an upstream inference).

## 3. Cross-reference

- TheGraph Studio endpoint `v0.3.2` (`https://api.studio.thegraph.com/query/1758934/ethonline-sepolia-receipts/v0.3.2`) is **not** verified here — the parent already deployed it via L-GRAPH-POPULATE (commit `f8a6ebb`, evidence `docs/handoffs/w6-v3-graph-deploy-evidence.md`). This worker did not poll it because the populate loop never ran, so provider counts would not have advanced regardless.
- L-FANOUT (`43e3ab5`) wires `publishReceipt` + `publishAuditMessage` correctly per its test suite, so once the origin is back the loop will index.

## 4. Required owner action (parent dispatch path)

Per the deploy runbook (`docs/handoffs/w6-v3-deploy-runbook.md`), the live copy on m4pro is supervised by launchd:

```
launchctl kickstart -k gui/$(id -u)/now.mycelium.edge
launchctl kickstart -k gui/$(id -u)/now.mycelium.free-app
launchctl kickstart -k gui/$(id -u)/now.mycelium.paid-app
```

A 502 from Cloudflare with `cf-ray: …CDG` on `/healthz` is consistent with one of:

1. **Origin supervisor is down** — `launchctl list | grep mycelium` will show a non-zero exit / no PID for the three plists. `kickstart -k` as above brings them back; `curl -fsS https://mycelium.now/healthz` should return `{"status":"ok"}` within ~10s.
2. **Tunnel / cloudflared is down** — the `h3-cloudflared` artifact dir + `docs/handoffs/w6-v3-deploy-runbook.md` §3 describe the quick-runner; `cloudflared` should be re-attached.
3. **Origin is up but DNS / tunnel hostname mismatch** — `/etc/cloudflared/config.yml` on the live copy may have been overwritten by an unrelated change.

Once the origin returns `200 {"status":"ok"}` and `/config.json` shows the DEMO sponsor (`payerAccountId: 0.0.10512628`, `recipient: 0.0.10419316`, `queue.maxConcurrency: 1`), this worker can be re-dispatched with the script template below (still owned by L-POPULATE; no edits outside `scripts/w6-populate.mjs`, `docs/handoffs/w6-v3-populate-evidence.md`, `artifacts/w6-v2/w6v3/l-populate/`).

## 5. Script template (for re-dispatch; NOT yet created)

The planned `scripts/w6-populate.mjs` (≤80 lines, owner files only) will:

1. `GET https://mycelium.now/config.json` once, confirm `payerAccountId === "0.0.10512628"` and `queue.maxConcurrency === 1`, abort otherwise.
2. Loop 25 times: `POST https://mycelium.now/v1/chat/completions` via `packages/access/src/index.mjs` (v3 openai-compatible) with a minimal 1-token prompt. Use the DEMO sponsor payment header (`x-mycelium-sponsor: demo`), NOT owner wallet — DEMO sponsor is public per task brief.
3. Capture `{receiptDigest, txHash, statusCode, latencyMs}` per iteration; sleep 5s between iterations to respect `queueCap: 8` and `maxConcurrency: 1`.
4. At the end: print summary (sent, success, average latency, sample digests). After a 30s indexer grace period, query the Graph endpoint and record `providerCounts`.
5. No mainnet traffic, no key reads, no broadcasts — DEMO sponsor pays on Sepolia/Hedera testnets only.

## 6. Files touched this dispatch

- `docs/handoffs/w6-v3-populate-evidence.md` (this file)
- `artifacts/w6-v2/w6v3/l-populate/live-origin-probe.txt` (raw probe transcript)
- `artifacts/w6-v2/w6v3/l-populate/report.md` (worker report — see sibling)

No `scripts/w6-populate.mjs` was written — task scope was blocked before reaching the script-authoring step, and creating an unrunnable script would falsely imply the populate flow had been exercised.

## 7. Budget used

3 / 12 API calls. Reserved for retries are unused. Total runtime: ≈ 9s wall (3 curl probes + 1 env probe + 2 file writes).