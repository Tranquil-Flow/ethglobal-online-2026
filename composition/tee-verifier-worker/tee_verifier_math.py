"""Deterministic ensemble statistical verification math for the W6 TEE verifier worker.

SPDX-License-Identifier: AGPL-3.0-or-later

HONEST BOUNDARY (read this first)
----------------------------------
This module implements the *real* target-vs-rest ensemble agreement test, but it
is pure math over caller-supplied reference outputs. It proves nothing about the
machine it runs on. The deployable worker that imports this module labels every
response ``evidenceClass: "worker-unattested"`` until the process runs inside an
attested enclave with a verified, nonce-bound attestation chain (see
``tee_verifier_worker.py`` docstring and the W6 runbook).

The test (``ensemble_target_vs_rest``)
--------------------------------------
The "ensemble" is one target output (the provider output under audit) plus
N reference outputs (the rest of the ensemble, produced by reference models /
reference replicas; supplied as SHA-256 digests).

For one observation:

    n  = number of reference outputs
    k  = number of reference outputs whose canonical digest equals the target digest
    m  = size of the largest agreeing group among the reference digests
    p0 = max((m + 1) / (n + 2), chance_floor)     # Laplace-smoothed rest agreement

``p0`` is the per-member probability that a member of the *rest* agrees with the
modal reference output, estimated from the rest itself (Laplace smoothing keeps
it well-defined for small ensembles). It is the null rate used by an exact
one-sided binomial test:

    pLower = P(X <= k | X ~ Binomial(n, p0))      # exact, rational arithmetic
    pUpper = P(X >= k | X ~ Binomial(n, p0))

Decision rule (all constants are documented defaults, overridable):

    n == 0                        -> "inconclusive"  reason "no-reference-ensemble"
    n <  min_members              -> "inconclusive"  reason "insufficient-ensemble"
    pLower < alpha                -> "mismatch"      target diverges from the rest
    k / n  >= agreement_floor     -> "match"         target is consistent with the rest
    otherwise                     -> "inconclusive"  reason "agreement-below-match-floor"

``pUpper`` is reported for auditability but is not decisive. A "match" means
*consistency with the reference ensemble at or above the configured agreement
floor*, not a proof of correctness. A "mismatch" means the target agrees with
the rest-of-ensemble significantly less often than the rest agrees with itself
(significance level alpha). "inconclusive" is a first-class outcome and must be
recorded as such; it must never be upgraded to "match".

Worked vectors (n = 3 unanimous references, p0 = 4/5):

    target == reference digest (k = 3): pLower = 1.0     -> match
    target matches 2 of 3      (k = 2): pLower = 0.488   -> match (>= 0.6 floor)
    target matches 1 of 3      (k = 1): pLower = 0.104   -> inconclusive (floor)
    target matches none        (k = 0): pLower = 0.008   -> mismatch (< 0.05)

Every reported statistic is derived only from the inputs; the same inputs
always produce the same receipt (determinism is unit-tested).
"""

from __future__ import annotations

import hashlib
import json
import re
from fractions import Fraction
from math import comb

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WORKER_VERSION = "w6-tee-verifier-worker/0.1.0"

#: Every response produced without a verified enclave attestation chain is
#: labelled with this class. Do NOT allow this constant to be overridden by
#: environment: a config knob here would be an invitation to fake attestation.
EVIDENCE_CLASS_UNATTESTED = "worker-unattested"

TEST_ID = "ensemble-target-vs-rest-binomial-v1"

DEFAULT_ALPHA = 0.05            # significance level for the divergence test
DEFAULT_AGREEMENT_FLOOR = 0.6   # k/n floor for a positive "match"
DEFAULT_MIN_MEMBERS = 3         # smallest usable reference ensemble
DEFAULT_CHANCE_FLOOR = 0.0      # optional lower bound on p0
MAX_REFERENCE_MEMBERS = 64      # bounded ensemble size (bounds the exact math)

VERDICT_MATCH = "match"
VERDICT_MISMATCH = "mismatch"
VERDICT_INCONCLUSIVE = "inconclusive"
VERDICT_UNAVAILABLE = "unavailable"

REASON_MATCH = "target-agrees-with-reference-ensemble"
REASON_MISMATCH = "target-diverges-from-reference-ensemble"
REASON_NO_ENSEMBLE = "no-reference-ensemble"
REASON_INSUFFICIENT = "insufficient-ensemble"
REASON_BELOW_FLOOR = "agreement-below-match-floor"
REASON_TOO_LARGE = "reference-ensemble-too-large"

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


# ---------------------------------------------------------------------------
# Canonicalization and digests
# ---------------------------------------------------------------------------


def canonical_json_bytes(value) -> bytes:
    """Canonical JSON encoding: sorted keys, no whitespace, raw UTF-8.

    This matches the client bridge's ``canonicalBytes`` logic
    (composition/w6-verifier-bridge.mjs:42-56) for the ASCII-only identity
    fields this worker digests (identifiers are constrained to
    ``[A-Za-z0-9_.:-]``; profile digests are lowercase hex), so digests are
    reproducible across the Node and Python sides.
    """
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def output_digest(text: str) -> str:
    """SHA-256 (hex) over the exact UTF-8 bytes of an output string."""
    if not isinstance(text, str):
        raise TypeError("output_digest expects str")
    return sha256_hex(text.encode("utf-8"))


def request_digest(
    *,
    version: int,
    kind: str,
    request_id: str,
    provider_id: str,
    profile_sha256,
) -> str:
    """SHA-256 (hex) of the canonical observation identity.

    The identity is the subset of the bridge's ``observe`` frame that names the
    request (``w6-verifier-bridge.mjs:391-416`` normalizes it)::

        {"version": 1, "kind": "ordinary", "request_id": "...",
         "provider_id": "...", "profile_sha256": "..." | null}

    ``response_text`` is deliberately NOT part of the identity; it is digested
    separately as ``output_digest`` so the reference bank is keyed by request
    and the submitted output is compared against it.
    """
    identity = {
        "version": version,
        "kind": kind,
        "request_id": request_id,
        "provider_id": provider_id,
        "profile_sha256": profile_sha256,
    }
    return sha256_hex(canonical_json_bytes(identity))


# ---------------------------------------------------------------------------
# Exact binomial tails
# ---------------------------------------------------------------------------


def _as_fraction(value, *, name: str) -> Fraction:
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a number, got {type(value).__name__}")
    if isinstance(value, int):
        return Fraction(value)
    if value != value or value in (float("inf"), float("-inf")):  # NaN/inf
        raise ValueError(f"{name} must be finite")
    # Fraction(str(float)) recovers the intended decimal (0.05 -> 1/20) rather
    # than the exact binary expansion, keeping comparisons intuitive.
    return Fraction(str(value))


def exact_binomial_tails(k: int, n: int, p0: Fraction) -> "tuple[Fraction, Fraction]":
    """Exact one-sided binomial tail probabilities for X ~ Binomial(n, p0).

    ``pLower = P(X <= k)`` and ``pUpper = P(X >= k)`` computed in exact rational
    arithmetic (``math.comb`` for the coefficients). Bounded: n is capped by
    ``MAX_REFERENCE_MEMBERS`` in ``ensemble_target_vs_rest``; this function
    itself is safe for any reasonable n.
    """
    if not 0 <= k <= n:
        raise ValueError(f"k must satisfy 0 <= k <= n, got k={k} n={n}")
    if not (0 <= p0 <= 1):
        raise ValueError(f"p0 must be in [0, 1], got {p0}")
    lower = Fraction(0)
    upper = Fraction(0)
    for i in range(n + 1):
        term = Fraction(
            comb(n, i) * (p0.numerator ** i) * ((p0.denominator - p0.numerator) ** (n - i)),
            p0.denominator ** n,
        )
        if i <= k:
            lower += term
        if i >= k:
            upper += term
    return lower, upper


def _rational_str(value: Fraction) -> str:
    return f"{value.numerator}/{value.denominator}"


# ---------------------------------------------------------------------------
# The ensemble target-vs-rest test
# ---------------------------------------------------------------------------


def ensemble_target_vs_rest(
    reference_digests,
    target_digest: str,
    *,
    alpha=DEFAULT_ALPHA,
    agreement_floor=DEFAULT_AGREEMENT_FLOOR,
    min_members=DEFAULT_MIN_MEMBERS,
    chance_floor=DEFAULT_CHANCE_FLOOR,
) -> dict:
    """Run the target-vs-rest agreement test and return a deterministic report.

    Parameters
    ----------
    reference_digests:
        Sequence of 64-hex SHA-256 digests of the reference outputs. Duplicates
        are meaningful: they are how agreement groups form.
    target_digest:
        64-hex SHA-256 digest of the output under audit.

    Returns
    -------
    dict with keys: ``test``, ``verdict``, ``reason``, ``n``, ``k``,
    ``largestGroup``, ``agreement`` (float or None), ``p0``, ``p0Rational``,
    ``pLower``, ``pLowerExact``, ``pUpper``, ``pUpperExact``, ``alpha``,
    ``agreementFloor``, ``minMembers``, ``chanceFloor``. All values are
    deterministic functions of the inputs.
    """
    alpha_f = _as_fraction(alpha, name="alpha")
    floor_f = _as_fraction(agreement_floor, name="agreement_floor")
    chance_f = _as_fraction(chance_floor, name="chance_floor")
    if not (0 < alpha_f < 1):
        raise ValueError(f"alpha must be in (0, 1), got {alpha}")
    if not (0 < floor_f <= 1):
        raise ValueError(f"agreement_floor must be in (0, 1], got {agreement_floor}")
    if not isinstance(min_members, int) or isinstance(min_members, bool) or min_members < 1:
        raise ValueError(f"min_members must be a positive integer, got {min_members!r}")
    if not (0 <= chance_f <= 1):
        raise ValueError(f"chance_floor must be in [0, 1], got {chance_floor}")

    if not isinstance(target_digest, str) or not _HEX64.match(target_digest):
        raise ValueError("target_digest must be a lowercase 64-hex sha256 string")

    refs = list(reference_digests or [])
    for index, digest in enumerate(refs):
        if not isinstance(digest, str) or not _HEX64.match(digest):
            raise ValueError(f"reference_digests[{index}] must be a lowercase 64-hex sha256 string")

    report = {
        "test": TEST_ID,
        "verdict": VERDICT_INCONCLUSIVE,
        "reason": REASON_NO_ENSEMBLE,
        "n": len(refs),
        "k": 0,
        "largestGroup": 0,
        "agreement": None,
        "p0": None,
        "p0Rational": None,
        "pLower": None,
        "pLowerExact": None,
        "pUpper": None,
        "pUpperExact": None,
        "alpha": float(alpha_f),
        "agreementFloor": float(floor_f),
        "minMembers": min_members,
        "chanceFloor": float(chance_f),
    }

    n = len(refs)
    if n == 0:
        return report
    if n > MAX_REFERENCE_MEMBERS:
        report["verdict"] = VERDICT_UNAVAILABLE
        report["reason"] = REASON_TOO_LARGE
        return report

    counts = {}
    for digest in refs:
        counts[digest] = counts.get(digest, 0) + 1
    k = counts.get(target_digest, 0)
    largest_group = max(counts.values())

    p0 = Fraction(largest_group + 1, n + 2)  # Laplace-smoothed rest agreement
    if chance_f > p0:
        p0 = chance_f

    p_lower, p_upper = exact_binomial_tails(k, n, p0)

    report.update(
        {
            "k": k,
            "largestGroup": largest_group,
            "agreement": k / n,
            "p0": float(p0),
            "p0Rational": _rational_str(p0),
            "pLower": float(p_lower),
            "pLowerExact": _rational_str(p_lower),
            "pUpper": float(p_upper),
            "pUpperExact": _rational_str(p_upper),
        }
    )

    if n < min_members:
        report["verdict"] = VERDICT_INCONCLUSIVE
        report["reason"] = REASON_INSUFFICIENT
    elif p_lower < alpha_f:
        report["verdict"] = VERDICT_MISMATCH
        report["reason"] = REASON_MISMATCH
    elif Fraction(k, n) >= floor_f:
        report["verdict"] = VERDICT_MATCH
        report["reason"] = REASON_MATCH
    else:
        report["verdict"] = VERDICT_INCONCLUSIVE
        report["reason"] = REASON_BELOW_FLOOR
    return report
