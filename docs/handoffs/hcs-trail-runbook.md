# HCS receipt-trail runbook — W6 phase 5 (owner-gated broadcast)

> State: wired, dry-run default, **never broadcast**. The code exists and has
> been exercised end-to-end with fakes and a no-network default proof; the one
> remaining line in `SUBMISSION-REPORT.md` — *"NOT proven: a real HCS topic
> create + canonical submit"* — is closed by the owner/lead agent running the
> sequence below.

Digest-only trail: every completed job's receipt emits exactly one canonical
HCS message (idempotent by `receiptDigest`); every escalation verdict
(`match|mismatch|inconclusive|unavailable`) emits its own message (idempotent
by `verdictId`). Messages contain only digests, codes, and enums — no prompt
text, no output text, no keys, no bearer tokens.

## Files involved

| File | Role |
|---|---|
| `composition/w6-hcs-audit.mjs` | Canonical digest-only message + idempotency journal; dry-run default |
| `composition/w6-fanout-wiring.mjs` | Receipt-completion + escalation-verdict fan-out; reads topic id from env; env-gated broadcast |
| `packages/payments/scripts/hcs-adapter.mjs` | Real submit adapter (SDK build/sign/submit/await SUCCESS) behind an injected signer; offline stub without one |
| `composition/test/w6-hcs-trail.test.mjs` | No-network default proof, idempotency, verdicts, payload dump |
| `composition/test/w6-hcs-audit.test.mjs` | Message-contract tests (topic id, sequence, verdictId keys) |

## Env vars needed to go live

Set these in the launchd environment for the paid/free apps (same place as the
existing `W6_*` vars, e.g. the `~/.config/mycelium/w6-supervisors.env` style
file), then restart the affected services — **owner/lead-agent step**.

| Variable | Value | Meaning |
|---|---|---|
| `W6_HCS_TOPIC_ID` | `0.0.<n>` (from the owner's one-time topic create) | Topic to append to. Until set, everything stays dry-run. |
| `W6_HCS_BROADCAST` | `1` to enable; unset/anything else = off | Master broadcast switch. Off by default. |
| `W6_HCS_SIGNER_KEY_FILE` | absolute path to the operator key file (outside git) | **Path only** — loaded by the parent's operator script at go-live; never read or logged by the wiring module. |

Broadcast turns on only when **all three** hold: `W6_HCS_BROADCAST=1` + a
configured topic id + a submit function injected by the composition layer. A
bare flag can never fire on its own. Topic creation is **not** wired — the
owner creates the fresh dedicated topic once (memo
`mycelium-ethonline-audit-v1`, submit key = operator) and records the id.

## Judge-runbook sentence

> Every receipt and every escalation verdict from this run is appended, in
> order, to Hedera consensus topic `<TOPIC_ID>` — open
> `https://hashscan.io/testnet/topic/<TOPIC_ID>` to audit the digest-only trail.

## Verification sequence (after the owner has created the topic)

1. **Dry-run tests — no network, must be green before anything is flipped:**
   ```sh
   cd <workbench> && node --test composition/test/w6-hcs-audit.test.mjs \
     composition/test/w6-fanout-wiring.test.mjs composition/test/w6-hcs-trail.test.mjs
   ```
   Expected: `# pass 29`, `# fail 0` (and the payload dump shows digests only).

2. **Canonical-bytes dry run (builds the message, never submits):**
   ```sh
   node packages/payments/scripts/hcs-audit.mjs --network hedera:testnet \
     --mode development --topic <TOPIC_ID> --digest sha256:<64hex> --consent
   ```
   Expected output contains `"broadcast": false` — proves the message path
   without a submit.

3. **Owner/lead agent:** set the three env vars, restart the paid/free apps
   (`launchctl kickstart`), then run one normal request and one
   malicious-provider (escalation) request in the UI.

4. **Confirm the first messages on the mirror:**
   ```sh
   curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/<TOPIC_ID>/messages?limit=5" \
     | python3 -c 'import sys,json,base64
   d=json.load(sys.stdin)
   for m in d["messages"]: print(m["sequence_number"], base64.b64decode(m["message"]).decode())'
   ```
   Expected: sequence numbers starting at `1`; bodies are the canonical
   digest-only JSON, e.g.
   `{"version":"1","network":"hedera:testnet","schema":"mycelium-ethonline-audit-v1","receiptDigest":"sha256:…","paymentTxId":"0.0.…@…","registryTxHash":"0x…"|null,"verifierOutcome":null|"match|mismatch|inconclusive|unavailable","submittedAt":"…"}`
   — verdict messages additionally carry `"verdictId":"…"`.

5. **HashScan:** `https://hashscan.io/testnet/topic/<TOPIC_ID>` — sequence
   #1..N in order, one message per receipt and one per escalation verdict.

## What remains for the real broadcast

- One-time topic create (owner) + record the id here and in the judge runbook.
- Set the env vars + inject the real `submitHcs` (operator signer loaded from
  `W6_HCS_SIGNER_KEY_FILE` by the parent's operator script) + app restart.
- First real message for a normal request and one for an escalation; mirror
  verification (step 4) and HashScan (step 5).
- Verdict hook: `application-workbench.mjs` currently exposes
  `onReceiptCompletion` only. For live verdict messages the parent surfaces
  the escalation verdict to `wiring.emitVerdict(...)` (or adds the optional
  `onVerifierVerdict(listener)` hook the wiring already subscribes to when
  present).

## Why it is safe today

- Default path (no `W6_HCS_BROADCAST`): **zero submit calls, zero fetch
  calls** — asserted in `composition/test/w6-hcs-trail.test.mjs`
  ("DEFAULT PATH …") with a poisoned `fetch` and a poisoned submit spy.
- The adapter without an injected signer returns a stub SUCCESS and never
  loads the SDK; no test or wiring path creates a topic or reads a key.
