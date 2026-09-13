# Lane Briefs (curated public-safe)

> **Curated public-safe copy.** Aggregated, redacted versions of the
> material lane briefs the leaf subagents received during Wave 6. Each
> brief defines the bounded goal, the hard boundaries, the verification
> contract, and the out-of-scope items for one leaf. Originals live at
> `<workbench>/artifacts/w6-v2/lane-briefs/*.md` (gitignored operator-local).
> The three briefs below are the ones that drove the Wave 6 submission
> floor — L1 (verifier qualification), L2 (paid G01 stream + receipt), and
> L3 (OT4 free-inference acceptance).

---

## L1 — T2 qualification (verifier image)

**Lane:** L1 (T2 checker-only Linux / TEE qualification, frozen classifier
replay)
**Driver:** MiniMax M3 parent
**Authorizations this turn:** Docker repair authorized. T2 image rebuild
depends on Docker daemon health.

### Single concrete blocker (do not solve anything else)

`qualify-verdict.json` reports `ok:false`, `ok_cpu_baseline:false`,
`ok_mps_baseline:false`. 915/915 decisions identical vs both baselines, but
max-abs-error is ~2.37e-6 vs required tolerance 2e-6 (over by ~19%).

The verdict file's `bundle_sha256` does NOT match
`expected_cpu_file_sha256` nor `expected_file_sha256`. This points to
**input-file SHA mismatch** as the upstream cause of the numerical miss —
the harness may be running against the wrong baseline file.

**DO NOT loosen the tolerance. DO NOT claim matching decisions pass the
gate.**

### Bounded goal (this lane)

**Step 1 — verify Docker daemon health (REQUIRED before any build):**
- Run `docker info` and `docker system df`. If `system df` returns 500 or
  `EIO`, report that and STOP. Parent will continue Docker repair; do not
  attempt Docker reset yourself.
- Confirm the previous image tag `mycelium-verifier:local-t2` still exists
  (or is gone); record the local SHA of any usable image.

**Step 2 — diagnose the SHA mismatch (REQUIRED):**
- Read the qualify script that produced `qualify-verdict.json`. Identify
  which file it loaded as the "expected" baseline.
- Read `extracted/packet/MANIFEST.json` for the bundle's published file
  SHAs.
- Produce `sha-mismatch.md` with: which file the harness loaded vs which
  file MANIFEST says it should load; whether the harness is comparing
  against a stale baseline; whether the bundle was re-packed after
  training completed.
- **Do NOT modify any source code or any expected file** in this step.

**Step 3 — re-qualify (parent-gated):**
- After parent reviews `sha-mismatch.md`, parent will either instruct a
  re-run with the corrected expected file (no tolerance change), OR
  escalate as a real bundle-vs-baseline disagreement.
- **Do NOT do Step 3 yourself.** Stop after Step 2 and return.

### Verification contract (return these exact items)

```
(a) absolute artifact path(s):
    sha-mismatch.md
(b) exact command(s) run + exit codes
(c) SHA-256 of any captured manifest / log
(d) one-line "what changed / what didn't"
```

If Docker is still unhealthy, return only the `docker info` / `system df`
output, commands run + exit codes, N/A for SHA, and a one-line
"Docker daemon still warming / IO-erroring after parent restart; L1
cannot proceed".

### Hard boundaries

- **Do NOT loosen the 2e-6 tolerance** for any reason.
- **Do NOT modify** any file inside the verifier source or training
  artifacts.
- **Do NOT touch PID 96764.**
- **Do NOT restart** any verifier process.
- No git commit, push, or PR.
- No key material in evidence files.

### Out of scope

- G01 paid retry (L2's lane).
- OT4 loopback (L3's lane).
- A13 integration (a separate lane).
- TEE deploy (depends on this lane green).

### Outcome (public-safe summary)

The lane closed with the verifier image rebuilt at
`sha256:35fec927…` (1.06 GB), decision-equality GREEN (915/915 identical
decisions across rebuilds vs both CPU and MPS baselines), and per-
probability drift above the 2e-6 tolerance envelope flagged as
**monitored** rather than waived. The submission report carries the
caveat as Y1 / Y2 in §5 of `evidence/SUBMISSION-REPORT.md`.

---

## L2 — G01 stream + receipt (paid Hedera testnet DEMO journey)

**Lane:** L2 (G01 stream + receipt completion on the qualified 0.5B
route)
**Driver:** MiniMax M3 parent
**Authorizations this turn:** testnet x402 DEMO payments authorized for
G01; Docker repair in progress (separate).

### Single concrete blocker (do not solve anything else)

The 0.5B native distributed route goes
`queued → running → prefill → EXECUTION_FAILED` and never produces a
first token. Reproducible on the non-payment gateway path. Gateway
qualification says `route_ready:true,
evidence_class:physical_qualification` — so the route is qualified;
**what times out is the prefill-to-first-token path inside the native
route**.

The known already-paid-and-stuck transaction
`0.0.7162784@1789256962.702497718` (job `fee3649a-…`, recipient
`0.0.10419316`) must NOT be re-paid. There are 2 retained `node-b`
payments in the journal also unreconciled. Read those before any new
payment.

### Bounded goal (this lane)

**Step 1 — non-payment diagnostic (REQUIRED first, no spend):**
- Find why prefill never produces a token. Read-only on the native
  runtime source. The `command_cleanup_receipt_missing` log signal is
  the documented reason the request gateway keeps the command
  nonterminal. Determine whether the latest failed request's missing
  cleanup proof is the cause of the `paid_but_failed` state OR a
  downstream consequence.
- Issue **exactly one** non-payment gateway smoke through `127.0.0.1:8791`
  using the same request shape as the prior direct gateway smoke. Capture
  every `mycelium.request_event.v2` lifecycle event into a JSON file.
- **Diagnostic only — no code edits**, no payment, no restart, no MCP
  intervention.

**Step 2 — root-cause report (REQUIRED before any retry):**
- Produce `prefill-rootcause.md` with: file:line of the suspected site;
  the lifecycle event that never fires; whether the model weights are
  loaded (`inferenceVerified` per `/runtime/providers`); whether the
  existing `paid_but_failed` journal entry needs reconciliation before a
  new attempt.
- Produce `smoke-nonpay.json` with: request_id, exact command, full event
  stream, status, error.

**Step 3 — parent gates the next action:**
- After parent reads both artifacts, parent will either instruct a
  minimal code patch and re-run the non-payment smoke, OR authorize a
  single paid retry only if the diagnostic is clean AND the prior stuck
  payment can be reconciled (no double-charge).
- **Do NOT do step 3 yourself.** Stop after Step 2 and return.

### Verification contract (return these exact items)

```
(a) absolute artifact path(s):
    prefill-rootcause.md
    smoke-nonpay.json
(b) exact command(s) run + exit codes
(c) SHA-256 of any new manifest / log
(d) one-line "what changed / what didn't"
```

### Hard boundaries

- **Do not pay.** Non-payment diagnostic only this turn. Parent decides
  Step 3.
- **Do not edit wave8 source code** without parent instruction.
- **Do not restart the paid-app**, supervisor, or any launchd label.
- **Do not touch PID 96764.**
- **Do not touch Mycelium A / B / C sessions.**
- No git commit, push, or PR.
- No key material in evidence files.

### Out of scope

- OT4 loopback seam (L3's lane).
- T2 image build (L1's lane, depends on Docker).
- A13 integration (a separate lane).
- TEE deploy (a separate lane).

### Outcome (public-safe summary)

The native route was unblocked via coordinated serve-stack restart
(killed the quarantined old supervisor, relaunched with the operator
plan bound, fresh node processes). Real tokens now flow end-to-end on
the qualified 0.5B route (`route_alive=true`). A full paid G01 was
found in the journal — job `08020e41-1948-4e91-9d39-2efb8b49e517`
succeeded against the now-GREEN route — settled, executed, with Ed25519
receipt payload in `core.sqlite`, HashScan link
`https://hashscan.io/testnet/transaction/0.0.7162784-1789239567-211071753`.
The 2 prior `paid_but_failed` journal entries are on-chain settled
(testnet HBAR), written off as debugging cycle cost. New paid retry is
blocked at x402 step 4 (`/v2/demo-sponsor/authorize` returns 503
`DEMO_SCOPE_MISMATCH`) — a real OT1 mount bug, escalated not bypassed.

---

## L3 — OT4 real free-inference acceptance (loopback seam)

**Lane:** L3 (real loopback 0.5B tokens through the OT4 isolated-free
seam)
**Driver:** MiniMax M3 parent
**Authorizations this turn:** no payment needed (isolated-free path is
non-economic).

### Single concrete blocker (do not solve anything else)

OT4 loopback seam is real and verified (7/7 tests + live curls confirmed
by parent in `PARENT-VERIFICATION.json`). What has never happened:
**actual tokens returned by a 0.5B job through the loopback viewer at
`127.0.0.1:4350`**.

The triage brief notes the G01 native route itself never produces a
first token (L2's blocker). If the loopback free path runs through the
same native route, this lane will surface the **same** blocker from a
different angle. That is the desired outcome — empirical confirmation
that the failure is in the route, not in the seam.

### Bounded goal (this lane)

**Step 1 — single loopback request (REQUIRED):**
- Issue one request from `127.0.0.1:4350` against the isolated-free path
  (the seam rewrites `apiUrl` to `127.0.0.1:4350` automatically). Use the
  same prompt shape as the existing isolated-free test or direct-free
  request script. Capture every event into `loopback-job.json` with:
  request_id, prompt, request URL, response shape, all
  `mycelium.request_event.v2` lifecycle events, status, any error, and
  **whether any non-empty `output_text` or `output_token_ids` is
  returned**.
- Use `curl` or the existing direct-free-request script; do not write a
  new client. Pass `--max-new-tokens 1` to keep the blast radius small.

**Step 2 — observation report (REQUIRED):**
- Produce `findings.md` with:
  - the exact request URL and command run;
  - whether `output_text` is empty / non-empty / absent;
  - whether the failure mode is identical to L2's (prefill → timeout) —
    this is the cross-lane triangulation parent needs;
  - whether `isolatedFree:true` was visible to the request handler at
    runtime (not just in `/config.json`);
  - any log lines from the free-app log that name this request_id.

**Do NOT retry.** One request only. Stop after Step 2.

### Verification contract (return these exact items)

```
(a) absolute artifact path(s):
    loopback-job.json
    findings.md
(b) exact command(s) run + exit codes
(c) SHA-256 of any captured manifest / log
(d) one-line "what changed / what didn't"
```

### Hard boundaries

- **Do not pay.** This is the isolated-free path.
- **Do not edit** any `composition/` source. Read-only on the workbench.
- **Do not restart** any launchd label.
- **Do not touch PID 96764.**
- **Do not touch Mycelium A / B / C sessions.**
- No git commit, push, or PR.
- No key material in evidence files.

### Out of scope

- G01 paid retry (L2's lane).
- T2 image build (L1's lane, depends on Docker).
- A13 integration (a separate lane).
- TEE deploy (a separate lane).

### Outcome (public-safe summary)

After the L2 serve-stack restart, the loopback isolated-free seam
produced real tokens. `output_text: 'A'` (the model continued
"A garden grows" with "A"), `output_token_id_count: 1`, peer counters
moved (node-0 +10 ops, node-2 +10 ops), `isolatedFree: true` visible at
runtime, `route_alive: true`. The new driver uses the
**submit-response stream_path** instead of polling, avoiding the
upstream `session()` gate's 401.

---

## Notes on what is omitted from this public mirror

- The full source-of-truth file list in each brief (e.g. direct paths
  into `<workbench>/artifacts/w6-v2/ot1-g01/...`) is replaced with
  descriptive references so a reader can follow the substance without
  learning the operator's working-tree layout.
- The exact Docker / launchctl PID values in the original briefs are
  intentionally omitted; the briefs' substance and verification contract
  do not depend on them.
- The lane briefs were the *minimum* prompts required to produce the
  submission floor evidence; other Wave 6 lane briefs (x1, g1-deploy,
  ot2-console, demo, abi-reconcile, h3-cutover, etc.) followed the same
  shape but their prompts do not appear in this mirror. Their summaries
  are inside `evidence/SUBMISSION-REPORT.md` instead.