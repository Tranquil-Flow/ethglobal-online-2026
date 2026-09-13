# W6 TEE verifier worker

Deployable per-request verifier for the Mycelium W6 paid app that implements the
**client bridge's exact HTTP contract** (`composition/w6-verifier-bridge.mjs`)
and runs a **real ensemble target-vs-rest statistical test** over submitted
outputs. Python standard library only — no third-party dependencies.

> **HONEST BOUNDARY.** This worker performs real (non-TEE) verification math and
> claims **no TEE guarantees**: every response carries
> `evidenceClass: "worker-unattested"`, and `GET /attestation` is an honest
> passthrough/501 stub that documents what real attestation must add. It also
> runs no ML model; reference outputs come from a pinned reference bank (or
> inline request extension). It is **not wired into the running demo app** —
> activating it is a driver-owned action (see
> `docs/handoffs/w6-tee-verifier-worker.md`).

## Files

| File | Purpose |
|---|---|
| `tee_verifier_worker.py` | HTTP server: bridge wire protocol, ops, bounded in-memory ledgers, TLS, CLI |
| `tee_verifier_math.py` | Pure deterministic math: digests, exact binomial tails, ensemble decision rule |
| `test_verification_math.py` | Unit tests (stdlib `unittest`, 31 tests, deterministic vectors) |
| `smoke.sh` | curl smoke script: starts a real worker and exercises the contract end to end |
| `fixtures/reference-bank.example.json` | Synthetic reference bank used by `smoke.sh` and the integration test |
| `fixtures/test-profiles.json` | Synthetic profile map for the integration test |
| `../../composition/test/tee-verifier-worker.test.mjs` | Integration test: the **real bridge** over real TLS against this worker |

## Routes

| Route | Method | Behavior |
|---|---|---|
| `/v1/stdio` | POST | The bridge protocol endpoint: Bearer auth, `application/json`, single-line canonical JSON frame → `{"version":1,"ok":true,"result":…}` or `{"version":1,"ok":false,"error":"…"}` (exact keys) |
| `/healthz` | GET | 200 liveness + pinned config summary (no secrets) |
| `/attestation` | GET | Passthrough to `W6_TEE_VERIFIER_ATTESTATION_URL`; otherwise 501 with the honest list of what real attestation must add |
| anything else | any | 404 `{"ok":false,"reason":"not-found"}` |

Ops on `/v1/stdio`: `observe` (the verification), `audits`, `scores`, `run`
(returns `[]` — verification is synchronous, there is no queue), `observation`,
`audit`, `close`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `W6_TEE_VERIFIER_HOST` | `127.0.0.1` | Bind host (`0.0.0.0` in a container) |
| `W6_TEE_VERIFIER_PORT` | `8443` | Bind port (`0` = ephemeral, printed on stdout) |
| `W6_TEE_VERIFIER_BEARER` / `W6_TEE_VERIFIER_BEARER_FILE` | — | **Required.** Must equal the client's `W6_VERIFIER_TEE_BEARER` |
| `W6_TEE_VERIFIER_TLS_CERT` + `W6_TEE_VERIFIER_TLS_KEY` | — | PEM pair; required unless plaintext is explicitly allowed |
| `W6_TEE_VERIFIER_ALLOW_PLAINTEXT` | — | `1` = loopback-only plaintext (smoke tests only; the client bridge rejects `http://`) |
| `W6_TEE_VERIFIER_REFERENCE_BANK` | — | Pinned reference bank JSON (see below); absent ⇒ every observe is honestly `inconclusive / no-reference-ensemble` |
| `W6_TEE_VERIFIER_ATTESTATION_URL` | — | Optional passthrough target for `/attestation` |
| `W6_TEE_VERIFIER_ALPHA` | `0.05` | Significance level of the divergence test |
| `W6_TEE_VERIFIER_AGREEMENT_FLOOR` | `0.6` | `k/n` floor for a positive `match` |
| `W6_TEE_VERIFIER_MIN_MEMBERS` | `3` | Minimum reference ensemble size |
| `W6_TEE_VERIFIER_CHANCE_FLOOR` | `0.0` | Optional lower bound on the null rate `p0` |

Precedence for test parameters: built-in defaults < bank `agreement` block < env.

## Reference bank

```json
{
  "version": 1,
  "bank_id": "example-bank-1",
  "agreement": { "alpha": 0.05, "agreement_floor": 0.6, "min_members": 3, "chance_floor": 0.0 },
  "entries": {
    "<request_digest_hex>": {
      "profile_sha256": "<64hex>" | null,
      "reference_outputs": [
        { "member": "ref-0", "output_text": "..." },
        { "member": "ref-1", "output_digest": "<64hex>" }
      ]
    }
  }
}
```

`request_digest` = sha256 of the canonical observation identity
(`{version, kind, request_id, provider_id, profile_sha256}`). Build keys with:

```sh
python3 tee_verifier_worker.py request-digest \
  --request-id R --provider-id P --profile-sha256 S
python3 tee_verifier_worker.py output-digest --text "reference output"
```

## Run + verify

```sh
# local rehearsal (loopback plaintext; never for deployment)
W6_TEE_VERIFIER_HOST=127.0.0.1 W6_TEE_VERIFIER_PORT=0 \
W6_TEE_VERIFIER_ALLOW_PLAINTEXT=1 W6_TEE_VERIFIER_BEARER=synthetic-dev-bearer \
W6_TEE_VERIFIER_REFERENCE_BANK=fixtures/reference-bank.example.json \
python3 -I -B tee_verifier_worker.py serve

# TLS (what the bridge requires)
W6_TEE_VERIFIER_HOST=0.0.0.0 W6_TEE_VERIFIER_PORT=8443 \
W6_TEE_VERIFIER_BEARER_FILE=/run/secrets/w6-verifier-bearer \
W6_TEE_VERIFIER_TLS_CERT=/run/secrets/tls.crt W6_TEE_VERIFIER_TLS_KEY=/run/secrets/tls.key \
W6_TEE_VERIFIER_REFERENCE_BANK=/opt/mycelium/reference-bank.json \
python3 -I -B tee_verifier_worker.py serve
```

Tests (all hermetic; run from the workbench root):

```sh
cd composition/tee-verifier-worker
env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  /opt/homebrew/bin/python3.14 -I -B test_verification_math.py -v
env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  PYTHON=/opt/homebrew/bin/python3.14 bash smoke.sh
cd ../..
PYTHON=/opt/homebrew/bin/python3.14 node --test composition/test/tee-verifier-worker.test.mjs
```

## The verification math in one paragraph

For each observation the worker computes the request digest, the output digest,
and resolves the reference ensemble (inline `reference_outputs` extension first,
then the reference bank keyed by request digest). With `n` references, `k` of
which agree with the target output and `m` the size of the largest agreeing
group among references, it forms `p0 = max((m+1)/(n+2), chance_floor)` (a
Laplace-smoothed estimate of rest-of-ensemble agreement) and computes exact
one-sided binomial tails `pLower = P(X ≤ k)`, `pUpper = P(X ≥ k)` for
`X ~ Binomial(n, p0)` in rational arithmetic. Decision: `pLower < alpha` ⇒
`mismatch` (divergence); else `k/n ≥ agreement_floor` ⇒ `match`; else
`inconclusive`. `n = 0` ⇒ `inconclusive / no-reference-ensemble`; `n <
min_members` ⇒ `inconclusive / insufficient-ensemble`. Every statistic is
returned in the receipt (`evidence` block) including exact rational strings, and
the computation is fully deterministic (unit-tested). A `mismatch` also creates
one bounded, explicitly labelled audit record returned via `audit_ids` / the
`audits` op.
