# W6 TEE verifier worker — deliverables, deploy runbook, compatibility matrix

**Date:** 2026-09-13
**Author:** W6 subagent lane (build; no live-app wiring, no service restarts, no remote actions)
**Status:** `local_ready` — all files new, all local suites green. **NOT deployed,
NOT wired into the running demo app.** Flipping the live app is a driver-owned
action (§7, documented not performed).

Every claim below is tagged: **[VERIFIED]** = produced by a command run in this
lane with the output quoted; **[READ]** = read from the cited file:line;
**[OPEN]** = requires the TEE host operator / driver (cannot be done or verified
from this machine).

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Is there now a deployable worker that speaks the bridge's exact contract? | **Yes.** `composition/tee-verifier-worker/` — Python stdlib only, `POST /v1/stdio` with bearer auth, exact 3-key reply envelope, all 7 bridge ops [VERIFIED by the integration test running the real `w6-verifier-bridge.mjs` against it over TLS]. |
| Does it perform real (non-stub) per-request verification math? | **Yes.** Deterministic ensemble target-vs-rest test with exact binomial tails; match / mismatch / inconclusive / unavailable with full statistics in the receipt [VERIFIED by 31 unit tests + integration test]. |
| Does it claim TEE guarantees? | **No — deliberately.** Every payload object carries `evidenceClass: "worker-unattested"`; `/attestation` is an honest passthrough/501 stub listing what real attestation must add. It never fabricates a token [VERIFIED: smoke + node test assert no `eyJ…` JWT material]. |
| Is it wired into the live app? | **No.** Nothing in `~/.config/mycelium/w6-supervisors.env` was touched; the running paid app is unchanged (still `observation-only-assessment-unavailable`). |
| Does the TEE host now serve `/v1/stdio`? | **No.** Re-probed 2026-09-13 read-only: `34.7.61.130:8765/v1/stdio` → 404, `:8766/v1/stdio` → 404 (`/healthz` 200 on both) [VERIFIED]. Deployment of this worker to that host is [OPEN] — no SSH access (established by `docs/handoffs/tee-verifier-bringup.md`). |
| Smallest honest flip path | §7 go/no-go checklist: host the worker at an HTTPS origin the paid app can reach, populate a reference bank, set `W6_VERIFIER_TEE_URL` (+ contract-mandatory bearer), restart the paid app; rollback is unsetting the var + restart. |

---

## 1. Files created (all new; SHA-256 shown for the exact bytes)

| File | SHA-256 | What it is |
|---|---|---|
| `composition/tee-verifier-worker/tee_verifier_worker.py` | `a91eb7ec54e286720d28a17364ecd369a35e9c3c8c58e0ebb9d847017a9016f5` | The HTTP worker (bridge contract, ops, TLS, bounded state, CLI) |
| `composition/tee-verifier-worker/tee_verifier_math.py` | `82864ea3a00474c4e1a1a6254321f02588b1590ab0524f46fae208661708b7db` | Pure verification math (digests, exact binomial, decision rule) |
| `composition/tee-verifier-worker/test_verification_math.py` | `3404448a73c8ec2a86af8ed1ce1627340ef7517e70b6407c70f93b261917fd35` | 31 stdlib unit tests, deterministic vectors |
| `composition/tee-verifier-worker/smoke.sh` | `61e4404ba18b1fd432167804d15f07567d4137cc0a62a6273c913b81203daaa1` | curl smoke script (real process, bridge-exact frames) |
| `composition/tee-verifier-worker/README.md` | `eb40fe7f56223ae7c98b1d658d64745ed250e4f0abe6c64df32c316b2a02e811` | Artifact documentation |
| `composition/tee-verifier-worker/fixtures/reference-bank.example.json` | `3bb3ac8063aaf5922d26f8d76eac9406d45076b3e34a8e110e787578f365f7b0` | Synthetic reference bank (smoke + integration test) |
| `composition/tee-verifier-worker/fixtures/test-profiles.json` | `0eb063bd63f04c0b8d2fc46241eb8a1d40e6f9766300dfceb940c48455d22c8a` | Synthetic profile map for the integration test |
| `composition/test/tee-verifier-worker.test.mjs` | `76a84a11c80caf4e55e69842050d741351b7b0d2665b532d33e0763491022598` | Integration test: **real bridge over real TLS** vs this worker |
| `docs/handoffs/w6-tee-verifier-worker.md` | (this file) | Deliverables, runbook, compatibility matrix |

No existing file was edited (`git status --short` shows only new/untracked
paths; no `git add/commit/push` performed). No live service, launchd entry,
supervisor env file, or state directory was touched.

---

## 2. What the worker actually verifies (bounded, documented math)

Implemented in `tee_verifier_math.py`; the receipt carries every intermediate value.

Per `observe`, the worker computes:

1. **Request digest** — `sha256(canonical_json({version:1, kind:"ordinary",
   request_id, provider_id, profile_sha256}))`
   (`tee_verifier_math.py:136-163`; canonicalization matches the bridge's
   `canonicalBytes` logic, `w6-verifier-bridge.mjs:42-56`).
2. **Output digest** — `sha256(utf-8 bytes of response_text)`
   (`tee_verifier_math.py:129-133`).
3. **Reference ensemble** — inline `reference_outputs` extension (highest
   priority; direct callers only) or the pinned reference bank keyed by request
   digest (`tee_verifier_worker.py:513-534`).

Then the **target-vs-rest agreement test** (`ensemble_target_vs_rest`,
`tee_verifier_math.py:220-333`):

```
n = number of reference outputs
k = references whose digest equals the target digest
m = size of the largest agreeing group among the references
p0      = max((m+1)/(n+2), chance_floor)          # Laplace-smoothed rest agreement
pLower  = P(X <= k | X ~ Binomial(n, p0))         # exact, rational arithmetic
pUpper  = P(X >= k | X ~ Binomial(n, p0))

n == 0                          -> inconclusive / no-reference-ensemble
n <  min_members (default 3)    -> inconclusive / insufficient-ensemble
pLower < alpha (default 0.05)   -> mismatch   / target-diverges-from-reference-ensemble
k/n >= agreement_floor (0.6)    -> match      / target-agrees-with-reference-ensemble
otherwise                       -> inconclusive / agreement-below-match-floor
```

Worked vectors (unit-tested exactly):

| n | k | p0 | pLower | verdict |
|---|---|---|---|---|
| 3 | 3 | 4/5 | 1 | match |
| 3 | 2 (2:1 refs) | 3/5 | 98/125 = 0.784 | match |
| 3 | 1 (2:1 refs) | 3/5 | 44/125 = 0.352 | inconclusive (below floor) |
| 3 | 0 | 4/5 | 1/125 = 0.008 | **mismatch** (the `demo attacker` case) |
| 2 | any | — | — | inconclusive (insufficient) |

Honest reading of the result:

- A **match** means *consistent with the reference ensemble at/above the
  configured agreement floor*, not "proved correct".
- A **mismatch** means the target agrees with the rest-of-ensemble
  significantly less than the rest agrees with itself (α).
- **inconclusive** / **unavailable** are first-class outcomes; nothing upgrades
  them.
- The bank is only as trustworthy as its reference outputs. This lane ships
  **synthetic** fixtures; generating real reference outputs from real reference
  models is a separate workstream [OPEN] (per the repo contract this lane runs
  no models and reads no private banks).
- A `mismatch` creates one bounded, explicitly-labelled audit record
  (`tee-audit-NNNNNN-<digest8>`) returned in `audit_ids` and via `op:"audits"`
  (`tee_verifier_worker.py:619-636`). State is in-memory and bounded
  (256 observations / 32 audits — `:105-106`); durable journaling inside the
  enclave is a documented TODO.

---

## 3. Worker routes and the exact wire contract

Routes served (`tee_verifier_worker.py:781-889`):

| Route | Method | Behavior |
|---|---|---|
| `/v1/stdio` | POST | Bridge protocol: Bearer auth → 401 otherwise; `application/json` → 415 otherwise; single-line JSON ≤ 2 MiB−1 → 413/400 otherwise; reply envelope has **exactly** `{version, ok, result\|error}` with HTTP 200 (op-level errors included, matching `w6-verifier-serve.mjs` semantics) |
| `/healthz` | GET | 200: liveness + config summary + bank status; `evidenceClass: "worker-unattested"` |
| `/attestation` | GET | Proxy passthrough when `W6_TEE_VERIFIER_ATTESTATION_URL` set; **else 501** with `reason: "attestation-not-configured"` and the requirements list (`tee_verifier_worker.py:114-126`) — no fabricated claims |
| other | any | 404 `{"ok":false,"reason":"not-found"}` |

Ops: `observe`, `audits`, `scores`, `run` (returns `[]` — verification is
synchronous; there is no pending queue), `observation`, `audit`, `close`
(`tee_verifier_worker.py:902-971`).

Exact observe exchange (identical to what the bridge sends/validates):

```json
--> {"op":"observe","response":{"kind":"ordinary","profile_sha256":"<64hex>",
     "provider_id":"<id>","request_id":"<id>","response_text":"<text>","version":1},
     "version":1}
<-- {"version":1,"ok":true,"result":{
      "version":1,"request_id":"<id>","provider_id":"<id>",
      "random_selected":true,"audit_ids":[],
      "verdict":"match","evidenceClass":"worker-unattested",
      "evidence":{"test":"ensemble-target-vs-rest-binomial-v1",
        "reason":"target-agrees-with-reference-ensemble",
        "request_digest":"<64hex>","output_digest":"<64hex>",
        "referenceCount":3,"agreementCount":3,"agreement":1.0,
        "p0":0.8,"p0Rational":"4/5","pLower":1.0,"pLowerExact":"1/1",
        "pUpper":0.512,"pUpperExact":"64/125","alpha":0.05,
        "agreementFloor":0.6,"minMembers":3,"chanceFloor":0.0,
        "referenceSource":"bank","bankId":"...","members":[...],
        "checkedAt":"...","workerVersion":"w6-tee-verifier-worker/0.1.0"}}}
```

Documented worker semantics (deliberate, so consumers are not surprised):

- `random_selected` = `true` when the observation was matched to a reference
  ensemble and evaluated (including inconclusive verdicts); `false` when no
  ensemble was available. Per-request verification is the design; it is **not**
  random sampling.
- `audit_ids` is `[]` except on `mismatch`, where it lists the one escalation
  record created for this observation.
- Duplicate identical observe → deterministic replay (`duplicate:true`); same
  request id with a different output → `ok:false, error:"observation-conflict"`
  (mirrors the client journal's fail-closed semantics, `w6-verifier-bridge.mjs:526-539`).

---

## 4. Test evidence (real outputs from this lane)

All commands run 2026-09-13 from the workbench root with hermetic Python
(`env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 -I -B`).

**Python unit tests — 31/31 OK** [VERIFIED]:

```
$ env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
    /opt/homebrew/bin/python3.14 -I -B test_verification_math.py
...
Ran 31 tests in 0.001s
OK
```

(Deterministic vectors: digest known-answers incl. a hand-built canonical byte
string; hand-derived binomial fractions; brute-force enumeration cross-check;
every decision branch; alpha/chance-floor knobs; determinism; fail-closed
config.)

**curl smoke — SMOKE PASS** [VERIFIED]:

```
# worker listening on 127.0.0.1:63863
ok: GET /healthz -> 200, evidenceClass=worker-unattested, bank loaded (4 entries)
ok: observe match (bank refs) -> verdict=match
ok: observe mismatch (bank refs) -> verdict=mismatch
ok: observe without references -> verdict=inconclusive
ok: observe with inline references -> verdict=match
ok: op audits -> 1 escalated audit (tee-audit-000001-011ea092)
ok: POST without/with wrong bearer -> 401
ok: GET /nope -> 404
ok: GET /attestation -> 501 honest stub (requirements listed, no token fabricated)
SMOKE PASS
```

**Integration test — real `w6-verifier-bridge.mjs` over real TLS — 11/11 pass** [VERIFIED]:

```
$ PYTHON=/opt/homebrew/bin/python3.14 node --test composition/test/tee-verifier-worker.test.mjs
# tests 11
# pass 11
# fail 0
```

Covers: `bridge.mode === "tee-attested"`; `bridge.start()` handshake; match
receipt field-for-field; mismatch → `audit_ids[0]` → `bridge.getAudit` →
`bridge.listAudits`; deterministic replay; conflict refusal; unreferenced →
honest inconclusive; exact envelope keys; unknown op / bad version envelopes;
401/415 fail-closed; `/healthz` + honest 501 attestation stub; clean close
(worker keeps serving; only the client bridge closes).

One real bug was found and fixed by this suite: the op-rejection envelope
initially returned an invalid HTTP status line (the wire version was passed in
place of the status). Fixed in `_send_envelope_error`
(`tee_verifier_worker.py:747-750`); all suites re-run green afterwards.

---

## 5. Compatibility matrix — worker returns vs bridge validates

| # | Client expectation (source) | Worker implementation (source) | Evidence |
|---|---|---|---|
| 1 | Transport selected only when `W6_VERIFIER_TEE_URL` set → `mode="tee-attested"`; `HttpsTransport` ([`w6-verifier-bridge.mjs:438-444`]) | Serves TLS when cert/key env set; refuses to start without TLS unless loopback+explicit opt-in ([`tee_verifier_worker.py:166-246`, `:1002-1013`]) | integration test asserts `scheme=https`, `bridge.mode` |
| 2 | URL must be `https://`, no userinfo/query/hash ([`w6-verifier-bridge.mjs:246-260`]) | n/a (client-side); worker only needs to be reachable at such an origin — runbook §6 | §6 |
| 3 | Bearer required 1–8192 chars ([`w6-verifier-bridge.mjs:261-262`]); sent as `authorization: Bearer …` ([`:292-296`]) | Bearer required at startup (env or 0600 file, ≤8192 bytes); constant-time compare (`hmac.compare_digest`) else 401 ([`tee_verifier_worker.py:221-246`, `:752-761`, `:842-844`]) | smoke: 401 no-auth + wrong-bearer; node: 401 |
| 4 | Endpoint is always `<base>/v1/stdio`, POST ([`w6-verifier-bridge.mjs:263-266`, `:291`]) | `do_POST` accepts only `/v1/stdio` ([`tee_verifier_worker.py:838-841`]); other routes 404 | smoke: `/nope` 404; node: envelope test |
| 5 | Body: canonical single JSON line, ≤ 2 MiB ([`w6-verifier-bridge.mjs:93-97`]; serve-side one-line rule [`w6-verifier-serve.mjs:148-162`]) | One-line enforced (raw `\n`/`\r` → 400), size cap 2 MiB−1 → 413, UTF-8 decode ([`tee_verifier_worker.py:99-100`, `:763-777`, `:849-855`]) | exercised by every node/smoke POST |
| 6 | Reply envelope **exactly** `{version, ok, result}` / `{version, ok, error}`, version 1, else `VERIFIER_INVALID_REPLY`/`VERIFIER_VERSION_MISMATCH` ([`w6-verifier-bridge.mjs:67-91`]) | Emits exactly those keys with version 1 ([`tee_verifier_worker.py:873-880`]); op rejections → HTTP 200 + `{version:1, ok:false, error}` ([`:747-750`]) | node: "wire envelope has exactly the three keys"; unknown-op/version tests |
| 7 | `observe` frame shape + identifier/digest/text constraints ([`w6-verifier-bridge.mjs:391-416`, `:540-545`]) | Mirrors constraints; invalid → `ok:false, error:"invalid-observation"` ([`tee_verifier_worker.py:102-103`, `:473-491`]) | node: every bridge `observeCompleted` call; unit tests |
| 8 | Receipt must echo `request_id`/`provider_id`, have boolean `random_selected`, array `audit_ids`; extra fields are not rejected ([`w6-verifier-bridge.mjs:546-553`]) | Receipt has exactly those + verdict/evidence/evidenceClass extensions ([`tee_verifier_worker.py:638-676`]) | node: match + mismatch receipts asserted field-by-field |
| 9 | `transport.start()` → `{version:1, op:"audits"}` handshake ([`w6-verifier-bridge.mjs:273-275`, `:459-468`]) | `audits` → array of escalation records ([`tee_verifier_worker.py:919-920`]) | node: `bridge.start()` succeeds; audits returns array |
| 10 | `scores` / `run` / `observation` / `audit` passthrough ([`w6-verifier-bridge.mjs:610-616`]) | `scores` = bounded score ledger; `run` = `[]` (synchronous by design — documented); `observation`/`audit` = record or `null` ([`tee_verifier_worker.py:922-969`]) | node: `getAudit` known + unknown; `listAudits` |
| 11 | Timeout via AbortController; `redirect:"error"` ([`w6-verifier-bridge.mjs:286-299`]) | Answers in ms; never redirects; per-socket timeout 30 s > default client timeout 10 s ([`:711-714`]) | node test (5 s budget) |
| 12 | Reply ≤ 2 MiB ([`w6-verifier-bridge.mjs:313`]) | Replies bounded (evidence block is small, members ≤ 64) | §2 bound |
| 13 | Client journal: identical replay idempotent, conflict refused ([`w6-verifier-bridge.mjs:526-539`]) | Worker-side: replay → `duplicate:true`; conflict → `ok:false/"observation-conflict"` ([`tee_verifier_worker.py:569-575`]) | node: replay + conflict tests |
| 14 | No client requirement for provenance tagging | Every JSON payload object carries `evidenceClass:"worker-unattested"` (const: [`tee_verifier_math.py:74-78`]; receipts/healthz/attestation/records: [`tee_verifier_worker.py:645`, `:793`, `:807`, `:945`, `:971`, `:983`, `:1038`]) — the fixed 3-key envelope itself cannot carry extra keys (see #6), so the class rides on the result/records | smoke + node assertions |

Notes / deviations that are deliberate and documented:

- **Array-shaped op results** (`audits`, `scores`, `run`) keep wheel-compatible
  array shapes (see `composition/test/w6-verifier-integration.test.mjs:173-180`
  for the consumer pattern); `evidenceClass` is carried per record inside them,
  not on the array.
- `w6-verifier-ensemble.mjs:117-119` (placeholder default runner) reads
  `receipt.audit_ids.length > 0` as a positive vote; this worker returns a
  non-empty `audit_ids` only on **mismatch**. The placeholder runner is already
  documented as transport-level only and "until a model-trained scorer ships"
  (`w6-verifier-ensemble.mjs:100-104`); the worker's `verdict` field is the
  authoritative outcome for any consumer. Do not wire the placeholder runner to
  interpret `audit_ids` as a match signal.
- The W12 audit-escalation rule (3 mismatches → audit,
  `w12-verifications-store.mjs:17,96-117`) remains **client-side demo logic**;
  this worker produces per-observation escalation records on mismatch and does
  not aggregate thresholds. A future driver integration should map
  `receipt.verdict` onto `recordObservation({verdict})` vocabulary
  (`w12-verifications-store.mjs:53`) without changing either side.

---

## 6. Deployment runbook — running this worker inside the TEE host [OPEN]

**Current state (re-probed read-only 2026-09-13, this lane):**
`34.7.61.130:8765/healthz` → 200, `:8765/v1/stdio` → **404**;
`34.7.61.130:8766/healthz` → 200, `:8766/v1/stdio` → **404**. There is still no
`/v1/stdio` anywhere and no SSH from this Mac (§ bringup doc). Everything below
is for the operator who has host access; nothing here was executed.

**Step 0 — prerequisites (operator):**
- Access to the TEE host (image build/push + redeploy, or equivalent file
  placement). The T2 image reports `python:3.11.16` (`/info`), which runs this
  worker as-is (stdlib only; Python ≥ 3.9).
- A bearer secret for the channel (e.g. `openssl rand -hex 32`), delivered to
  both sides out-of-band; on the worker prefer `W6_TEE_VERIFIER_BEARER_FILE`
  (0600) over an env var.

**Step 1 — place the two files** (`tee_verifier_worker.py`,
`tee_verifier_math.py`) side by side anywhere on the host/image, e.g.
`/opt/mycelium/tee-verifier-worker/`. Add the reference bank JSON (Step 3).

**Step 2 — start it with TLS or behind a TLS terminator.** The client bridge
rejects cleartext (`https://` only, §5 row 2), so one of:
- **(a) Worker terminates TLS** (matches the intended `w6-verifier-tee` layout
  where the container listens on 8443):
  ```sh
  W6_TEE_VERIFIER_HOST=0.0.0.0 W6_TEE_VERIFIER_PORT=8443 \
  W6_TEE_VERIFIER_BEARER_FILE=/run/secrets/w6-verifier-bearer \
  W6_TEE_VERIFIER_TLS_CERT=/run/secrets/tls.crt \
  W6_TEE_VERIFIER_TLS_KEY=/run/secrets/tls.key \
  W6_TEE_VERIFIER_REFERENCE_BANK=/opt/mycelium/tee-verifier-worker/reference-bank.json \
  python3 -I -B /opt/mycelium/tee-verifier-worker/tee_verifier_worker.py serve
  ```
  The certificate must be **trusted by the paid app's `fetch`** — a self-signed
  cert fails Node's default trust store (test harnesses here inject a
  permissive fetch; production must not). Options: a real cert for the origin,
  or (b).
- **(b) TLS terminator in front** (e.g. the existing Cloudflare tunnel path —
  `artifacts/w6-v2/h3-cloudflared/`, where the DNS record was deliberately not
  added): run the worker loopback-only (plaintext requires
  `W6_TEE_VERIFIER_ALLOW_PLAINTEXT=1` + `W6_TEE_VERIFIER_HOST=127.0.0.1`) and
  expose it through the terminator on an https origin.

No `verify` route needs to be added to the existing 8765/8766 containers —
this worker is a new, self-contained process; run it alongside them.

**Step 3 — populate the reference bank** for the requests you intend to verify:
- Keys: `python3 tee_verifier_worker.py request-digest --request-id R
  --provider-id P --profile-sha256 S` (worker CLI, `tee_verifier_worker.py:1084-1095`).
- Values: reference outputs (`output_text` or `output_digest`) — in production
  these are the reference-model outputs for that request; in the demo wiring
  they are whatever the operator pins. **Synthetic content only in this repo.**
- With no bank (or a miss), observations return
  `inconclusive / no-reference-ensemble` — honest, never fabricated.

**Step 4 — verify from inside the host, then from the app host:**
```sh
curl -sS https://<origin>/healthz                     # expect ok:true, bank.loaded per Step 3
curl -sS -X POST https://<origin>/v1/stdio \
  -H 'Authorization: Bearer <bearer>' -H 'Content-Type: application/json' \
  --data-binary '{"op":"audits","version":1}'          # expect {"version":1,"ok":true,"result":[...]}
```
(The smoke script `smoke.sh` is the reference for the full expected behavior.)

**Step 5 — the one env var to set (driver-owned, §7):** on the paid-app host,
in `~/.config/mycelium/w6-supervisors.env`:
```sh
W6_VERIFIER_TEE_URL=https://<origin>
W6_VERIFIER_TEE_BEARER=<same bearer as W6_TEE_VERIFIER_BEARER>
```
`W6_VERIFIER_TEE_URL` is **the** mode switch
(`w6-verifier-bridge.mjs:427,438`), but the bearer is contract-mandatory
alongside it (`:261-262`, `VERIFIER_TEE_BEARER_REQUIRED`) and must equal the
worker's bearer. Optional: `W6_VERIFIER_TIMEOUT_MS` (`:431`, default 10000 —
ample; the worker's math is sub-millisecond). Then restart
`now.mycelium.paid-app` (driver action; **not performed here**).

**Rollback:** unset `W6_VERIFIER_TEE_URL` (+ restart) — the paid app reverts to
the `observation-only-assessment-unavailable` path
(`w6-paid-observation-bridge.mjs:40-53`).

**Attestation — what is still missing on the host** (kept deliberately honest
by the worker's `/attestation` stub, `tee_verifier_worker.py:114-126`,
`:799-830`): a nonce-bound workload attestation JWT issued by the Confidential
Space launcher/SEV-SNP verifier, signed by a key generated in the CVM,
verifiable against platform JWKS and binding this worker's image digest. The
live `:8766` shim JWT is HS256 demo-signed with an in-process secret
(`tee_launcher.py:20-26, 294-318`) — wiring the stub's
`W6_TEE_VERIFIER_ATTESTATION_URL` to it would pass a *demo* token through, and
must not be represented as real TEE attestation. Until a real issuer exists,
`evidenceClass` stays `worker-unattested` everywhere.

---

## 7. Go/no-go checklist for flipping the live app (driver-owned — NOT performed)

- [ ] Worker reachable from the paid-app host over **https://** with a cert the
      app's `fetch` trusts (no self-signed; or TLS terminator in front).
- [ ] `POST {op:"audits"}` from the app host returns HTTP 200 with the exact
      3-key envelope (this is `bridge.start()`; a failure surfaces as
      `VERIFIER_HTTPS_REJECTED`/`VERIFIER_INVALID_REPLY`).
- [ ] Bearer set on both sides and equal; wrong bearer → 401.
- [ ] Reference bank loaded (`/healthz` → `bank.loaded:true`) and contains
      entries for the demo request ids (`request-digest` keys verified with the
      worker CLI); a dry-run observe for a demo request returns a sane verdict.
- [ ] `W6_VERIFIER_TIMEOUT_MS` ≥ worker worst case (default 10 s is ample).
- [ ] Rollback rehearsed: unset `W6_VERIFIER_TEE_URL`, restart, confirm the app
      returns to the observation-only path.
- [ ] Posture text reviewed: the UI may say "HTTPS-fronted / in-TEE verifier
      running real ensemble statistics"; it may **not** say "TEE-attested
      per-request verification" until real attestation lands and `evidenceClass`
      can flip.
- [ ] Acknowledge: verdicts are only as good as the pinned reference bank;
      synthetic bank = wiring demonstration, not evidence about providers.

---

## 8. What remains / honest limitations

1. **Deployment to the TEE host** [OPEN] — needs host access; re-probe today
   confirms neither port serves `/v1/stdio`. No SSH from this Mac.
2. **Public HTTPS origin with a trusted certificate** [OPEN] — Cloudflare DNS
   record deliberately absent (per `artifacts/w6-v2/h3-cloudflared/build-summary.md`);
   T3 wiring task.
3. **Real reference-model outputs for the bank** [OPEN] — separate model-side
   workstream; this lane ships synthetic fixtures only and runs no models.
4. **Real attestation issuer** [OPEN] — see §6; the worker refuses to fake it.
5. **Durable worker state** — ledgers are in-memory and bounded; durability
   inside the enclave is a TODO.
6. **Not verified by this lane**: end-to-end behavior of the paid app in
   `tee-attested` mode (requires the §7 flip), any remote-host behavior, and
   the actual demo provider flow against a populated production bank.

## 9. Hard-rule compliance

- New files only: `composition/tee-verifier-worker/**`,
  `composition/test/tee-verifier-worker.test.mjs`, this handoff. No edits to
  existing files; no `git add/commit/push` [VERIFIED by scoped `git status`].
- No service restarts, no supervisor/env-file changes, no launchd actions; the
  live copy at `~/Library/Application Support/Mycelium/w6-workbench` untouched.
- No secrets printed or persisted: all bearers/tokens in tests are synthetic;
  logs never include response text, bearers, or keys
  (`tee_verifier_worker.py:154-160`).
- Python used hermetically (`-I -B`, `PYTHONPATH` stripped,
  `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`); no package installs.
- Remote probe was read-only `curl` (`/healthz`, `/v1/stdio` 404 check) with
  5 s timeouts; no remote state changed.

---

## 10. Deployment record — worker deployed to the TEE host (second container, 2026-09-13)

**Lane:** W6 deploy subagent (owner-authorized remote deployment; supersedes the
§6/§8 "Deployment to the TEE host [OPEN]" status). **Scope discipline:**
the existing `verifier` container (8765/8766/443) was not stopped or modified;
no supervisor env edits; no local services touched; **no firewall changes were
made**; no git operations. Every claim tagged [VERIFIED] with the command output.

### 10.1 What was deployed (byte-exact)

| Artifact | SHA-256 (local == VM) | VM location |
|---|---|---|
| `tee_verifier_worker.py` | `a91eb7ec54e286720d28a17364ecd369a35e9c3c8c58e0ebb9d847017a9016f5` (matches §1) | `/home/evinova-self/w6-verifier-worker/` |
| `tee_verifier_math.py` | `82864ea3a00474c4e1a1a6254321f02588b1590ab0524f46fae208661708b7db` | idem |
| reference bank (synthetic `reference-bank.example.json`) | `3bb3ac8063aaf5922d26f8d76eac9406d45076b3e34a8e110e787578f365f7b0` | idem, deployed as `reference-bank.json` |

Pre-deploy gates re-run on the exact bytes: **31/31 math tests `OK`**; **11/11
bridge-over-TLS integration tests pass** (`# pass 11 / # fail 0`). Contract diff
of the bridge (`w6-verifier-bridge.mjs`) vs the worker (route `POST
<base>/v1/stdio`, Bearer auth, single-line canonical JSON, exact
`{version, ok, result|error}` envelope) found **no mismatch — no worker code
changes were needed before deployment**.

### 10.2 Container facts [VERIFIED]

- Host: `mycelium-verifier-t3-20260913` (project `mycelium-demo`, zone
  `europe-west4-a`, static IP `34.7.61.130`, tag `verifier-t3`).
- **Container:** name `verifier-w6-tee`, id
  `118a021333daed6bd0632462088123ad9ab7fb7472036a647ac7a2d6f49df6ff`, image
  `europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier:tee-shim-v1-1789264808`
  (image id `sha256:f16dbc6745281a4c775724fb2ac44a32e1fededdfd88590b2ee89b56c4ccc719`;
  same base image as the live container), `--restart unless-stopped`,
  `-p 8767:8767`, code mounted read-only at `/opt/w6-verifier-worker`,
  label `w6.workload=tee-verifier-worker`, custom healthcheck
  (`/bin/sh /opt/w6-verifier-worker/healthcheck.sh` → `https://127.0.0.1:8767/healthz`)
  → reports **`healthy`** [docker inspect]. (A first iteration `c7a8820e0568` was
  replaced within a minute by the current container to swap the image's inherited
  8766 health probe for the 8767 probe; nothing depended on it.)
- **Executable/run command** (reproducible):
  ```sh
  docker run -d --name verifier-w6-tee --restart unless-stopped \
    --label w6.workload=tee-verifier-worker --entrypoint python3 -p 8767:8767 \
    --health-cmd "/bin/sh /opt/w6-verifier-worker/healthcheck.sh" \
    --health-interval 15s --health-timeout 5s --health-retries 5 --health-start-period 10s \
    -v /home/evinova-self/w6-verifier-worker:/opt/w6-verifier-worker:ro \
    -e W6_TEE_VERIFIER_HOST=0.0.0.0 -e W6_TEE_VERIFIER_PORT=8767 \
    -e W6_TEE_VERIFIER_BEARER_FILE=/opt/w6-verifier-worker/bearer.txt \
    -e W6_TEE_VERIFIER_TLS_CERT=/opt/w6-verifier-worker/tls/cert.pem \
    -e W6_TEE_VERIFIER_TLS_KEY=/opt/w6-verifier-worker/tls/key.pem \
    -e W6_TEE_VERIFIER_REFERENCE_BANK=/opt/w6-verifier-worker/reference-bank.json \
    europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier:tee-shim-v1-1789264808 \
    -I -B /opt/w6-verifier-worker/tee_verifier_worker.py serve
  ```
  `--entrypoint python3` is deliberate: the base image's
  `/opt/tee-launcher/entrypoint.sh` (flask + tee-launcher) never runs in this
  container; the worker is the only process.
- **Bearer:** generated on-VM (`openssl rand -hex 32`), stored at
  `/home/evinova-self/w6-verifier-worker/bearer.txt` (mode 0600). The value is
  deliberately NOT recorded in this doc; read it on the VM (see §10.5).
- **TLS:** self-signed RSA-2048 generated on-VM; `CN=mycelium-verifier-t3-w6`;
  SAN `IP:34.7.61.130, IP:127.0.0.1, DNS:localhost`; SHA-256 fingerprint
  `29:05:25:FB:09:51:04:5D:C6:AB:2B:0D:00:96:6E:94:5C:96:63:48:4A:11:74:35:B8:5D:4A:F0:F8:C0:FC:B1`;
  valid until 2028-12-16.
- **Old services untouched** [VERIFIED]: container `verifier` (`fa51993edd5b`)
  `Up 13 hours+ (healthy)`, ports `8765-8766`, `443→8765` unchanged;
  `curl 127.0.0.1:8765/healthz` and `:8766/healthz` → 200 before and after.
- VM-local worker checks [VERIFIED]: `curl -k https://127.0.0.1:8767/healthz` →
  `ok:true, tls:true, bank.loaded:true (4 entries), evidenceClass:worker-unattested`;
  `{op:"audits"}` → `{"version":1,"ok":true,"result":[]}`; observe
  `tee-worker-test-match-1` → `verdict:"match"`; unauthenticated POST → 401.

### 10.3 Network / TLS state (what remains)

- **VPC firewall:** rule `allow-verifier-https` (target tag `verifier-t3`) allows
  `tcp:443,tcp:8765,tcp:8766` only. **tcp:8767 is dropped** [VERIFIED:
  `gcloud compute firewall-rules list`; from this Mac `curl` to
  `34.7.61.130:8767` → connect timeout ~6–8 s; `:8765/:8766` → 200].
- Host `34.7.61.130:443` is **plain HTTP** (maps to the existing container's
  8765); `https://34.7.61.130/...` fails TLS [VERIFIED]. `https://verifier.mycelium.now`
  (Cloudflare) has a real Let's Encrypt cert but proxies to the old Flask only —
  `/v1/stdio` → 404 — so it cannot carry the worker without infra changes.
- Nothing on the VM side is missing: cert, bearer, bank, healthcheck, restart
  policy are all in place. **Once the firewall allows tcp:8767, the endpoint is
  complete.**

### 10.4 Network smoke evidence (real round-trips through the deployed container)

Harness: `/tmp/w6-tee-network-smoke.mjs` on this Mac — the integration-test
pattern driving the REAL `w6-verifier-bridge.mjs` over the network against the
deployed container, via an SSH tunnel
(`gcloud compute ssh … -- -N -L 18767:127.0.0.1:8767`) [all VERIFIED 2026-09-13]:

| # | Target | Client fetch | Result |
|---|---|---|---|
| 1 | `https://127.0.0.1:18767` (tunnel) | injected permissive TLS fetch (integration-test posture) | **PASS** — `mode:"tee-attested"`, handshake, match (`pLowerExact 1/1`), mismatch → audit `tee-audit-000001-011ea092`, `getAudit`, `listAudits` |
| 2 | same | bridge default (`globalThis.fetch`) | **FAIL** `VERIFIER_HTTPS_UNAVAILABLE`; raw error `DEPTH_ZERO_SELF_SIGNED_CERT` (expected: Node default trust rejects self-signed) |
| 3 | same | default + `NODE_TLS_REJECT_UNAUTHORIZED=0` | **PASS** (exit 0, all steps) |
| 4 | same | default + `NODE_EXTRA_CA_CERTS=<deployed cert>` | **PASS** (exit 0, all steps) — the clean trust option, verified end-to-end |
| 5 | `https://34.7.61.130:8767` (direct) | permissive fetch, 5 s | **FAIL** `VERIFIER_TIMEOUT` — TCP connect blocked by the VPC firewall |

A copy of the deployed cert was fetched to this Mac during smoke:
`/tmp/w6-verifier-t3.crt` (fingerprint in §10.2). The smoke script is at
`/tmp/w6-tee-network-smoke.mjs`. The tunnel was test-only and was killed after
the run.

### 10.5 Driver flip — exact values

**`W6_VERIFIER_TEE_URL=https://34.7.61.130:8767`** (no path/query; the bridge
appends `/v1/stdio`). Required alongside it:

1. **One firewall change (owner; not made during this deployment):**
   ```sh
   gcloud compute firewall-rules create allow-verifier-w6-tee-8767 --project mycelium-demo \
     --network default --direction INGRESS --priority 1000 --action ALLOW \
     --rules tcp:8767 --source-ranges 0.0.0.0/0 --target-tags verifier-t3
   # alternative: gcloud compute firewall-rules update allow-verifier-https \
   #   --project mycelium-demo --allow tcp:443,tcp:8765,tcp:8766,tcp:8767
   # harden later by narrowing --source-ranges to the app host's egress IP
   ```
2. `W6_VERIFIER_TEE_BEARER=<read it on the VM>`:
   `gcloud compute ssh mycelium-verifier-t3-20260913 --project mycelium-demo --zone europe-west4-a --command "cat /home/evinova-self/w6-verifier-worker/bearer.txt"`
3. TLS trust (the worker cert is self-signed; verified options, §10.4 runs 3–4):
   - **clean:** `NODE_EXTRA_CA_CERTS=<path to cert.pem>` (fetch:
     `gcloud compute scp mycelium-verifier-t3-20260913:/home/evinova-self/w6-verifier-worker/tls/cert.pem <path>`)
   - **demo fallback:** `NODE_TLS_REJECT_UNAUTHORIZED=0` (disables cert
     verification app-wide; not recommended for anything beyond the demo).

Interim alternative if the firewall must stay closed: an SSH tunnel works today
(`-L 18767:127.0.0.1:8767`, then `W6_VERIFIER_TEE_URL=https://127.0.0.1:18767`)
— needs a live tunnel process; fine for a manual dry-run, not for the supervisor.

Rollback for this deployment only (existing services unaffected):
`docker stop verifier-w6-tee && docker rm verifier-w6-tee`.

### 10.6 Honest limitations (unchanged)

- `evidenceClass` remains `worker-unattested` everywhere; `/attestation` is the
  honest 501 stub (no fabricated token). Real attestation stays [OPEN].
- The deployed bank is the **synthetic** example bank (4 test entries); real demo
  request ids return `inconclusive / no-reference-ensemble` until a real bank is
  pinned (edit `reference-bank.json` on the VM, then `docker restart verifier-w6-tee`).
- Worker state (observations/audits) is in-memory and bounded; container restart
  clears it.
- Not verified from this lane: the paid app end-to-end in `tee-attested` mode
  (driver step, §7), and post-firewall reachability (firewall closed at record
  time). Run 5 is the exact failure the paid app would exhibit today.
