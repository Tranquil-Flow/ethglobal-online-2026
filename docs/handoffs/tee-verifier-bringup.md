# TEE Verifier Bring-up — Evidence-Backed Investigation

**Date:** 2026-09-13
**Author:** investigation subagent (read-only; no source edits, no remote actions)
**Scope:** determine what must run for REAL TEE-backed per-inference-request verification
via the workbench's `w6-verifier-bridge.mjs`, and whether it is reachable today.

Every claim is tagged **VERIFIED** (with the command and exact source location) or
**INFERRED** (with the reasoning chain). No secrets are reproduced.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Does `34.7.61.130` already expose the bridge's `/v1/stdio` endpoint? | **No.** Neither 8765 nor 8766 returns anything but `404` for `/v1/stdio`, `/verify`, `/attest`, `/infer`, etc. — verified just now. |
| Does `34.7.61.130:8765` expose anything the bridge can call? | **No.** `/healthz` and `/info` only — the running image is plain Flask T2. |
| Does `34.7.61.130:8766` expose anything useful for TEE plumbing? | **Partially.** `/healthz`, `/generate-key` (POST), `/attestation` (GET, returns JWT) are live — the workbench's `w6-tee-launcher/tee_launcher.py` image is in fact deployed there. **But** the bridge itself never reads `/attestation` or `/generate-key`; it only calls `/v1/stdio`. |
| Is SSH to `34.7.61.130` available from this Mac? | **No.** Port 22 is reachable, but no matching key/alias in `~/.ssh/config` and `BatchMode` SSH returned `Permission denied (publickey)` (verified). |
| Can real TEE-backed per-inference verification be brought up right now? | **No, not without owner action.** Two distinct gaps: (1) no `/v1/stdio` worker reachable, and (2) no HTTPS origin the bridge's `HttpsTransport` will accept. The bridge rejects anything that is not `https://` with no userinfo / query / hash (verified). |
| What is the smallest honest path? | Three layered options below — pick one based on which gates the owner will accept. None of them is "free" today. |
| What may the UI honestly claim today? | **YELLOW on TEE attestation**, **RED on per-request TEE-backed verification**. The SEV kernel proof on the VM is real (verified in `artifacts/w6-v2/l4/deploy-summary.md`) but it is NOT a TEE-backed per-inference attestation. |

---

## 1. The exact transport contract the bridge expects

### 1.1 Mode selection (env-driven)

`composition/w6-verifier-bridge.mjs:424-444`

```js
export function createVerifierBridge({
  env = process.env,
  localCommand,
  teeUrl = env.W6_VERIFIER_TEE_URL,          // line 427
  teeBearer = env.W6_VERIFIER_TEE_BEARER,    // line 428
  profilesFile = DEFAULT_PROFILES_FILE,
  stateDir = env.W6_APP_STATE_DIR,
  timeoutMs = Number(env.W6_VERIFIER_TIMEOUT_MS ?? 10_000),  // line 431
  fetchImpl = globalThis.fetch,
  stakeGate,
} = {}) {
  ...
  const mode = teeUrl ? "tee-attested" : "local";            // line 438
  const transport = teeUrl
    ? new HttpsTransport(teeUrl, teeBearer, timeoutMs, fetchImpl)     // line 440
    : new LocalJsonlTransport(
        localCommand ?? env.W6_VERIFIER_LOCAL_CMD,            // line 442
        timeoutMs,
      );
```

VERIFIED: the bridge has **exactly two transport modes**:

- **`mode = "tee-attested"`** if `W6_VERIFIER_TEE_URL` is set → `HttpsTransport` (HTTPS only).
- **`mode = "local"`** otherwise → `LocalJsonlTransport` (spawns a subprocess that speaks
  line-delimited JSON over stdio).

The "local" mode requires a separate subprocess that **already implements the wire
protocol** (`{version, ok, result|error}` envelopes). The only one shipped in-tree is
the test fixture `composition/test/fixtures/w6-fake-verifier-worker.py` (21 lines,
returns `{op, sequence}` — VERIFIED by reading it).

### 1.2 HttpsTransport constraints (the ones that matter)

`composition/w6-verifier-bridge.mjs:245-271`

```js
class HttpsTransport {
  constructor(baseUrl, bearer, timeoutMs, fetchImpl) {
    let url;
    try { url = new URL(baseUrl); }
    catch { fail("INVALID_VERIFIER_TEE_URL"); }
    if (
      url.protocol !== "https:" ||       // HTTPS only
      url.username ||                     // no userinfo
      url.password ||                     // no password
      url.search ||                       // no query string
      url.hash                            // no fragment
    )
      fail("INVALID_VERIFIER_TEE_URL");
    if (typeof bearer !== "string" || !bearer || bearer.length > 8192)
      fail("VERIFIER_TEE_BEARER_REQUIRED");
    this.endpoint = new URL(
      "v1/stdio",                                            // path is appended
      url.href.endsWith("/") ? url : url.href + "/",
    );
    ...
```

VERIFIED:

- **Scheme MUST be `https://`** — plain `http://` is refused.
- **No `user:pass@`** in the URL.
- **No `?query` and no `#hash`** allowed.
- **A bearer token is REQUIRED** (`W6_VERIFIER_TEE_BEARER`, 1–8192 chars).
- The endpoint is **always `<base>/v1/stdio`**, regardless of what is exposed on the
  target.

### 1.3 The wire protocol

`composition/w6-verifier-bridge.mjs:67-91, 245-315, 605-617`

- Every request frame is `canonicalBytes({...})` (sorted-key JSON, UTF-8, ≤ 2 MiB).
- The bridge POSTs each frame as a **single JSON line** with:
  - `method: "POST"` (line 291)
  - `headers: { authorization: "Bearer <token>", content-type: "application/json", accept: "application/json" }`
    (lines 292-296)
  - `body: <bytes>` (line 297)
  - `redirect: "error"` (line 299) — a redirect to anywhere is treated as a failure.
- The reply is parsed by `parseReply()` (lines 67-91). Accepted shape:
  ```json
  {"version": 1, "ok": true,  "result": <op-specific>}
  {"version": 1, "ok": false, "error": "<reason>"}
  ```
  Any other shape → `VERIFIER_INVALID_REPLY` or `VERIFIER_VERSION_MISMATCH`.

### 1.4 Operations the bridge sends

`composition/w6-verifier-bridge.mjs:605-617` (the public surface):

| Op | When | Body shape (inferred from `run` / `processScores` / `getObservation` / `getAudit` / `listAudits`) |
|---|---|---|
| `audits` | `start()` (line 155) and `listAudits()` | `{version:1, op:"audits"}` |
| `close` | graceful shutdown of LocalJsonl | `{version:1, op:"close"}` |
| `observe` | `observeCompleted()` (lines 540-545) | `{version:1, op:"observe", response:{...}}` |
| `scores` | `processScores()` | `{version:1, op:"scores"}` |
| `run` | `runPending()` | `{version:1, op:"run"}` |
| `observation` | `getObservation(id)` | `{version:1, op:"observation", request_id:"…"}` |
| `audit` | `getAudit(id)` | `{version:1, op:"audit", audit_id:"…"}` |

The `observe` response payload is built by `normalizeObservation()` (lines 391-416):
```json
{
  "version": 1,
  "request_id": "<id>",
  "provider_id": "<id>",
  "profile_sha256": "<sha>",
  "response_text": "<text>",
  "kind": "ordinary"
}
```
with the constraints:
- `request_id` and `provider_id` MUST match `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/`
  (IDENTIFIER, line 25).
- `response_text` MUST be a well-formed UTF-8 string ≤ 1 MiB.
- `kind` MUST be exactly `"ordinary"` — anything else throws `AUDIT_RECURSION_REFUSED`.

### 1.5 What the verifier side must answer

The reply envelope is dictated by the contract — `w6-verifier-serve.mjs` returns
worker JSON byte-for-byte without the JSONL newline (verified by
`composition/test/w6-verifier-serve.test.mjs:139-163`), and the bridge's
`parseReply()` accepts only this envelope (`w6-verifier-bridge.mjs:67-91`):

```json
{"version":1,"ok":true,"result":<op-specific>}
```

For `op:"observe"`, the **bridge itself** validates the `result` as an observation
receipt (`w6-verifier-bridge.mjs:546-553`):

```json
{
  "version": 1,
  "request_id": "<echo>",
  "provider_id": "<echo>",
  "random_selected": false,
  "audit_ids": []
}
```

`random_selected` may be either boolean value; `audit_ids` must be an array; and
`request_id` / `provider_id` must echo the request. Any other shape triggers
`VERIFIER_INVALID_OBSERVATION_RECEIPT`.

---

## 2. What the deployed TEE actually exposes — VERIFIED

Re-probed `34.7.61.130` from this Mac at the moment of this investigation.

| URL | Response | Verified by |
|---|---|---|
| `http://34.7.61.130:8765/healthz` | `200 {"state":"running","status":"ok"}` | `curl` |
| `http://34.7.61.130:8765/info` | `200` JSON: `bundle_sha256:e5e5e7f8…`, `image_tag:"mycelium-verifier:local-t2"`, `expected_sha256:133962e…`, `expected_cpu_sha256:98a78cd…`, `base_model_root:/opt/mycelium/base-roberta`, `bundle_root:/opt/mycelium/bundle`, `python:3.11.16`, `test_rows_sha256:a067f657…`, `image_digest:""` (empty) | `curl` |
| `http://34.7.61.130:8765/qualify` (GET or POST) | **timeout (no response)** — endpoint not implemented in the running image | `curl -m 4` |
| `http://34.7.61.130:8765/{v1/stdio, v1/verify, verify, attest, v1/attest, infer, v1/infer, status, metrics, docs, openapi.json, v1/observe}` | **404** for every path | `curl` (one-line loop) |
| `http://34.7.61.130:8766/healthz` | `200` JSON: `{hwmodel:"AMD_MILAN", key_generated:true, state:"running", status:"ok", swname:"CONFIDENTIAL_SPACE", tee_port:8766}` | `curl` |
| `http://34.7.61.130:8766/attestation` | `200 text/plain` — a JWT signed with HS256; decoded payload: `iss:"tee-launcher"`, `aud:"mycelium-verifier"`, `swname:"CONFIDENTIAL_SPACE"`, `dbgstat:"disabled-since-boot"`, `hwmodel:"AMD_MILAN"`, `image_digest:"sha256:47137b38ddd2029c3a24252c4edc8e559cf103f3bf75befd8832eba70ba1ade0"`, `image_tag:"europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier:tee-shim-v1-1789264808"`, `pubkey:"25af2130b562a4f08176938d315b261c96957b7c4fdcb5a96ef52546d2ce33de"`, `eat_nonce:"<hex>"`, `iat`, `exp` | `curl` |
| `http://34.7.61.130:8766/generate-key` (POST) | `409 {"createdAt":"…","error":"key_already_exists","pubkey":"25af2130…"}` — key was already generated earlier (idempotent) | `curl -X POST` |
| `http://34.7.61.130:8766/info` | `404 {"error":"not_found","path":"/info"}` | `curl` |
| `http://34.7.61.130:8766/{v1/stdio, v1/verify, verify, attest, v1/attest, infer, v1/infer, status, metrics, docs, openapi.json, v1/observe}` | **404** for every path | `curl` |

INFERRED but supported by the artifacts:

- **Port 8765** is the upstream T2 verifier image (`europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier@sha256:35fec927…`,
  see `artifacts/w6-v2/l4/deploy-summary.md:13,30-32,75`). It is plain Flask with
  `/healthz` and `/info` only; it does NOT expose `/v1/stdio` or `/qualify`. Its
  `/info.image_digest` is empty (`""`) — VERIFIED — meaning the running image does
  not self-report its digest either.
- **Port 8766** is the workbench's `w6-tee-launcher/tee_launcher.py` shim, layered on
  top of the T2 image. The Dockerfile
  (`composition/w6-tee-launcher/Dockerfile:16`) layers it on top of
  `…/verifier@sha256:35fec927…`, but the live `/attestation` reports
  `image_digest:"sha256:47137b38…"` — i.e. someone rebuilt the shim and re-pushed
  with a different digest, and the live image now is `tee-shim-v1-1789264808`. The
  shim does **not** speak `/v1/stdio`.
- **Crucially:** the TEE-shim's `tee_launcher.py` (read fully, lines 386-455) only
  serves `/healthz`, `/attestation`, `/generate-key`, and 404s everything else. **It
  does not proxy or re-expose the upstream Flask verifier on the same path.** The
  two ports are independent: 8765 = the T2 classifier, 8766 = the tee-launcher JWT
  shim.

### What the deploy artifacts already say (cross-check)

`artifacts/w6-v2/l4/deploy-summary.md` (final state) explicitly states:

> `/attestation` on `http://34.7.61.130:8765` → 404 (T6 plumbing not implemented in
> current verifier image)
> `/generate-key` → 404
> TEE attestation JWT → **NO** — Not produced — VM is plain cos-stable, image is
> plain Flask, not tee-launcher

`artifacts/w6-v2/_commit-prep/03-l4-tee-deploy.md:36` adds: "TEE attestation JWT —
NOT produced; image is plain Flask, not tee-launcher" and `:39` "T6 tee-launcher
plumbing — separate lane."

**However**, the live probe above shows that **as of this moment, port 8766 IS
serving the tee-launcher JWT** — i.e. the T6 plumbing has since landed on a sibling
image but has NOT been promoted into the 8765 Flask image. That distinction matters
for the bring-up recipe (see §4).

---

## 3. Why this matters — verdict production today

`composition/w6-verifier-bridge.mjs:540-571` (the only place `observe` is invoked)
and `composition/w6-paid-observation-bridge.mjs:39-107` (the gatekeeper) and
`composition/w6-verifier-ensemble.mjs:96-131` (the ensemble runner) together make
clear what a "real verifier call" would look like:

1. **Paid app picks up a successful job** via
   `w6-paid-observation-bridge.mjs:55-101` (`enqueueCompletedJob`).
2. **If `W6_VERIFIER_TEE_URL` or `W6_VERIFIER_LOCAL_CMD` is set**, it builds the
   real bridge (`w6-paid-observation-bridge.mjs:40-42`):
   ```js
   if (env.W6_VERIFIER_TEE_URL || env.W6_VERIFIER_LOCAL_CMD) {
     return createVerifierBridge({ env, stateDir });
   }
   ```
   Otherwise it falls into the `observation-only-assessment-unavailable` branch
   (line 53 onwards), which writes a JSONL record with `assessment: "unavailable"`
   and — only if `W12_DEMO_VERIFIER === "1"` — runs `classifyDemoOutput()` (lines
   26-31) which returns `"mismatch"` if the response text contains the literal
   string `demo attacker` (case-insensitive), otherwise `"match"`. The honest
   verdict string returned to the caller is `verifier-transport-not-configured`
   (line 98).
3. **In the real-bridge branch**, the call goes
   `verifierBridge.observeCompleted(...)` →
   `request({op:"observe", response:{…}})` (lines 540-545) → over the configured
   transport to `/v1/stdio` on the TEE, or to the local JSONL subprocess.
4. **The ensemble** (`w6-verifier-ensemble.mjs:96-131`) by default re-runs
   `verifierBridge.observeCompleted` 3 times and tallies votes — comments at
   lines 100-104 are explicit: "Real verifier TEE returns deterministic receipts
   given identical input, so this surfaces transport-level disagreement only —
   enough to wire the contract until a model-trained scorer ships." So even when
   the transport IS configured, the "model-specific trained ensemble" is **not
   yet implemented** — only deterministic re-runs of the same `observe` op.

VERIFIED: today (this Mac, this session), neither `W6_VERIFIER_TEE_URL` nor
`W6_VERIFIER_LOCAL_CMD` is set in `~/.config/mycelium/w6-supervisors.env` — that
file contains no `tee`/`verifier`/`TEE_VERIFIER*` entries (verified by grep).
The paid-app `now.mycelium.paid-app` is launched with
`W6_SUPERVISOR_ENV_FILE=/Users/evinova-self/.config/mycelium/w6-supervisors.env`
(launchctl print, pid 86972, state=running — verified). So every completed
job currently lands in the `observation-only-assessment-unavailable` branch —
the verdict is **never anything but `unavailable`** unless `W12_DEMO_VERIFIER=1`
is set.

The placeholder supervisor `composition/w6-supervisors/now.mycelium.local-verifier.plist`
is `Disabled=true` and runs `/usr/bin/false` (verified by reading the plist).
Its README at `composition/w6-supervisors/README.md:79` explicitly says: "Do
not bootstrap the route27b or local-verifier placeholders. Enabling either
requires replacing its placeholder command, removing `Disabled=true`,
validating its own private environment, and passing its workstream gate first."

---

## 4. The smallest honest paths to REAL TEE-backed per-inference verification

Three layered options, in order of fidelity. **None can be brought up unilaterally
by a subagent today** — each one needs at least one owner action or owner-gated
artifact.

### 4.1 Option A — Serve the workbench's own `w6-verifier-serve.mjs` HTTPS front locally, in front of the live 8765 Flask

**What it gives you:** the bridge's `HttpsTransport` mode goes live and every
successful paid-app job produces a real verifier receipt (even if the inner
classifier is the same plain Flask already at 8765 — the wire contract is now
honestly bridged end-to-end).

**What it does NOT give you:** TEE attestation. The HTTPS origin is your laptop;
TLS terminates in user space; the bearer is whatever you set. The UI must keep
calling the posture "HTTPS-fronted local verifier, no TEE attestation" — not
"verifier.mycelium.now" or "Confidential Space".

**Files / commands** (workbench-only — no remote actions, no infra):

1. The HTTPS server exists already at
   `composition/w6-verifier-serve.mjs:443-470`. Its `main()` reads
   `W6_VERIFIER_TLS_CERT`, `W6_VERIFIER_TLS_KEY`, `W6_VERIFIER_BEARER`, and
   `W6_VERIFIER_PORT` from env. The default worker command
   (`defaultWorkerCommand`, lines 96-112) is:
   ```text
   python3 -I -B -m mycelium_verifier stdio --config "$VERIFIER_CONFIG"
   ```
   There is no `mycelium_verifier` Python module on this Mac
   (`find /Users/evinova-self/Documents/playground/mycelium-wave8-integration
   -name "mycelium_verifier*" -type d` returned nothing — VERIFIED). The
   workbench tests pass a fake Python worker via the `workerCommand` override
   (`composition/test/w6-verifier-serve.test.mjs:59`).
2. Generate a self-signed cert (the workbench test already does this in
   `w6-verifier-serve.test.mjs:25-46`):
   ```sh
   cd /Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench
   openssl req -new -x509 -keyout /tmp/tee-tls.key -out /tmp/tee-tls.crt \
     -days 1 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
   ```
3. Choose a bearer and run:
   ```sh
   cd /Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench
   W6_VERIFIER_TLS_KEY=/tmp/tee-tls.key \
   W6_VERIFIER_TLS_CERT=/tmp/tee-tls.crt \
   W6_VERIFIER_BEARER="$(openssl rand -hex 32)" \
   W6_VERIFIER_HOST=127.0.0.1 \
   W6_VERIFIER_PORT=8443 \
   WORKER_COMMAND_OVERRIDE_NOTE='real worker required' \
   node composition/w6-verifier-serve.mjs
   ```
   **The blocking sub-question** is what `workerCommand` to pass: the bridge
   requires the worker to handle `op:"observe"` and return a receipt that
   satisfies `w6-verifier-bridge.mjs:546-553`. The shipped test fixture
   (`composition/test/fixtures/w6-fake-verifier-worker.py`) only echoes the
   request back — it does NOT build a `random_selected` boolean or an
   `audit_ids` array. Therefore this option needs **a real worker**. The honest
   minimum is a thin Python wrapper around the live `:8765` Flask classifier
   that:
     - accepts `{op:"observe", response:{...}}`,
     - POSTs `/qualify` (or whatever the upstream Flask accepts — currently
       `/qualify` times out, so this option may need to wrap a different
       endpoint or even shell out to a Python call against the published
       `mycelium_verifier` wheel),
     - decides `random_selected` and produces an `audit_ids` array,
     - returns `{version:1, ok:true, result:{version:1, request_id, provider_id,
       random_selected, audit_ids:[…]}}`.
   The owner of the private `mycelium_verifier` wheel is the only one who can
   confirm this wrapper's contract. **No worker exists in the workbench today.**
4. Add to `~/.config/mycelium/w6-supervisors.env` (mode 0600):
   ```sh
   W6_VERIFIER_TEE_URL=https://127.0.0.1:8443
   W6_VERIFIER_TEE_BEARER=<value from step 3>
   W6_VERIFIER_TIMEOUT_MS=10000
   ```
5. Restart `now.mycelium.paid-app` (`launchctl kickstart -k gui/$(id -u)/now.mycelium.paid-app`)
   so it picks up the new env.

**Cost:** ~30 lines of new Python (worker shim) + 5 lines of config + 1 restart.
**Honest verdict the UI may show:** "TEE-HTTPS front live on 127.0.0.1:8443; inner
classifier is the same T2 plain-Flask at `34.7.61.130:8765`; no nonce-bound
attestation; bridge contract honoured end-to-end."

### 4.2 Option B — Promote the live tee-shim into the `tee-attested` HTTPS origin

**What it gives you:** the live `:8766` IS the tee-shim that already produces a
JWT with `image_digest`, `pubkey`, `eat_nonce`, `swname:"CONFIDENTIAL_SPACE"`,
`dbgstat:"disabled-since-boot"`, `hwmodel:"AMD_MILAN"`. If that shim ALSO spoke
`/v1/stdio`, the bridge would have a real TEE-backed transport in
`tee-attested` mode.

**What it does NOT give you today:** `/v1/stdio` on the shim (404 — VERIFIED),
and **the URL is `http://`, not `https://`** (the bridge's `HttpsTransport`
rejects plain HTTP — see §1.2).

**Required changes** (all are owner-gated, none can be done by a subagent):

1. **Owner decision:** extend `tee_launcher.py` to:
   - accept `POST /v1/stdio` (currently 404),
   - spawn the upstream `verifier_server.py` as a child process (already in the
     same image via `entrypoint.sh`),
   - forward the JSONL frame over the child's stdin and reply with the
     child's stdout, **exactly** as `w6-verifier-serve.mjs:164-243` does,
   - reuse the existing `pubkey` and include `image_digest` /
     `eat_nonce` / `swname` / `dbgstat` in the response metadata if the
     caller asks for it.
   This is small (≈ 80 lines) but the owner must decide whether to modify
   `tee_launcher.py` (a workbench file in this same repo) — see §6 for
   constraints.
2. **Owner decision:** put a TLS terminator in front of `:8766` (the bridge
   requires `https://`). The two clean options are:
     - re-publish the tee-shim image with `w6-verifier-serve.mjs` layered on
       top (mirrors `composition/w6-verifier-tee/Dockerfile:43` but for the
       tee-shim base), or
     - add an HTTPS ingress via Cloudflare `verifier.mycelium.now` → the
       tunnel already in front of the VM (`artifacts/w6-v2/h3-cloudflared/`
       documents the tunnel plumbing; the DNS record was deliberately NOT
       added in `artifacts/w6-v2/h3-cloudflared/build-summary.md:9`).
3. **Owner action:** set the env vars on the paid app
   (`~/.config/mycelium/w6-supervisors.env`):
   ```sh
   W6_VERIFIER_TEE_URL=https://<new-https-origin>
   W6_VERIFIER_TEE_BEARER=<shared-secret>
   ```
   and restart `now.mycelium.paid-app`.

**Cost:** a code edit in `composition/w6-tee-launcher/tee_launcher.py` (or a
new sibling file), a re-push of the image, a re-deploy of the VM (or new
tunnel config), a config edit, a restart.
**Honest verdict the UI may show:** "TEE tee-launcher with /v1/stdio, HTTPS
origin verified via Cloudflare tunnel; JWT claims: image_digest, pubkey,
swname=CONFIDENTIAL_SPACE, dbgstat=disabled-since-boot, hwmodel=AMD_MILAN.
Non-cryptographic verifier classifier inside (same T2 Flask)."

### 4.3 Option C — Re-deploy the workbench's intended TEE image (`w6-verifier-tee`)

**What it gives you:** the contract that `composition/w6-verifier-tee/README.md`
already documents — Node 22 HTTPS server wrapping the accepted
`mycelium_verifier` JSONL worker, with bearer auth, `/v1/stdio`, `/attestation`
proxy (when `W6_ATTESTATION_URL` is configured), and the exact env vars the
bridge expects.

**What is required** (verbatim from `README.md:24-49`, lines 53-92):

1. The owner must possess `MYCELIUM_VERIFIER_ARCHIVE` — the **private tar.gz of
   the `mycelium_verifier` wheel + banks** — and run the build from the workbench
   root:
   ```sh
   set -eu
   export CLOUDSDK_ACTIVE_CONFIG_NAME=mycelium
   ARCHIVE="${MYCELIUM_VERIFIER_ARCHIVE:?set MYCELIUM_VERIFIER_ARCHIVE to the accepted private tar.gz}"
   TAG=europe-west4-docker.pkg.dev/mycelium-demo/mycelium/verifier:tee-r1
   STAGE="$(mktemp -d)"
   trap 'rm -rf "$STAGE"' EXIT
   mkdir -p "$STAGE/component"
   tar -xzf "$ARCHIVE" -C "$STAGE/component"
   install -m 0644 composition/w6-verifier-serve.mjs "$STAGE/w6-verifier-serve.mjs"
   docker buildx build \
     --platform linux/amd64 \
     --build-context verifier-payload="$STAGE" \
     --file composition/w6-verifier-tee/Dockerfile \
     --tag "$TAG" \
     --load \
     composition/w6-verifier-tee
   ...
   docker push "$TAG"
   ```
2. The owner creates the Confidential Space VM
   (`composition/w6-verifier-tee/README.md:53-92`) and obtains the static IP
   and bearer.
3. **T3** (an explicit follow-up owner task) must then wire DNS, restrict
   ingress to Cloudflare, map public HTTPS to container port 8443, set
   `W6_ATTESTATION_URL`, and verify the JWT claims match the image digest
   (per the same README, lines 94).
4. Only then does the paid app get
   `W6_VERIFIER_TEE_URL=https://verifier.mycelium.now` and
   `W6_VERIFIER_TEE_BEARER=<bearer>` set, and `now.mycelium.paid-app` is
   restarted.

**Cost:** the full Confidential Space redeploy described in
`composition/w6-verifier-tee/README.md`. The README itself flags "Do not run
these from an agent session. Run from the workbench root with owner approval."
**Honest verdict the UI may show:** "TEE-backed per-request verifier live at
`https://verifier.mycelium.now`; HTTPS + bearer + JWT claims verified;
non-cryptographic ensemble only (default runner is deterministic re-observation)."

### 4.4 What is NOT on the menu

- **No "honest YELLOW today" claim can be flipped to GREEN** by editing a
  config flag. The bridge will not switch to `tee-attested` mode without
  `W6_VERIFIER_TEE_URL`; the env is not set; the URL it would need to point
  to does not exist (HTTPS, `/v1/stdio`, reachable from this Mac).
- **`W12_DEMO_VERIFIER=1`** is the demo-only classifier that returns
  `mismatch` for the literal string `demo attacker` and `match` otherwise.
  This is **explicitly not TEE verification** — `w6-paid-observation-bridge.mjs:14-25`
  says: "W12 (demo-only) — classify a completed job's output… Used only when
  W12_DEMO_VERIFIER=1 and the real verifier bridge is unavailable; the
  malicious provider fixture always returns the literal string `demo attacker`,
  so any job whose output contains that substring is classified as a mismatch,
  which drives the suspicion counter in the public viewer. Production code
  paths ignore this helper entirely."

---

## 5. What the UI may honestly claim today

Read straight off the live system:

| Claim | Verdict | Why |
|---|---|---|
| "There is a verifier reachable at `34.7.61.130:8765`" | TRUE | `/healthz` returns 200 with `state:"running"`. |
| "That verifier is running inside an SEV-backed Confidential VM" | TRUE | `dmesg` recorded in `artifacts/w6-v2/l4/deploy-summary.md:13,60-61,75` confirms AMD SEV + secure boot; the deploy summary explicitly says "VM at 34.7.61.130:8765 healthy inside SEV-backed confidential VM". |
| "That verifier produces a TEE attestation JWT signed by a workload key generated inside the TEE" | FALSE | The live `:8765` Flask image has no `/attestation` endpoint (404 — VERIFIED). It does NOT generate or hold a key. The JWT you can fetch today comes from a separate container on `:8766`, which is the workbench's `tee_launcher.py` shim — its key is generated in process memory, signed with HS256 and an in-memory secret (read `tee_launcher.py:294-318`, comment at line 22-26 calls this out as "a demo with HS256 is fine for T6 wiring"). The HS256 secret is not TEE-bound. |
| "Per-inference requests are TEE-attested by the bridge" | FALSE | `W6_VERIFIER_TEE_URL` is not set; the paid app runs `observation-only-assessment-unavailable`; every successful job yields `assessment: "unavailable"`. |
| "Per-inference requests are classified by a model-specific trained ensemble" | FALSE | The default ensemble runner is a deterministic re-call of the same `observe` op, N times — `w6-verifier-ensemble.mjs:100-104` says it verbatim: "Real verifier TEE returns deterministic receipts given identical input, so this surfaces transport-level disagreement only — enough to wire the contract until a model-trained scorer ships." |
| "We have a tee-launcher with `/attestation` and `/generate-key`" | TRUE on `:8766` only | JWT is signed with HS256 in-process (demo secret), not a Google JWKS. |
| "The verifier image running at `:8765` is `sha256:47137b38…`" | FALSE | The live image reports `image_tag:"mycelium-verifier:local-t2"` and an **empty** `image_digest` field. The 47137b38… digest is for the tee-shim sibling at `:8766`, not the Flask image at `:8765`. The Flask image's known digest is `sha256:35fec927…` per `artifacts/w6-v2/l4/deploy-summary.md:13,75`. |

### Honest posture strings

- **For the verifier compute badge:** YELLOW ("SEV-backed VM at `34.7.61.130:8765`,
  `/healthz` 200; no `/attestation` on the Flask image; no `/v1/stdio` on either
  port; bridge in `observation-only-assessment-unavailable` mode").
- **For the tee-launcher badge:** YELLOW on `:8765` (no tee-launcher endpoints),
  but GREEN-able on `:8766` ONLY if the parent accepts the `tee-shim-v1` demo
  JWT (HS256, in-process secret, image_digest `sha256:47137b38…`) — this is
  what the demo-health probe already encodes
  (`composition/w6-demo-health/server.mjs:186-218`: teeFlaskProbe returns
  YELLOW with reason `"200 ok; plain Flask no /attestation (Y3)"`,
  teeLauncherProbe returns GREEN only if the response carries
  `key_generated`/`attestation`/`tee_port` and `swname`/`hwmodel` indicate
  SEV).
- **For "TEE-attested" anywhere:** NO. There is no nonce-bound, workload-key
  signed attestation reachable by the bridge today.

---

## 6. Hard-rule check (do not violate)

- **No secrets reproduced** — bearers, HS256 demo secrets, pubkey hex (the one
  above is already public via `/generate-key` on `:8766`, so it is OK to
  mention; nothing private was logged).
- **No edits to WB / LIVE / NATIVE** — this is investigation only.
- **No restart / kickstart / bootout / kill of launchd services** —
  `now.mycelium.paid-app`, `free-app`, `edge`, `tunnel`, and the local
  verifier placeholder were not touched.
- **No cron / persistent agents created.**
- **SSH was probed but not used** (`BatchMode` `Permission denied (publickey)`,
  no key installed, no escalation attempted).

---

## 7. One-line recommendation

**Do not claim "TEE-backed per-inference verification" anywhere until either**
(a) Option A ships — local HTTPS front with a real worker shim — for an
**honest "HTTPS-fronted local verifier"** posture; or (b) Option B/C ships —
the tee-shim gains `/v1/stdio` and a HTTPS origin. Today the only true TEE
claim is the SEV kernel proof on the VM at `:8765`; the per-inference
attestation and the per-inference ensemble are not in place.
