"""W6 TEE verifier worker — deployable per-request verifier implementing the
exact HTTP contract of the client bridge (composition/w6-verifier-bridge.mjs).

SPDX-License-Identifier: AGPL-3.0-or-later

WHAT THIS IS
------------
A self-contained (Python stdlib only) HTTP worker that:

  1. Speaks the client bridge's wire protocol exactly:
       POST <base>/v1/stdio
         Authorization: Bearer <token>          (required, constant-time compare)
         Content-Type: application/json
         body: one-line canonical JSON frame    {"version": 1, "op": "...", ...}
       reply (EXACTLY these three keys — the bridge enforces exactKeys()):
         {"version": 1, "ok": true,  "result": <op-specific>}
         {"version": 1, "ok": false, "error": "<reason>"}
     (see composition/w6-verifier-bridge.mjs:67-91 for parseReply and
      composition/w6-verifier-bridge.mjs:245-315 for HttpsTransport).

  2. Runs a real bounded verification computation for the demo class of
     checks: for ``op: "observe"`` it assembles the request digest, the output
     digest and the reference-model outputs, runs the ensemble target-vs-rest
     statistical agreement test (tee_verifier_math.py, exact binomial math),
     and returns a receipt carrying verdict match | mismatch | inconclusive
     (| unavailable), reference evidence, and the honest evidence class.

  3. Serves ``GET /healthz`` (liveness + pinned config summary) and
     ``GET /attestation`` (passthrough to a configured attestation URL, or an
     honest 501 stub describing exactly what the attestation surface must add).

WHAT THIS IS NOT
----------------
  * It does NOT provide TEE attestation. Every response carries
    ``evidenceClass: "worker-unattested"`` and the /attestation stub refuses to
    fabricate attestation claims (see ATTESTATION_REQUIREMENTS below).
  * It does NOT run any ML model. Reference outputs are supplied by a pinned
    reference bank (JSON file) or are passed inline by direct callers. Producing
    the reference outputs from real reference models is a separate, model-side
    workstream (see the W6 runbook, docs/handoffs/w6-tee-verifier-worker.md).
  * It is NOT wired into the running demo application. Activating it is a
    driver-owned action (set W6_VERIFIER_TEE_URL on the paid app).

ENVIRONMENT
-----------
  W6_TEE_VERIFIER_HOST            bind host (default 127.0.0.1; use 0.0.0.0 in
                                  a container that must be reachable by the app)
  W6_TEE_VERIFIER_PORT            bind port (default 8443; 0 = ephemeral)
  W6_TEE_VERIFIER_BEARER          shared bearer token the client must present
  W6_TEE_VERIFIER_BEARER_FILE     alternative: file containing the bearer (0600)
  W6_TEE_VERIFIER_TLS_CERT        PEM certificate chain (required for TLS)
  W6_TEE_VERIFIER_TLS_KEY         PEM private key (required for TLS)
  W6_TEE_VERIFIER_ALLOW_PLAINTEXT "1" permits loopback-only plaintext HTTP for
                                  local smoke tests (never for deployment; the
                                  client bridge only accepts https:// origins)
  W6_TEE_VERIFIER_REFERENCE_BANK  path to the pinned reference bank JSON
  W6_TEE_VERIFIER_ATTESTATION_URL optional attestation passthrough target
  W6_TEE_VERIFIER_ALPHA           significance level (default 0.05)
  W6_TEE_VERIFIER_AGREEMENT_FLOOR match floor k/n (default 0.6)
  W6_TEE_VERIFIER_MIN_MEMBERS     minimum reference ensemble (default 3)
  W6_TEE_VERIFIER_CHANCE_FLOOR    optional lower bound on p0 (default 0.0)

CLI
---
  python3 tee_verifier_worker.py serve            (default)
  python3 tee_verifier_worker.py request-digest --request-id R --provider-id P --profile-sha256 S
  python3 tee_verifier_worker.py output-digest --text "..." | --text-file PATH
"""

from __future__ import annotations

import json
import hmac
import os
import re
import signal
import ssl
import sys
import threading
import time
import traceback
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import tee_verifier_math as mathlib  # noqa: E402  (path fixed above for -I runs)

# ---------------------------------------------------------------------------
# Protocol constants (mirror composition/w6-verifier-bridge.mjs)
# ---------------------------------------------------------------------------

WIRE_VERSION = 1
MAX_FRAME_BYTES = 2 * 1024 * 1024          # bridge MAX_FRAME_BYTES (line 24)
MAX_BODY_BYTES = MAX_FRAME_BYTES - 1       # w6-verifier-serve.mjs:13
MAX_RESPONSE_TEXT_BYTES = 1024 * 1024      # bridge normalizeObservation (:404-406)
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
RAW_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")

MAX_OBSERVATIONS = 256                     # bounded state (mirrors w12 store)
MAX_AUDITS = 32
MAX_SCORE_ROWS = 64
MAX_BANK_BYTES = 8 * 1024 * 1024

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8443
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

ATTESTATION_REQUIREMENTS = [
    "A nonce-bound workload attestation token (JWT) issued by the Confidential "
    "Space launcher (or an equivalent AMD SEV-SNP report verifier), bound to a "
    "caller-supplied eat_nonce.",
    "A workload signing key generated inside the CVM, with the token signed by "
    "that key (asymmetric) and verifiable offline against platform JWKS — this "
    "worker holds no such key and must not fabricate one.",
    "Claims binding the token to THIS worker build: image digest "
    "(submods.container.image_digest), swname, dbgstat and hwmodel.",
    "An /attestation endpoint that issues or proxies that token per request; "
    "this worker's /attestation is a passthrough stub only "
    "(set W6_TEE_VERIFIER_ATTESTATION_URL to point it at the real source).",
]


class ConfigError(Exception):
    pass


class WorkerOpError(Exception):
    """Operation-level error mapped to a {"version":1,"ok":false,"error":...} envelope."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class RequestProblem(Exception):
    """Transport-level error mapped to a non-2xx {"ok":false,"reason":...} body."""

    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _log(event: str, **fields) -> None:
    """Structured stderr logging. Never logs response text, bearers, or keys."""
    record = {"ts": time.time(), "event": event, **fields}
    sys.stderr.write(json.dumps(record, sort_keys=True, default=str) + "\n")
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


class Config:
    def __init__(self, env=None):
        env = dict(os.environ if env is None else env)
        self.env = env
        self.host = str(env.get("W6_TEE_VERIFIER_HOST", DEFAULT_HOST))
        port_raw = str(env.get("W6_TEE_VERIFIER_PORT", DEFAULT_PORT))
        if not port_raw.isdigit():
            raise ConfigError(f"W6_TEE_VERIFIER_PORT must be an integer, got {port_raw!r}")
        self.port = int(port_raw)
        if not 0 <= self.port <= 65535:
            raise ConfigError(f"W6_TEE_VERIFIER_PORT out of range: {self.port}")

        self.bearer = self._load_bearer(env)
        self.tls_cert = env.get("W6_TEE_VERIFIER_TLS_CERT") or None
        self.tls_key = env.get("W6_TEE_VERIFIER_TLS_KEY") or None
        if bool(self.tls_cert) != bool(self.tls_key):
            raise ConfigError(
                "W6_TEE_VERIFIER_TLS_CERT and W6_TEE_VERIFIER_TLS_KEY must be set together"
            )
        self.plaintext = bool(self.tls_cert) is False
        self.allow_plaintext = env.get("W6_TEE_VERIFIER_ALLOW_PLAINTEXT") == "1"
        if self.plaintext:
            if not self.allow_plaintext:
                raise ConfigError(
                    "TLS required: set W6_TEE_VERIFIER_TLS_CERT/KEY (the client bridge "
                    "only accepts https:// origins). For loopback smoke tests only, set "
                    "W6_TEE_VERIFIER_ALLOW_PLAINTEXT=1."
                )
            if self.host not in LOOPBACK_HOSTS:
                raise ConfigError(
                    "W6_TEE_VERIFIER_ALLOW_PLAINTEXT=1 is honoured only on loopback hosts "
                    f"({', '.join(LOOPBACK_HOSTS)}); refusing to serve {self.host} in cleartext"
                )

        self.bank_path = env.get("W6_TEE_VERIFIER_REFERENCE_BANK") or None
        self.attestation_url = env.get("W6_TEE_VERIFIER_ATTESTATION_URL") or None

        self.alpha = _env_float(env, "W6_TEE_VERIFIER_ALPHA", mathlib.DEFAULT_ALPHA)
        self.agreement_floor = _env_float(
            env, "W6_TEE_VERIFIER_AGREEMENT_FLOOR", mathlib.DEFAULT_AGREEMENT_FLOOR
        )
        self.min_members = _env_int(env, "W6_TEE_VERIFIER_MIN_MEMBERS", mathlib.DEFAULT_MIN_MEMBERS)
        self.chance_floor = _env_float(
            env, "W6_TEE_VERIFIER_CHANCE_FLOOR", mathlib.DEFAULT_CHANCE_FLOOR
        )
        if not 0 < self.alpha < 1:
            raise ConfigError("W6_TEE_VERIFIER_ALPHA must be in (0, 1)")
        if not 0 < self.agreement_floor <= 1:
            raise ConfigError("W6_TEE_VERIFIER_AGREEMENT_FLOOR must be in (0, 1]")
        if self.min_members < 1:
            raise ConfigError("W6_TEE_VERIFIER_MIN_MEMBERS must be >= 1")
        if not 0 <= self.chance_floor <= 1:
            raise ConfigError("W6_TEE_VERIFIER_CHANCE_FLOOR must be in [0, 1]")

    @staticmethod
    def _load_bearer(env) -> str:
        raw = env.get("W6_TEE_VERIFIER_BEARER")
        path = env.get("W6_TEE_VERIFIER_BEARER_FILE")
        if raw and path:
            raise ConfigError("set only one of W6_TEE_VERIFIER_BEARER / W6_TEE_VERIFIER_BEARER_FILE")
        if path:
            try:
                raw = Path(path).read_text(encoding="utf-8").strip()
            except OSError as error:
                raise ConfigError(f"cannot read W6_TEE_VERIFIER_BEARER_FILE: {error}") from error
        if not isinstance(raw, str) or not raw:
            raise ConfigError(
                "bearer required: set W6_TEE_VERIFIER_BEARER or W6_TEE_VERIFIER_BEARER_FILE "
                "(the value must equal the client's W6_VERIFIER_TEE_BEARER)"
            )
        if len(raw.encode("utf-8")) > 8192:
            raise ConfigError("bearer must be at most 8192 bytes (bridge constraint)")
        return raw

    def verification_params(self) -> dict:
        return {
            "alpha": self.alpha,
            "agreement_floor": self.agreement_floor,
            "min_members": self.min_members,
            "chance_floor": self.chance_floor,
        }

    def safe_summary(self) -> dict:
        """Config summary safe to log / expose on /healthz. No secrets."""
        return {
            "host": self.host,
            "port": self.port,
            "tls": not self.plaintext,
            "plaintextAllowed": bool(self.plaintext and self.allow_plaintext),
            "bankPathConfigured": bool(self.bank_path),
            "attestationConfigured": bool(self.attestation_url),
            "verification": {"test": mathlib.TEST_ID, **self.verification_params()},
            "workerVersion": mathlib.WORKER_VERSION,
            "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
        }


def _env_float(env, name: str, default: float) -> float:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError as error:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from error
    if value != value or value in (float("inf"), float("-inf")):
        raise ConfigError(f"{name} must be finite")
    return value


def _env_int(env, name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from error


# ---------------------------------------------------------------------------
# Reference bank
# ---------------------------------------------------------------------------


class ReferenceBank:
    """Pinned JSON reference bank: request digest -> reference model outputs.

    File shape::

        {
          "version": 1,
          "bank_id": "example-bank-1",
          "agreement": {"alpha": 0.05, "agreement_floor": 0.6,
                        "min_members": 3, "chance_floor": 0.0},
          "entries": {
            "<request_digest_hex>": {
              "profile_sha256": "<64hex>" | null,
              "reference_outputs": [
                {"member": "ref-0", "output_text": "..."},
                {"member": "ref-1", "output_digest": "<64hex>"}
              ]
            }
          }
        }

    Malformed entries are retained as ``error`` markers so that an observation
    against them yields an honest ``unavailable / reference-bank-entry-invalid``
    receipt instead of silently degrading to an inconclusive verdict.
    A missing or unreadable bank file is logged and treated as an empty bank
    (every observation then returns ``inconclusive / no-reference-ensemble``).
    """

    def __init__(self, path=None):
        self.path = path
        self.loaded = False
        self.load_error = None
        self.bank_id = None
        self.params = {}
        self._entries = {}

    @classmethod
    def load(cls, path) -> "ReferenceBank":
        bank = cls(path)
        if not path:
            return bank
        try:
            raw = Path(path).read_bytes()
            if len(raw) > MAX_BANK_BYTES:
                raise ValueError("bank file exceeds 8 MiB")
            document = json.loads(raw.decode("utf-8"))
            bank._apply(document)
            bank.loaded = True
        except Exception as error:  # noqa: BLE001 - operator-visible config error
            bank.load_error = f"{type(error).__name__}: {error}"
            _log("reference_bank_load_failed", path=str(path), error=bank.load_error)
        return bank

    def _apply(self, document) -> None:
        if not isinstance(document, dict) or document.get("version") != 1:
            raise ValueError("bank must be an object with version == 1")
        entries = document.get("entries")
        if not isinstance(entries, dict):
            raise ValueError("bank.entries must be an object")
        self.bank_id = document.get("bank_id") if isinstance(document.get("bank_id"), str) else None
        agreement = document.get("agreement", {})
        if not isinstance(agreement, dict):
            raise ValueError("bank.agreement must be an object")
        for key in ("alpha", "agreement_floor", "min_members", "chance_floor"):
            if key in agreement:
                self.params[key] = agreement[key]
        for request_digest, entry in entries.items():
            try:
                self._entries[request_digest] = self._parse_entry(request_digest, entry)
            except Exception as error:  # noqa: BLE001 - retained as an honest error marker
                self._entries[request_digest] = {
                    "error": f"reference-bank-entry-invalid: {type(error).__name__}: {error}"
                }

    @staticmethod
    def _parse_entry(request_digest, entry) -> dict:
        if not isinstance(request_digest, str) or not RAW_DIGEST_RE.match(request_digest):
            raise ValueError(f"entry key must be 64-hex, got {request_digest!r}")
        if not isinstance(entry, dict):
            raise ValueError(f"entry {request_digest} must be an object")
        references = entry.get("reference_outputs")
        if not isinstance(references, list) or not references:
            raise ValueError(f"entry {request_digest} must carry a non-empty reference_outputs list")
        normalized = []
        for index, reference in enumerate(references):
            if not isinstance(reference, dict):
                raise ValueError(f"entry {request_digest} reference[{index}] must be an object")
            member = reference.get("member")
            if not isinstance(member, str) or not member:
                member = f"ref-{index}"
            text = reference.get("output_text")
            digest = reference.get("output_digest")
            if isinstance(text, str) and not isinstance(digest, str):
                digest = mathlib.output_digest(text)
            if not isinstance(digest, str) or not RAW_DIGEST_RE.match(digest):
                raise ValueError(
                    f"entry {request_digest} reference[{index}] needs output_text or 64-hex output_digest"
                )
            normalized.append({"member": member, "digest": digest})
        profile = entry.get("profile_sha256")
        if profile is not None and (not isinstance(profile, str) or not RAW_DIGEST_RE.match(profile)):
            raise ValueError(f"entry {request_digest} profile_sha256 must be null or 64-hex")
        return {
            "profile_sha256": profile,
            "reference_outputs": normalized,
        }

    def entries(self) -> int:
        return len(self._entries)

    def lookup(self, request_digest: str):
        """Return {"references": [...], "profile_sha256": ...} or {"error": reason}.

        Returns None when there is no entry for the request digest.
        """
        entry = self._entries.get(request_digest)
        if entry is None:
            return None
        if "error" in entry:
            return {"error": entry["error"]}
        return entry


# ---------------------------------------------------------------------------
# Bounded in-memory state (honest: ephemeral; a durable journal is a TODO)
# ---------------------------------------------------------------------------


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.observations = OrderedDict()  # request_id -> record
        self.audits = []                   # newest first
        self.audit_counter = 0
        self.observation_counter = 0

    def get_observation(self, request_id):
        with self.lock:
            record = self.observations.get(request_id)
            return dict(record) if record else None

    def list_observations(self, limit=MAX_OBSERVATIONS):
        with self.lock:
            rows = list(self.observations.values())[-limit:]
        return [dict(row) for row in reversed(rows)]

    def put_observation(self, request_id, record):
        with self.lock:
            self.observation_counter += 1
            stored = dict(record)
            stored["observation_id"] = f"tee-obs-{self.observation_counter:06d}"
            self.observations[request_id] = stored
            while len(self.observations) > MAX_OBSERVATIONS:
                self.observations.popitem(last=False)
            return dict(stored)

    def create_audit(self, record):
        with self.lock:
            self.audit_counter += 1
            audit = dict(record)
            audit["audit_id"] = f"tee-audit-{self.audit_counter:06d}-{audit['output_digest'][:8]}"
            self.audits.insert(0, audit)
            del self.audits[MAX_AUDITS:]
            return dict(audit)

    def list_audits(self):
        with self.lock:
            return [dict(row) for row in self.audits]

    def get_audit(self, audit_id):
        with self.lock:
            for row in self.audits:
                if row["audit_id"] == audit_id:
                    return dict(row)
        return None


# ---------------------------------------------------------------------------
# Verification assembly
# ---------------------------------------------------------------------------


def _validate_observe_response(response) -> dict:
    if not isinstance(response, dict):
        raise WorkerOpError("invalid-observation")
    if response.get("version") != WIRE_VERSION or response.get("kind") != "ordinary":
        raise WorkerOpError("invalid-observation")
    for field in ("request_id", "provider_id"):
        value = response.get(field)
        if not isinstance(value, str) or not IDENTIFIER_RE.match(value):
            raise WorkerOpError("invalid-observation")
    profile = response.get("profile_sha256")
    if profile is not None and (not isinstance(profile, str) or not RAW_DIGEST_RE.match(profile)):
        raise WorkerOpError("invalid-observation")
    text = response.get("response_text")
    if not isinstance(text, str):
        raise WorkerOpError("invalid-observation")
    if len(text.encode("utf-8")) > MAX_RESPONSE_TEXT_BYTES:
        raise WorkerOpError("invalid-observation")
    return response


def _parse_inline_references(value):
    if not isinstance(value, list) or not value:
        raise WorkerOpError("invalid-reference-outputs")
    references = []
    for index, reference in enumerate(value):
        if not isinstance(reference, dict):
            raise WorkerOpError("invalid-reference-outputs")
        member = reference.get("member")
        if not isinstance(member, str) or not member:
            member = f"inline-{index}"
        text = reference.get("output_text")
        digest = reference.get("output_digest")
        if isinstance(text, str) and not isinstance(digest, str):
            digest = mathlib.output_digest(text)
        if not isinstance(digest, str) or not RAW_DIGEST_RE.match(digest):
            raise WorkerOpError("invalid-reference-outputs")
        references.append({"member": member, "digest": digest})
    return references


def _resolve_references(frame, bank, request_digest, profile_sha256):
    """Return (references, source, bank_id, forced_reason).

    ``forced_reason`` short-circuits the test with a library-provided verdict
    (used for bank-integrity problems).
    """
    inline = frame.get("reference_outputs")
    if inline is not None:
        return _parse_inline_references(inline), "inline", None, None

    if bank is None or not bank.loaded:
        return [], "none", None, None

    entry = bank.lookup(request_digest)
    if entry is None:
        return [], "bank", bank.bank_id, None
    if "error" in entry:
        return [], "bank", bank.bank_id, "reference-bank-entry-invalid"
    if entry.get("profile_sha256") is not None and entry["profile_sha256"] != profile_sha256:
        return [], "bank", bank.bank_id, "reference-bank-profile-mismatch"
    return entry["reference_outputs"], "bank", bank.bank_id, None


def _verification_params(config: Config, bank) -> dict:
    """Effective test parameters: built-in defaults < bank agreement < env vars."""
    params = config.verification_params()
    env_names = {
        "alpha": "W6_TEE_VERIFIER_ALPHA",
        "agreement_floor": "W6_TEE_VERIFIER_AGREEMENT_FLOOR",
        "min_members": "W6_TEE_VERIFIER_MIN_MEMBERS",
        "chance_floor": "W6_TEE_VERIFIER_CHANCE_FLOOR",
    }
    bank_params = getattr(bank, "params", {}) or {}
    for key, env_name in env_names.items():
        if key in bank_params and config.env.get(env_name) in (None, ""):
            params[key] = bank_params[key]
    return params


def verify_observe(frame, config, bank, state) -> dict:
    """Assemble digests + references and run the ensemble test. Returns the receipt."""
    response = _validate_observe_response(frame.get("response"))
    request_id = response["request_id"]
    provider_id = response["provider_id"]
    profile_sha256 = response.get("profile_sha256")
    response_text = response["response_text"]

    request_digest = mathlib.request_digest(
        version=WIRE_VERSION,
        kind="ordinary",
        request_id=request_id,
        provider_id=provider_id,
        profile_sha256=profile_sha256,
    )
    digest = mathlib.output_digest(response_text)

    prior = state.get_observation(request_id)
    if prior is not None:
        if prior["output_digest"] != digest:
            raise WorkerOpError("observation-conflict")
        receipt = dict(prior["receipt"])
        receipt["duplicate"] = True
        return receipt

    references, source, bank_id, forced_reason = _resolve_references(
        frame, bank, request_digest, profile_sha256
    )

    if forced_reason == "reference-bank-entry-invalid":
        report = {
            "test": mathlib.TEST_ID,
            "verdict": mathlib.VERDICT_UNAVAILABLE,
            "reason": forced_reason,
            "n": 0, "k": 0, "largestGroup": 0, "agreement": None,
            "p0": None, "p0Rational": None,
            "pLower": None, "pLowerExact": None, "pUpper": None, "pUpperExact": None,
            "alpha": config.alpha,
            "agreementFloor": config.agreement_floor,
            "minMembers": config.min_members,
            "chanceFloor": config.chance_floor,
        }
    elif forced_reason == "reference-bank-profile-mismatch":
        report = {
            "test": mathlib.TEST_ID,
            "verdict": mathlib.VERDICT_INCONCLUSIVE,
            "reason": forced_reason,
            "n": 0, "k": 0, "largestGroup": 0, "agreement": None,
            "p0": None, "p0Rational": None,
            "pLower": None, "pLowerExact": None, "pUpper": None, "pUpperExact": None,
            "alpha": config.alpha,
            "agreementFloor": config.agreement_floor,
            "minMembers": config.min_members,
            "chanceFloor": config.chance_floor,
        }
    else:
        report = mathlib.ensemble_target_vs_rest(
            [reference["digest"] for reference in references],
            digest,
            **_verification_params(config, bank),
        )

    random_selected = len(references) > 0
    verdict = report["verdict"]

    audit_ids = []
    audit_record = None
    if verdict == mathlib.VERDICT_MISMATCH:
        audit_record = state.create_audit(
            {
                "provider_id": provider_id,
                "request_id": request_id,
                "trigger_request_id": request_id,
                "verdict": verdict,
                "status": "resolved",
                "outcome": {"status": verdict, "verdict": verdict},
                "request_digest": request_digest,
                "output_digest": digest,
                "referenceCount": report["n"],
                "agreementCount": report["k"],
                "createdAt": _utc_now(),
                "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
            }
        )
        audit_ids.append(audit_record["audit_id"])

    receipt = {
        "version": WIRE_VERSION,
        "request_id": request_id,
        "provider_id": provider_id,
        "random_selected": random_selected,
        "audit_ids": audit_ids,
        "verdict": verdict,
        "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
        "evidence": {
            "test": report["test"],
            "reason": report["reason"],
            "request_digest": request_digest,
            "output_digest": digest,
            "referenceCount": report["n"],
            "agreementCount": report["k"],
            "largestGroup": report["largestGroup"],
            "agreement": report["agreement"],
            "p0": report["p0"],
            "p0Rational": report["p0Rational"],
            "pLower": report["pLower"],
            "pLowerExact": report["pLowerExact"],
            "pUpper": report["pUpper"],
            "pUpperExact": report["pUpperExact"],
            "alpha": report["alpha"],
            "agreementFloor": report["agreementFloor"],
            "minMembers": report["minMembers"],
            "chanceFloor": report["chanceFloor"],
            "referenceSource": source,
            "bankId": bank_id,
            "members": [
                {"member": reference["member"], "agreement": reference["digest"] == digest}
                for reference in references
            ],
            "checkedAt": _utc_now(),
            "workerVersion": mathlib.WORKER_VERSION,
        },
    }

    stored = state.put_observation(
        request_id,
        {
            "request_id": request_id,
            "provider_id": provider_id,
            "verdict": verdict,
            "output_digest": digest,
            "receipt": receipt,
        },
    )
    receipt["observation_id"] = stored["observation_id"]
    _log(
        "observation_verified",
        request_id=request_id,
        provider_id=provider_id,
        verdict=verdict,
        reason=report["reason"],
        request_digest=request_digest,
        output_digest=digest,
        reference_source=source,
        k=report["k"],
        n=report["n"],
    )
    return receipt


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def _json_bytes(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class VerifierWorkerHandler(BaseHTTPRequestHandler):
    server_version = "W6TeeVerifierWorker/0.1.0"
    protocol_version = "HTTP/1.1"
    timeout = 30  # socket timeout; the client bridge aborts at 10s by default

    # -- plumbing -----------------------------------------------------------

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        # Route stdlib request logging to stderr without touching bodies.
        sys.stderr.write("w6-tee-verifier-worker %s\n" % (format % args))
        sys.stderr.flush()

    def _send(self, status, payload: bytes, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def _send_json(self, status, value):
        self._send(status, _json_bytes(value))

    def _send_problem(self, problem: RequestProblem):
        self._send_json(
            problem.status,
            {
                "ok": False,
                "reason": problem.reason,
                "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
            },
        )

    def _send_envelope_error(self, code: str):
        # Operation-level rejection: HTTP 200 carrying the protocol error
        # envelope (the bridge maps this to VERIFIER_REJECTED, w6-verifier-bridge.mjs:89).
        self._send_json(200, {"version": WIRE_VERSION, "ok": False, "error": code})

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization")
        if not isinstance(header, str) or not header.startswith("Bearer "):
            return False
        candidate = header[len("Bearer "):]
        if not candidate or "," in candidate:
            return False
        return hmac.compare_digest(
            candidate.encode("utf-8"), self.server.config.bearer.encode("utf-8")
        )

    def _read_body(self) -> bytes:
        if self.headers.get("Transfer-Encoding"):
            raise RequestProblem(400, "unsupported-transfer-encoding")
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            raise RequestProblem(400, "invalid-content-length")
        if not re.match(r"^\d+$", length_header):
            raise RequestProblem(400, "invalid-content-length")
        length = int(length_header)
        if length > MAX_BODY_BYTES:
            raise RequestProblem(413, "request-too-large")
        body = self.rfile.read(length) if length else b""
        if len(body) != length:
            raise RequestProblem(400, "invalid-request-body")
        return body

    # -- GET ------------------------------------------------------------------

    def do_GET(self):  # noqa: N802 - stdlib signature
        try:
            path = self.path.split("?", 1)[0]
            if path == "/healthz":
                self._send_json(200, self.server.healthz())
                return
            if path == "/attestation":
                self._handle_attestation()
                return
            self._send_json(
                404,
                {"ok": False, "reason": "not-found",
                 "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED},
            )
        except Exception:  # noqa: BLE001 - never leak a stack trace to a client
            _log("request_failed", path=self.path, trace=traceback.format_exc())
            self._send_json(500, {"ok": False, "reason": "internal-error"})

    def _handle_attestation(self):
        target = self.server.config.attestation_url
        if not target:
            self._send_json(
                501,
                {
                    "ok": False,
                    "reason": "attestation-not-configured",
                    "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
                    "requirements": list(ATTESTATION_REQUIREMENTS),
                    "note": (
                        "This worker performs real (non-TEE) ensemble verification math and "
                        "claims no TEE guarantees. Set W6_TEE_VERIFIER_ATTESTATION_URL to proxy "
                        "a real attestation source (the tee-launcher/Confidential Space "
                        "endpoint); this stub will never fabricate an attestation token."
                    ),
                },
            )
            return
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        url = target + (("&" if "?" in target else "?") + query if query else "")
        try:
            request = urllib.request.Request(
                url, method="GET", headers={"accept": "application/json"}
            )
            with urllib.request.urlopen(request, timeout=5) as upstream:  # noqa: S310 - operator-configured URL
                body = upstream.read(MAX_FRAME_BYTES + 1)
                if len(body) > MAX_FRAME_BYTES:
                    raise ValueError("attestation reply too large")
                content_type = upstream.headers.get("Content-Type", "application/json")
                self._send(int(upstream.status), body, content_type=content_type)
        except Exception as error:  # noqa: BLE001 - upstream failure must degrade honestly
            _log("attestation_passthrough_failed", error=str(error))
            self._send_json(503, {"ok": False, "reason": "attestation-unavailable"})

    # -- POST -----------------------------------------------------------------

    def do_POST(self):  # noqa: N802 - stdlib signature
        try:
            path = self.path.split("?", 1)[0]
            if path != "/v1/stdio":
                self._send_json(404, {"ok": False, "reason": "not-found"})
                return
            if not self._authorized():
                self._send_json(401, {"ok": False, "reason": "unauthorized"})
                return
            media_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
            if media_type != "application/json":
                self._send_json(415, {"ok": False, "reason": "content-type-must-be-application-json"})
                return
            body = self._read_body()
            if not body:
                self._send_json(400, {"ok": False, "reason": "invalid-json"})
                return
            if b"\n" in body or b"\r" in body:
                self._send_json(400, {"ok": False, "reason": "json-must-be-one-line"})
                return
            try:
                frame = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                self._send_json(400, {"ok": False, "reason": "invalid-json"})
                return
            if not isinstance(frame, dict):
                self._send_json(400, {"ok": False, "reason": "invalid-frame"})
                return
            if frame.get("version") != WIRE_VERSION:
                self._send_envelope_error("unsupported-version")
                return
            op = frame.get("op")
            if not isinstance(op, str) or not op:
                self._send_json(400, {"ok": False, "reason": "invalid-frame"})
                return
            try:
                result = self.server.dispatch(op, frame)
            except WorkerOpError as error:
                _log("op_rejected", op=op, code=error.code)
                self._send_envelope_error(error.code)
                return
            self._send_json(200, {"version": WIRE_VERSION, "ok": True, "result": result})
        except RequestProblem as problem:
            self._send_problem(problem)
        except Exception:  # noqa: BLE001 - never leak a stack trace to a client
            _log("request_failed", path=self.path, trace=traceback.format_exc())
            self._send_json(500, {"ok": False, "reason": "internal-error"})


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


class VerifierWorkerServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: Config, bank: ReferenceBank, state: State):
        self.config = config
        self.bank = bank
        self.state = state
        super().__init__((config.host, config.port), VerifierWorkerHandler)

    # -- ops ----------------------------------------------------------------

    def dispatch(self, op: str, frame: dict):
        handler = {
            "observe": self._op_observe,
            "audits": self._op_audits,
            "scores": self._op_scores,
            "run": self._op_run,
            "observation": self._op_observation,
            "audit": self._op_audit,
            "close": self._op_close,
        }.get(op)
        if handler is None:
            raise WorkerOpError("unknown-op")
        return handler(frame)

    def _op_observe(self, frame):
        return verify_observe(frame, self.config, self.bank, self.state)

    def _op_audits(self, frame):
        return self.state.list_audits()

    def _op_scores(self, frame):
        rows = []
        for observation in self.state.list_observations(limit=MAX_SCORE_ROWS):
            verdict = observation["verdict"]
            if verdict in (mathlib.VERDICT_MATCH, mathlib.VERDICT_MISMATCH):
                status = "scored"
            elif verdict == mathlib.VERDICT_INCONCLUSIVE:
                status = "inconclusive"
            else:
                status = "unavailable"
            rows.append(
                {
                    "observation_id": observation.get("observation_id"),
                    "request_id": observation["request_id"],
                    "provider_id": observation["provider_id"],
                    "verdict": verdict,
                    "status": status,
                    "agreement": observation.get("receipt", {})
                    .get("evidence", {})
                    .get("agreement"),
                    "scoredAt": observation.get("receipt", {})
                    .get("evidence", {})
                    .get("checkedAt"),
                    "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
                }
            )
        return rows

    def _op_run(self, frame):
        # Verification is synchronous at observe time; there is no pending work
        # queue in this worker. Documented in the runbook and compatibility matrix.
        return []

    def _op_observation(self, frame):
        request_id = frame.get("request_id")
        if not isinstance(request_id, str) or not IDENTIFIER_RE.match(request_id):
            raise WorkerOpError("invalid-request-id")
        observation = self.state.get_observation(request_id)
        if observation is None:
            return None
        return observation["receipt"]

    def _op_audit(self, frame):
        audit_id = frame.get("audit_id")
        if not isinstance(audit_id, str) or not audit_id:
            raise WorkerOpError("invalid-audit-id")
        return self.state.get_audit(audit_id)

    def _op_close(self, frame):
        return {"closed": True, "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED}

    # -- misc ---------------------------------------------------------------

    def healthz(self) -> dict:
        bank = self.bank
        return {
            "ok": True,
            "version": WIRE_VERSION,
            "status": "ok",
            "state": "running",
            "mode": mathlib.EVIDENCE_CLASS_UNATTESTED,
            "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
            "workerVersion": mathlib.WORKER_VERSION,
            "config": self.config.safe_summary(),
            "bank": {
                "configured": bool(bank.path),
                "loaded": bool(bank.loaded),
                "bankId": bank.bank_id,
                "entries": bank.entries(),
                "loadError": bank.load_error,
            },
            "attestation": {"configured": bool(self.config.attestation_url)},
        }


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


def _run_server(config: Config) -> int:
    bank = ReferenceBank.load(config.bank_path)
    state = State()
    server = VerifierWorkerServer(config, bank, state)

    if not config.plaintext:
        if not config.tls_cert or not config.tls_key:  # defensive; Config guarantees both
            raise ConfigError("TLS mode requires W6_TEE_VERIFIER_TLS_CERT and W6_TEE_VERIFIER_TLS_KEY")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(config.tls_cert, config.tls_key)
        server.socket = context.wrap_socket(server.socket, server_side=True)

    host, port = server.server_address[0], server.server_address[1]
    scheme = "http" if config.plaintext else "https"
    _log(
        "listening",
        scheme=scheme,
        host=host,
        port=port,
        bank_loaded=bank.loaded,
        bank_entries=bank.entries(),
        attestation_configured=bool(config.attestation_url),
    )
    if config.plaintext:
        _log("plaintext_warning", detail="loopback-only non-TLS mode; never deploy this way")
    # The driver (Node test harness) parses this line to learn the bound port.
    print(
        json.dumps(
            {
                "event": "listening",
                "scheme": scheme,
                "host": host,
                "port": port,
                "pid": os.getpid(),
                "workerVersion": mathlib.WORKER_VERSION,
                "evidenceClass": mathlib.EVIDENCE_CLASS_UNATTESTED,
            },
            sort_keys=True,
        ),
        flush=True,
    )

    stop = threading.Event()

    def _shutdown(_signum, _frame):
        if stop.is_set():
            return
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        _log("stopped")
    return 0


def _usage() -> int:
    sys.stderr.write(__doc__.split("CLI\n---\n", 1)[-1].strip() + "\n")
    return 2


def _flag(argv, name, default=None, required=False):
    if name in argv:
        index = argv.index(name)
        if index + 1 >= len(argv):
            raise SystemExit(f"{name} requires a value")
        return argv[index + 1]
    if required:
        raise SystemExit(f"{name} is required")
    return default


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    command = argv[0] if argv else "serve"
    if command in ("-h", "--help", "help"):
        return _usage()
    if command == "request-digest":
        digest = mathlib.request_digest(
            version=int(_flag(argv, "--version", "1")),
            kind=_flag(argv, "--kind", "ordinary"),
            request_id=_flag(argv, "--request-id", required=True),
            provider_id=_flag(argv, "--provider-id", required=True),
            profile_sha256=_flag(argv, "--profile-sha256", required=True),
        )
        print(digest)
        return 0
    if command == "output-digest":
        text_file = _flag(argv, "--text-file")
        text = _flag(argv, "--text")
        if text_file:
            if text is not None:
                raise SystemExit("pass only one of --text / --text-file")
            text = Path(text_file).read_text(encoding="utf-8")
        if text is None:
            text = sys.stdin.read()
        print(mathlib.output_digest(text))
        return 0
    if command != "serve":
        return _usage()

    try:
        config = Config()
    except ConfigError as error:
        sys.stderr.write(f"config error: {error}\n")
        return 2
    try:
        return _run_server(config)
    except OSError as error:
        sys.stderr.write(f"failed to bind {config.host}:{config.port}: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
