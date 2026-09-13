#!/usr/bin/env bash
# W6 TEE verifier worker — curl smoke script.
#
# Proves, against a real running worker process, that:
#   1. the worker serves the client bridge's EXACT observe request shape
#      (canonical single-line JSON frame, Bearer auth, application/json)
#      and answers HTTP 200 with the exact three-key reply envelope
#      {"version":1,"ok":true,"result":{...}} that
#      composition/w6-verifier-bridge.mjs:67-91 accepts;
#   2. the observe receipt echoes request_id/provider_id, carries the boolean
#      random_selected and array audit_ids (bridge validation, lines 546-553),
#      and carries the honest evidenceClass;
#   3. the ensemble statistical math yields match / mismatch / inconclusive for
#      bank-referenced, attacker, inline-reference and unreferenced requests;
#   4. a mismatch escalates to an audit record visible via op:"audits";
#   5. auth/routing/attestation-stub behavior is fail-closed and honest.
#
# Usage:
#   env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
#     PYTHON=/opt/homebrew/bin/python3.14 bash smoke.sh
#
# This binds only 127.0.0.1 with an ephemeral port and cleans up its own
# process. It never touches any live service.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
WORKER="${HERE}/tee_verifier_worker.py"
BANK="${HERE}/fixtures/reference-bank.example.json"
BEARER="synthetic-smoke-bearer"
PROVIDER="tee-worker-test-provider"
PROFILE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/w6-tee-worker-smoke.XXXXXX")"
STDOUT_LOG="${STATE_DIR}/worker.out"
STDERR_LOG="${STATE_DIR}/worker.err"
RESP="${STATE_DIR}/resp.json"
WORKER_PID=""

cleanup() {
  if [[ -n "${WORKER_PID}" ]] && kill -0 "${WORKER_PID}" 2>/dev/null; then
    kill "${WORKER_PID}" 2>/dev/null || true
    wait "${WORKER_PID}" 2>/dev/null || true
  fi
  rm -rf "${STATE_DIR}"
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "# starting worker (python=${PYTHON}, plaintext loopback, port 0, bank=${BANK##*/})"
env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  W6_TEE_VERIFIER_HOST=127.0.0.1 \
  W6_TEE_VERIFIER_PORT=0 \
  W6_TEE_VERIFIER_ALLOW_PLAINTEXT=1 \
  W6_TEE_VERIFIER_BEARER="${BEARER}" \
  W6_TEE_VERIFIER_REFERENCE_BANK="${BANK}" \
  "${PYTHON}" -I -B "${WORKER}" serve >"${STDOUT_LOG}" 2>"${STDERR_LOG}" &
WORKER_PID=$!

PORT=""
for _ in $(seq 1 100); do
  if [[ -s "${STDOUT_LOG}" ]]; then
    PORT="$("${PYTHON}" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["port"])' "${STDOUT_LOG}" 2>/dev/null || true)"
    [[ -n "${PORT}" ]] && break
  fi
  if ! kill -0 "${WORKER_PID}" 2>/dev/null; then
    cat "${STDERR_LOG}" >&2 || true
    fail "worker exited before reporting a listening port"
  fi
  sleep 0.1
done
[[ -n "${PORT}" ]] || fail "worker did not report a listening port"
echo "# worker listening on 127.0.0.1:${PORT}"

post() { # post <body> [bearer]
  local body="$1" bearer="${2:-${BEARER}}"
  curl -sS -m 10 -o "${RESP}" -w '%{http_code}' \
    -X POST "http://127.0.0.1:${PORT}/v1/stdio" \
    -H "Authorization: Bearer ${bearer}" \
    -H "Content-Type: application/json" \
    --data-binary "${body}"
}

assert_receipt() { # assert_receipt <label> <request_id> <verdict> <audit_count> <source>
  "${PYTHON}" -I - "${RESP}" "$@" <<'PY'
import json, sys
path, label, request_id, verdict, audit_count, source = sys.argv[1:7]
doc = json.load(open(path))
errs = []
if sorted(doc.keys()) != ["ok", "result", "version"]:
    errs.append(f"envelope keys are {sorted(doc.keys())}")
if doc.get("version") != 1 or doc.get("ok") is not True:
    errs.append("envelope is not {version:1, ok:true}")
result = doc.get("result", {})
if result.get("request_id") != request_id:
    errs.append(f"request_id echo {result.get('request_id')!r}")
if result.get("provider_id") != "tee-worker-test-provider":
    errs.append("provider_id echo")
if result.get("verdict") != verdict:
    errs.append(f"verdict {result.get('verdict')!r} != {verdict!r}")
if not isinstance(result.get("random_selected"), bool):
    errs.append("random_selected is not a boolean")
if not isinstance(result.get("audit_ids"), list) or len(result["audit_ids"]) != int(audit_count):
    errs.append(f"audit_ids {result.get('audit_ids')!r}")
if result.get("evidenceClass") != "worker-unattested":
    errs.append("evidenceClass missing/wrong")
if result.get("evidence", {}).get("referenceSource") != source:
    errs.append(f"referenceSource {result.get('evidence', {}).get('referenceSource')!r}")
if errs:
    print(f"SMOKE FAIL: {label}: {'; '.join(errs)}", file=sys.stderr)
    print(json.dumps(doc)[:2000], file=sys.stderr)
    sys.exit(1)
print(f"ok: {label} -> verdict={verdict}")
PY
}

# ---- 1. /healthz -----------------------------------------------------------
STATUS="$(curl -sS -m 5 -o "${RESP}" -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz")"
[[ "${STATUS}" == "200" ]] || fail "GET /healthz -> ${STATUS}"
"${PYTHON}" -I - "${RESP}" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["ok"] is True and doc["version"] == 1, doc
assert doc["evidenceClass"] == "worker-unattested", doc
assert doc["bank"]["loaded"] is True and doc["bank"]["entries"] == 4, doc
assert doc["attestation"]["configured"] is False, doc
print("ok: GET /healthz -> 200, evidenceClass=worker-unattested, bank loaded (4 entries)")
PY

# ---- 2. bridge-shaped observe -> match -------------------------------------
BODY_MATCH='{"op":"observe","response":{"kind":"ordinary","profile_sha256":"'"${PROFILE_SHA}"'","provider_id":"'"${PROVIDER}"'","request_id":"tee-smoke-match-1","response_text":"honest answer: 42","version":1},"version":1}'
STATUS="$(post "${BODY_MATCH}")"
[[ "${STATUS}" == "200" ]] || fail "observe match -> HTTP ${STATUS}"
assert_receipt "observe match (bank refs)" "tee-smoke-match-1" "match" 0 "bank"

# ---- 3. bridge-shaped observe -> mismatch + audit escalation ---------------
BODY_MISMATCH='{"op":"observe","response":{"kind":"ordinary","profile_sha256":"'"${PROFILE_SHA}"'","provider_id":"'"${PROVIDER}"'","request_id":"tee-smoke-mismatch-1","response_text":"demo attacker","version":1},"version":1}'
STATUS="$(post "${BODY_MISMATCH}")"
[[ "${STATUS}" == "200" ]] || fail "observe mismatch -> HTTP ${STATUS}"
assert_receipt "observe mismatch (bank refs)" "tee-smoke-mismatch-1" "mismatch" 1 "bank"

# ---- 4. unreferenced request -> honest inconclusive ------------------------
BODY_NOREF='{"op":"observe","response":{"kind":"ordinary","profile_sha256":"'"${PROFILE_SHA}"'","provider_id":"'"${PROVIDER}"'","request_id":"tee-smoke-noref-1","response_text":"no bank entry for this request","version":1},"version":1}'
STATUS="$(post "${BODY_NOREF}")"
[[ "${STATUS}" == "200" ]] || fail "observe noref -> HTTP ${STATUS}"
assert_receipt "observe without references" "tee-smoke-noref-1" "inconclusive" 0 "bank"

# ---- 5. inline reference_outputs extension ---------------------------------
BODY_INLINE='{"op":"observe","reference_outputs":[{"member":"ref-0","output_text":"inline reference output"},{"member":"ref-1","output_text":"inline reference output"},{"member":"ref-2","output_text":"inline reference output"}],"response":{"kind":"ordinary","profile_sha256":"'"${PROFILE_SHA}"'","provider_id":"'"${PROVIDER}"'","request_id":"tee-smoke-inline-1","response_text":"inline reference output","version":1},"version":1}'
STATUS="$(post "${BODY_INLINE}")"
[[ "${STATUS}" == "200" ]] || fail "observe inline -> HTTP ${STATUS}"
assert_receipt "observe with inline references" "tee-smoke-inline-1" "match" 0 "inline"

# ---- 6. audits op exposes the escalation -----------------------------------
STATUS="$(post '{"op":"audits","version":1}')"
[[ "${STATUS}" == "200" ]] || fail "audits -> HTTP ${STATUS}"
"${PYTHON}" -I - "${RESP}" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert sorted(doc.keys()) == ["ok", "result", "version"], doc
audits = doc["result"]
assert isinstance(audits, list) and len(audits) == 1, audits
record = audits[0]
assert record["verdict"] == "mismatch", record
assert record["request_id"] == "tee-smoke-mismatch-1", record
assert record["audit_id"].startswith("tee-audit-"), record
assert record["evidenceClass"] == "worker-unattested", record
print(f"ok: op audits -> 1 escalated audit ({record['audit_id']})")
PY

# ---- 7. auth / routing fail closed -----------------------------------------
STATUS="$(curl -sS -m 5 -o "${RESP}" -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}/v1/stdio" -H "Content-Type: application/json" --data-binary '{"op":"audits","version":1}')"
[[ "${STATUS}" == "401" ]] || fail "no-auth POST -> ${STATUS} (expected 401)"
STATUS="$(post '{"op":"audits","version":1}' "wrong-bearer")"
[[ "${STATUS}" == "401" ]] || fail "wrong-bearer POST -> ${STATUS} (expected 401)"
echo "ok: POST without/with wrong bearer -> 401"
STATUS="$(curl -sS -m 5 -o "${RESP}" -w '%{http_code}' "http://127.0.0.1:${PORT}/nope")"
[[ "${STATUS}" == "404" ]] || fail "GET /nope -> ${STATUS} (expected 404)"
echo "ok: GET /nope -> 404"

# ---- 8. attestation stub is honest (no fake claims) ------------------------
STATUS="$(curl -sS -m 5 -o "${RESP}" -w '%{http_code}' "http://127.0.0.1:${PORT}/attestation")"
[[ "${STATUS}" == "501" ]] || fail "GET /attestation -> ${STATUS} (expected 501)"
"${PYTHON}" -I - "${RESP}" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
assert doc["ok"] is False, doc
assert doc["reason"] == "attestation-not-configured", doc
assert doc["evidenceClass"] == "worker-unattested", doc
assert isinstance(doc["requirements"], list) and len(doc["requirements"]) >= 3, doc
text = json.dumps(doc)
assert "eyJ" not in text  # no JWT-shaped material is ever fabricated
print("ok: GET /attestation -> 501 honest stub (requirements listed, no token fabricated)")
PY

echo "SMOKE PASS"
