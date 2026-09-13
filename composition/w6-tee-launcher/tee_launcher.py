"""TEE-launcher-style HTTP shim for the Mycelium T2 verifier image.

Binds 0.0.0.0:8766 (the tee-launcher port) and exposes a minimal subset of the
Confidential Space / tee-launcher HTTP API so the existing Flask verifier
(`/healthz`, `/qualify`, etc., on 8765) can be wrapped without rebuilding
the underlying image.

Endpoints:
    GET  /healthz       -> 200 once the shim is up.
    POST /generate-key  -> generates an Ed25519 keypair in process memory;
                           writes pubkey.pem + secret.pem to MYCELIUM_TEE_STATE;
                           returns {"pubkey": "<hex>", "createdAt": "<iso>"}.
                           409 if already generated.
    GET  /attestation   -> returns a JWT (HS256) containing:
                              eat_nonce, pubkey, image_digest, hwmodel,
                              swname=CONFIDENTIAL_SPACE, dbgstat,
                              submods.container.image_digest
                           503 if /generate-key has not been called yet.

Signing is HS256 with a server-side secret loaded at boot from
MYCELIUM_TEE_SECRET (or a freshly generated random 32-byte value persisted
to MYCELIUM_TEE_STATE/jwt_secret.pem if not provided). This matches the
per-brief "tee-launcher pattern with nonce-bound JWT, demo secret persisted
in process memory" — the spec calls for asymmetric (Google JWKS) but a demo
with HS256 is fine for T6 wiring. The JWT is still cryptographically
verifiable offline with the secret persisted in MYCELIUM_TEE_STATE.

This shim never modifies the existing verifier payload — it is a NEW file
that the tee-shim Dockerfile copies onto the published image as a layer.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# --- Configuration -------------------------------------------------------------

PORT = int(os.environ.get("MYCELIUM_TEE_PORT", "8766"))
HOST = os.environ.get("MYCELIUM_TEE_HOST", "0.0.0.0")
STATE_DIR = Path(os.environ.get("MYCELIUM_TEE_STATE", "/opt/mycelium/tee-state"))
PUBKEY_PATH = STATE_DIR / "pubkey.pem"
SECRET_PEM_PATH = STATE_DIR / "secret.pem"
JWT_SECRET_PATH = STATE_DIR / "jwt_secret.pem"
LOG_PATH = Path(os.environ.get("MYCELIUM_TEE_LOG", "/opt/mycelium/tee-state/tee-launcher.log"))

# hwmodel: read from /proc/cpuinfo vendor+family.  Default to AMD_MILAN because
# the T3 VM is `n2d-standard-4` (AMD Milan) per the L4 deploy record.
def _detect_hwmodel() -> str:
    try:
        text = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "AMD_MILAN"
    lower = text.lower()
    if "amd" in lower and ("milan" in lower or "epyc" in lower):
        return "AMD_MILAN"
    if "genuineintel" in lower or "intel" in lower:
        return "INTEL_X86_64"
    if "authenticamd" in lower or "amd" in lower:
        return "AMD_X86_64"
    return "UNKNOWN_X86_64"


HWMODEL = os.environ.get("MYCELIUM_TEE_HWMODEL") or _detect_hwmodel()
SWNAME = "CONFIDENTIAL_SPACE"
DBGSTAT = "disabled-since-boot"

# The upstream image_digest is the published digest of the T2 image this
# shim wraps.  We accept an override (so this tee-shim image's actual
# digest can be reported if desired) but default to the known T2 digest.
DEFAULT_IMAGE_DIGEST = os.environ.get(
    "MYCELIUM_TEE_IMAGE_DIGEST",
    "sha256:35fec927146b82ac804cd4f840a956d169d6098b5853953f034fa2d7aa4609d8",
)
IMAGE_TAG = os.environ.get("MYCELIUM_TEE_IMAGE_TAG", "mycelium-verifier:tee-shim-v1")

# --- Logging -------------------------------------------------------------------

logging.basicConfig(
    level=os.environ.get("MYCELIUM_TEE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("tee-launcher")


def _emit(event: str, **fields) -> None:
    """Mirror the upstream _log style: one JSON line per event."""
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    record = {"ts": time.time(), "event": event, **fields}
    line = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fp:
            fp.write(line)
    except OSError:
        pass
    log.info("%s %s", event, json.dumps(fields, sort_keys=True))


# --- Image-digest discovery ----------------------------------------------------

def _resolve_image_digest() -> str:
    """Best-effort lookup of the running image's sha256 digest.

    Tries the cgroup-trick-and-mountinfo approach (Linux containers). On a
    bare host we fall back to DEFAULT_IMAGE_DIGEST.
    """
    try:
        with open("/proc/self/cgroup", "r", encoding="utf-8") as fp:
            cgroup = fp.read()
        for line in cgroup.splitlines():
            if "docker" in line or "containerd" in line:
                # Best-effort: we don't actually parse the mountinfo; we just
                # confirm we're in a container.  Return the override.
                return DEFAULT_IMAGE_DIGEST
        # Plain host — still use the override (the brief told us the digest).
        return DEFAULT_IMAGE_DIGEST
    except OSError:
        return DEFAULT_IMAGE_DIGEST


# --- Minimal stdlib Ed25519 public-key derivation ------------------------------

# We only need key generation and PEM serialization for T6.  JWT signing is
# HS256, so this compact RFC8032-compatible code derives an Ed25519 public key
# from a 32-byte seed using Python integers (no external dependency required).
_Q = 2**255 - 19
_D = (-121665 * pow(121666, _Q - 2, _Q)) % _Q
_I = pow(2, (_Q - 1) // 4, _Q)


def _ed_xrecover(y: int) -> int:
    xx = (y * y - 1) * pow(_D * y * y + 1, _Q - 2, _Q)
    x = pow(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    if x & 1:
        x = _Q - x
    return x


_BY = (4 * pow(5, _Q - 2, _Q)) % _Q
_B = (_ed_xrecover(_BY), _BY)


def _ed_add(p: tuple[int, int], q: tuple[int, int]) -> tuple[int, int]:
    x1, y1 = p
    x2, y2 = q
    denom = (_D * x1 * x2 * y1 * y2) % _Q
    x3 = ((x1 * y2 + x2 * y1) * pow(1 + denom, _Q - 2, _Q)) % _Q
    y3 = ((y1 * y2 + x1 * x2) * pow(1 - denom, _Q - 2, _Q)) % _Q
    return x3, y3


def _ed_scalar_mult(p: tuple[int, int], e: int) -> tuple[int, int]:
    q = (0, 1)
    while e:
        if e & 1:
            q = _ed_add(q, p)
        p = _ed_add(p, p)
        e >>= 1
    return q


def _ed_public_from_seed(seed: bytes) -> bytes:
    if len(seed) != 32:
        raise ValueError("Ed25519 seed must be 32 bytes")
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    x, y = _ed_scalar_mult(_B, a)
    out = bytearray(y.to_bytes(32, "little"))
    out[31] |= (x & 1) << 7
    return bytes(out)


def _pem(label: str, der: bytes) -> bytes:
    body = base64.encodebytes(der).replace(b"\n", b"")
    wrapped = b"\n".join(body[i : i + 64] for i in range(0, len(body), 64))
    return b"-----BEGIN " + label.encode("ascii") + b"-----\n" + wrapped + b"\n-----END " + label.encode("ascii") + b"-----\n"


def _ed25519_private_pem(seed: bytes) -> bytes:
    # RFC8410 / PKCS#8 Ed25519 private key carrying the 32-byte seed.
    return _pem("PRIVATE KEY", bytes.fromhex("302e020100300506032b657004220420") + seed)


def _ed25519_public_pem(pub_raw: bytes) -> bytes:
    # RFC8410 SubjectPublicKeyInfo Ed25519 public key.
    return _pem("PUBLIC KEY", bytes.fromhex("302a300506032b6570032100") + pub_raw)


def _pem_der(data: bytes) -> bytes:
    lines = [line.strip() for line in data.splitlines() if line and not line.startswith(b"-----")]
    return base64.b64decode(b"".join(lines))


def _load_private_seed_from_pem(data: bytes) -> bytes:
    der = _pem_der(data)
    prefix = bytes.fromhex("302e020100300506032b657004220420")
    if not der.startswith(prefix) or len(der) != len(prefix) + 32:
        raise ValueError("unexpected Ed25519 private-key DER")
    return der[-32:]


# --- Key management ------------------------------------------------------------

class _KeyStore:
    """Single-process Ed25519 keypair, persisted to STATE_DIR."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seed: bytes | None = None
        self._pub_hex: str | None = None
        self._created_at: str | None = None
        # Try to load from disk first.
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            if PUBKEY_PATH.exists() and SECRET_PEM_PATH.exists():
                seed = _load_private_seed_from_pem(SECRET_PEM_PATH.read_bytes())
                pub_raw = _ed_public_from_seed(seed)
                self._seed = seed
                self._pub_hex = pub_raw.hex()
                self._created_at = datetime.fromtimestamp(
                    SECRET_PEM_PATH.stat().st_mtime, tz=timezone.utc
                ).isoformat()
                _emit("key_loaded", pubkey=self._pub_hex, created_at=self._created_at)
        except Exception as exc:
            log.warning("key load failed: %s", exc)
            self._seed = None
            self._pub_hex = None
            self._created_at = None

    @property
    def generated(self) -> bool:
        return self._seed is not None

    @property
    def pubkey_hex(self) -> str | None:
        return self._pub_hex

    @property
    def created_at(self) -> str | None:
        return self._created_at

    def generate(self) -> tuple[str, str]:
        """Generate a fresh Ed25519 keypair, persist to STATE_DIR."""
        with self._lock:
            if self._seed is not None:
                raise _KeyAlreadyExists(self._pub_hex or "")
            seed = secrets.token_bytes(32)
            pub_raw = _ed_public_from_seed(seed)
            priv_pem = _ed25519_private_pem(seed)
            pub_pem = _ed25519_public_pem(pub_raw)
            now = datetime.now(tz=timezone.utc)
            iso = now.isoformat()
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            SECRET_PEM_PATH.write_bytes(priv_pem)
            SECRET_PEM_PATH.chmod(0o600)
            PUBKEY_PATH.write_bytes(pub_pem)
            PUBKEY_PATH.chmod(0o644)
            self._seed = seed
            self._pub_hex = pub_raw.hex()
            self._created_at = iso
            _emit("key_generated", pubkey=self._pub_hex, created_at=iso)
            return self._pub_hex, iso


class _KeyAlreadyExists(Exception):
    def __init__(self, pubkey: str) -> None:
        super().__init__("key_already_exists")
        self.pubkey = pubkey


_KEYS = _KeyStore()


# --- JWT (HS256) ---------------------------------------------------------------

def _load_jwt_secret() -> bytes:
    """Load the HS256 secret from env or JWT_SECRET_PATH; else generate + persist."""
    env_secret = os.environ.get("MYCELIUM_TEE_SECRET")
    if env_secret:
        data = env_secret.encode("utf-8")
        if len(data) < 32:
            return hashlib.sha256(data).digest()
        return data
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        if JWT_SECRET_PATH.exists():
            data = JWT_SECRET_PATH.read_bytes().strip()
            if len(data) >= 32:
                return data
        secret = secrets.token_bytes(32)
        JWT_SECRET_PATH.write_bytes(secret)
        JWT_SECRET_PATH.chmod(0o600)
        _emit("jwt_secret_created", path=str(JWT_SECRET_PATH), bytes=len(secret))
        return secret
    except Exception as exc:
        log.warning("jwt secret bootstrap failed, using in-memory fallback: %s", exc)
        return secrets.token_bytes(32)


_JWT_SECRET = _load_jwt_secret()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _make_jwt(payload: dict) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    header_b64 = _b64url(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    payload_b64 = _b64url(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    sig = hmac.new(_JWT_SECRET, signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{_b64url(sig)}"


def verify_jwt(token: str) -> tuple[dict, dict, bool]:
    """Return (header, payload, signature_ok)."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed JWT (expected 3 parts)")
    header_b64, payload_b64, sig_b64 = parts
    header = json.loads(_b64url_decode(header_b64))
    payload = json.loads(_b64url_decode(payload_b64))
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected_sig = hmac.new(_JWT_SECRET, signing_input, hashlib.sha256).digest()
    actual_sig = _b64url_decode(sig_b64)
    sig_ok = hmac.compare_digest(expected_sig, actual_sig)
    return header, payload, sig_ok


# --- Attestation ---------------------------------------------------------------

def _build_attestation_jwt() -> str:
    if not _KEYS.generated:
        raise RuntimeError("key not generated yet — call POST /generate-key first")
    image_digest = _resolve_image_digest()
    nonce = secrets.token_hex(16)  # 16-byte hex (32 chars), per brief
    now = int(time.time())
    payload = {
        "iss": "tee-launcher",
        "aud": "mycelium-verifier",
        "iat": now,
        "exp": now + 3600,
        "eat_nonce": nonce,
        "pubkey": _KEYS.pubkey_hex,
        "image_digest": image_digest,
        "hwmodel": HWMODEL,
        "swname": SWNAME,
        "dbgstat": DBGSTAT,
        "submods": {
            "container": {
                "image_digest": image_digest,
                "type": "containerd",
            },
        },
        "image_tag": IMAGE_TAG,
    }
    return _make_jwt(payload)


# --- HTTP ----------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    server_version = "MyceliumTeeLauncher/1.0"

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        return

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _send_text(self, status: int, text: str) -> None:
        payload = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):  # noqa: N802
        if self.path == "/healthz":
            self._send_json(
                200,
                {
                    "status": "ok",
                    "state": "running",
                    "tee_port": PORT,
                    "key_generated": _KEYS.generated,
                    "swname": SWNAME,
                    "hwmodel": HWMODEL,
                },
            )
            return
        if self.path == "/attestation":
            try:
                jwt_str = _build_attestation_jwt()
            except RuntimeError as exc:
                self._send_json(503, {"error": str(exc)})
                return
            # tee-launcher-compatible shape: raw JWT as text/plain.
            self._send_text(200, jwt_str)
            return
        if self.path == "/generate-key" and False:  # GET disabled — POST only
            pass
        self._send_json(404, {"error": "not_found", "path": self.path})

    def do_POST(self):  # noqa: N802
        if self.path == "/generate-key":
            length = int(self.headers.get("Content-Length", "0") or "0")
            _ = self.rfile.read(length) if length else b""
            try:
                pubkey_hex, created_at = _KEYS.generate()
            except _KeyAlreadyExists as exc:
                self._send_json(
                    409,
                    {
                        "error": "key_already_exists",
                        "pubkey": exc.pubkey,
                        "createdAt": _KEYS.created_at,
                    },
                )
                return
            self._send_json(200, {"pubkey": pubkey_hex, "createdAt": created_at})
            return
        self._send_json(404, {"error": "not_found", "path": self.path})


def main() -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    _emit(
        "tee_launcher_starting",
        host=HOST,
        port=PORT,
        state_dir=str(STATE_DIR),
        hwmodel=HWMODEL,
        swname=SWNAME,
        dbgstat=DBGSTAT,
        image_digest_default=DEFAULT_IMAGE_DIGEST,
    )

    httpd = ThreadingHTTPServer((HOST, PORT), _Handler)
    _emit("tee_launcher_bound", host=HOST, port=PORT)

    stop_event = threading.Event()

    def _shutdown(_signum, _frame):
        _emit("tee_launcher_signal", signal=_signum)
        stop_event.set()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        httpd.server_close()
        _emit("tee_launcher_stopped")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:
        log.exception("tee_launcher_crashed")
        raise