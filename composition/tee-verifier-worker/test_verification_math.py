"""Deterministic unit tests for the W6 tee-verifier-worker verification math.

Run (hermetic, stdlib unittest only — no pytest plugins, no PYTHONPATH):

    env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \\
      /opt/homebrew/bin/python3.14 -I -B test_verification_math.py -v

Covers:
  * digest/canonicalization known-answer vectors (incl. a hand-built canonical
    JSON byte string so `request_digest` is not tested against itself);
  * exact binomial tail correctness against hand-derived fractions and against
    a brute-force enumeration for a small ensemble;
  * every decision-rule branch of the target-vs-rest test, including the
    alpha and chance_floor knobs, insufficient/oversized ensembles and
    determinism;
  * worker config fail-closed behavior (bearer required, TLS required for
    non-loopback, param validation).
"""

from __future__ import annotations

import hashlib
import os
import sys
import unittest
from fractions import Fraction

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import tee_verifier_math as m  # noqa: E402
import tee_verifier_worker as worker  # noqa: E402

PROFILE_SHA = "a" * 64
PROVIDER = "tee-worker-test-provider"

D_HONEST = hashlib.sha256(b"honest answer: 42").hexdigest()
D_ALT = hashlib.sha256(b"alternate answer").hexdigest()
D_ATTACK = hashlib.sha256(b"demo attacker").hexdigest()


class DigestVectorTests(unittest.TestCase):
    def test_output_digest_empty_string_known_vector(self):
        # sha256("") — RFC 6234 well-known value.
        self.assertEqual(
            m.output_digest(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )

    def test_output_digest_matches_independent_hashlib_computation(self):
        for text in ("honest answer: 42", "demo attacker", "héllo wörld ✓"):
            self.assertEqual(
                m.output_digest(text),
                hashlib.sha256(text.encode("utf-8")).hexdigest(),
            )

    def test_canonical_json_bytes_sorted_and_compact(self):
        self.assertEqual(
            m.canonical_json_bytes({"b": 1, "a": {"d": 2, "c": 3}}),
            b'{"a":{"c":3,"d":2},"b":1}',
        )

    def test_request_digest_against_hand_built_canonical_bytes(self):
        # Hand-built canonical identity (sorted keys, compact separators) — an
        # independent formulation of the documented digest recipe.
        expected = hashlib.sha256(
            (
                '{"kind":"ordinary","profile_sha256":"' + PROFILE_SHA + '",'
                '"provider_id":"p1","request_id":"r1","version":1}'
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(
            m.request_digest(
                version=1,
                kind="ordinary",
                request_id="r1",
                provider_id="p1",
                profile_sha256=PROFILE_SHA,
            ),
            expected,
        )

    def test_request_digest_binds_identity_fields(self):
        base = dict(
            version=1,
            kind="ordinary",
            request_id="r1",
            provider_id="p1",
            profile_sha256=PROFILE_SHA,
        )
        digest = m.request_digest(**base)
        for override in (
            {"provider_id": "p2"},
            {"request_id": "r2"},
            {"profile_sha256": "b" * 64},
            {"profile_sha256": None},
            {"kind": "audit"},
            {"version": 2},
        ):
            self.assertNotEqual(digest, m.request_digest(**{**base, **override}))
        self.assertEqual(
            m.request_digest(
                version=1, kind="ordinary", request_id="r1",
                provider_id="p1", profile_sha256=PROFILE_SHA,
            ),
            digest,
            "request_digest must be deterministic",
        )


class ExactBinomialTailTests(unittest.TestCase):
    def test_unanimous_three_member_tails_hand_derived(self):
        p0 = Fraction(4, 5)
        self.assertEqual(m.exact_binomial_tails(0, 3, p0), (Fraction(1, 125), Fraction(1)))
        self.assertEqual(m.exact_binomial_tails(1, 3, p0), (Fraction(13, 125), Fraction(124, 125)))
        self.assertEqual(m.exact_binomial_tails(2, 3, p0), (Fraction(61, 125), Fraction(112, 125)))
        self.assertEqual(m.exact_binomial_tails(3, 3, p0), (Fraction(1), Fraction(64, 125)))

    def test_tails_consistent_with_point_mass(self):
        p0 = Fraction(3, 7)
        n = 5
        for k in range(n + 1):
            lower, upper = m.exact_binomial_tails(k, n, p0)
            point = lower - (m.exact_binomial_tails(k - 1, n, p0)[0] if k else Fraction(0))
            self.assertEqual(lower + upper - point, Fraction(1), f"n={n} k={k}")

    def test_tails_match_brute_force_enumeration(self):
        # Independent formulation: enumerate all 2^n outcome subsets and sum
        # the probabilities directly.
        p0 = Fraction(3, 7)
        n = 5
        mass = {}
        for mask in range(2 ** n):
            k = bin(mask).count("1")
            mass[k] = mass.get(k, Fraction(0)) + (p0 ** k) * ((1 - p0) ** (n - k))
        for k in range(n + 1):
            lower, upper = m.exact_binomial_tails(k, n, p0)
            self.assertEqual(lower, sum(mass[i] for i in range(k + 1)), f"k={k}")
            self.assertEqual(upper, sum(mass[i] for i in range(k, n + 1)), f"k={k}")

    def test_out_of_range_k_rejected(self):
        with self.assertRaises(ValueError):
            m.exact_binomial_tails(4, 3, Fraction(1, 2))


class EnsembleDecisionVectorTests(unittest.TestCase):
    def run_test(self, references, target, **kwargs):
        return m.ensemble_target_vs_rest(references, target, **kwargs)

    def test_unanimous_references_target_matches(self):
        report = self.run_test([D_HONEST, D_HONEST, D_HONEST], D_HONEST)
        self.assertEqual(report["verdict"], m.VERDICT_MATCH)
        self.assertEqual(report["reason"], m.REASON_MATCH)
        self.assertEqual((report["n"], report["k"], report["largestGroup"]), (3, 3, 3))
        self.assertEqual(report["agreement"], 1.0)
        self.assertEqual(report["p0Rational"], "4/5")
        self.assertEqual(report["pLowerExact"], "1/1")
        self.assertEqual(report["pUpperExact"], "64/125")
        self.assertEqual(report["test"], m.TEST_ID)

    def test_unanimous_references_attacker_output_mismatch(self):
        report = self.run_test([D_HONEST, D_HONEST, D_HONEST], D_ATTACK)
        self.assertEqual(report["verdict"], m.VERDICT_MISMATCH)
        self.assertEqual(report["reason"], m.REASON_MISMATCH)
        self.assertEqual(report["k"], 0)
        self.assertEqual(report["p0Rational"], "4/5")
        self.assertEqual(report["pLowerExact"], "1/125")
        self.assertAlmostEqual(report["pLower"], 0.008, places=12)

    def test_unanimous_references_two_of_three_matches(self):
        report = self.run_test([D_HONEST, D_HONEST, D_ALT], D_HONEST)
        self.assertEqual(report["verdict"], m.VERDICT_MATCH)
        self.assertEqual(report["p0Rational"], "3/5")
        self.assertAlmostEqual(report["agreement"], 2 / 3, places=12)
        self.assertEqual(report["pLowerExact"], "98/125")

    def test_minority_target_is_inconclusive_not_match(self):
        report = self.run_test([D_HONEST, D_HONEST, D_ALT], D_ALT)
        self.assertEqual(report["verdict"], m.VERDICT_INCONCLUSIVE)
        self.assertEqual(report["reason"], m.REASON_BELOW_FLOOR)
        self.assertEqual(report["k"], 1)
        self.assertEqual(report["pLowerExact"], "44/125")

    def test_insufficient_ensemble_is_inconclusive(self):
        report = self.run_test([D_HONEST, D_ALT], D_HONEST)
        self.assertEqual(report["verdict"], m.VERDICT_INCONCLUSIVE)
        self.assertEqual(report["reason"], m.REASON_INSUFFICIENT)
        self.assertEqual(report["n"], 2)

    def test_no_references_is_inconclusive(self):
        report = self.run_test([], D_HONEST)
        self.assertEqual(report["verdict"], m.VERDICT_INCONCLUSIVE)
        self.assertEqual(report["reason"], m.REASON_NO_ENSEMBLE)
        self.assertIsNone(report["agreement"])

    def test_oversized_ensemble_is_unavailable(self):
        report = self.run_test([D_HONEST] * (m.MAX_REFERENCE_MEMBERS + 1), D_HONEST)
        self.assertEqual(report["verdict"], m.VERDICT_UNAVAILABLE)
        self.assertEqual(report["reason"], m.REASON_TOO_LARGE)

    def test_max_sized_ensemble_is_usable(self):
        report = self.run_test([D_HONEST] * m.MAX_REFERENCE_MEMBERS, D_HONEST)
        self.assertEqual(report["verdict"], m.VERDICT_MATCH)
        self.assertEqual(report["n"], m.MAX_REFERENCE_MEMBERS)

    def test_alpha_knob_controls_divergence_verdict(self):
        # pLower = 1/125 = 0.008: < 0.05 -> mismatch; >= 0.005 -> not divergent,
        # and 0/3 is below the agreement floor -> inconclusive.
        strict = self.run_test([D_HONEST, D_HONEST, D_HONEST], D_ATTACK, alpha=0.05)
        lax = self.run_test([D_HONEST, D_HONEST, D_HONEST], D_ATTACK, alpha=0.005)
        self.assertEqual(strict["verdict"], m.VERDICT_MISMATCH)
        self.assertEqual(lax["verdict"], m.VERDICT_INCONCLUSIVE)

    def test_chance_floor_knob_raises_null_rate(self):
        # All-distinct references: Laplace p0 = 2/5, P(X<=0 | p0=2/5) = 0.216
        # (not divergent). With chance_floor = 0.8 the same observation is
        # divergent at alpha = 0.05 (P = 0.008).
        refs = [D_HONEST, D_ALT, m.output_digest("third")]
        default = self.run_test(refs, D_ATTACK)
        raised = self.run_test(refs, D_ATTACK, chance_floor=0.8)
        self.assertEqual(default["verdict"], m.VERDICT_INCONCLUSIVE)
        self.assertEqual(default["p0Rational"], "2/5")
        self.assertEqual(raised["verdict"], m.VERDICT_MISMATCH)
        self.assertEqual(raised["p0Rational"], "4/5")

    def test_report_is_deterministic(self):
        args = ([D_HONEST, D_HONEST, D_ALT], D_HONEST)
        self.assertEqual(self.run_test(*args), self.run_test(*args))

    def test_invalid_inputs_rejected(self):
        with self.assertRaises(ValueError):
            self.run_test([D_HONEST], "not-a-digest")
        with self.assertRaises(ValueError):
            self.run_test(["NOTHEX"], D_HONEST)
        with self.assertRaises(ValueError):
            self.run_test([D_HONEST] * 3, D_HONEST, alpha=1.0)
        with self.assertRaises(ValueError):
            self.run_test([D_HONEST] * 3, D_HONEST, agreement_floor=0.0)
        with self.assertRaises(ValueError):
            self.run_test([D_HONEST] * 3, D_HONEST, min_members=0)


class WorkerConfigTests(unittest.TestCase):
    BASE = {
        "W6_TEE_VERIFIER_BEARER": "synthetic-test-bearer",
        "W6_TEE_VERIFIER_ALLOW_PLAINTEXT": "1",
        "W6_TEE_VERIFIER_HOST": "127.0.0.1",
    }

    def test_bearer_is_required(self):
        env = {k: v for k, v in self.BASE.items() if k != "W6_TEE_VERIFIER_BEARER"}
        with self.assertRaises(worker.ConfigError):
            worker.Config(env)

    def test_non_loopback_plaintext_refused(self):
        env = {**self.BASE, "W6_TEE_VERIFIER_HOST": "0.0.0.0"}
        with self.assertRaises(worker.ConfigError):
            worker.Config(env)

    def test_plaintext_requires_explicit_opt_in(self):
        env = {k: v for k, v in self.BASE.items() if k != "W6_TEE_VERIFIER_ALLOW_PLAINTEXT"}
        with self.assertRaises(worker.ConfigError):
            worker.Config(env)

    def test_tls_pair_must_be_complete(self):
        env = {**self.BASE, "W6_TEE_VERIFIER_TLS_CERT": "/tmp/nope.pem"}
        with self.assertRaises(worker.ConfigError):
            worker.Config(env)

    def test_tls_config_without_plaintext_flag_is_valid(self):
        env = {
            "W6_TEE_VERIFIER_BEARER": "synthetic-test-bearer",
            "W6_TEE_VERIFIER_TLS_CERT": "/tmp/nope.pem",
            "W6_TEE_VERIFIER_TLS_KEY": "/tmp/nope.key",
        }
        config = worker.Config(env)
        self.assertFalse(config.plaintext)
        self.assertEqual(config.port, 8443)

    def test_param_validation(self):
        with self.assertRaises(worker.ConfigError):
            worker.Config({**self.BASE, "W6_TEE_VERIFIER_ALPHA": "1.5"})
        with self.assertRaises(worker.ConfigError):
            worker.Config({**self.BASE, "W6_TEE_VERIFIER_MIN_MEMBERS": "0"})
        with self.assertRaises(worker.ConfigError):
            worker.Config({**self.BASE, "W6_TEE_VERIFIER_PORT": "not-a-port"})

    def test_verification_params_precedence(self):
        # env > bank > defaults
        config = worker.Config(self.BASE)
        bank = type("Bank", (), {"params": {"alpha": 0.01}})()
        self.assertEqual(worker._verification_params(config, bank)["alpha"], 0.01)
        env_config = worker.Config({**self.BASE, "W6_TEE_VERIFIER_ALPHA": "0.02"})
        self.assertEqual(worker._verification_params(env_config, bank)["alpha"], 0.02)


class InlineReferenceParsingTests(unittest.TestCase):
    def test_inline_references_accept_text_and_digest(self):
        parsed = worker._parse_inline_references(
            [
                {"member": "ref-0", "output_text": "honest answer: 42"},
                {"member": "ref-1", "output_digest": D_HONEST},
                {"output_text": "honest answer: 42"},  # member defaulted
            ]
        )
        self.assertEqual([row["digest"] for row in parsed], [D_HONEST, D_HONEST, D_HONEST])
        self.assertEqual(parsed[2]["member"], "inline-2")

    def test_inline_references_reject_malformed(self):
        for value in ([], [{}], [{"member": "r", "output_digest": "xyz"}], "nope"):
            with self.assertRaises(worker.WorkerOpError):
                worker._parse_inline_references(value)

    def test_observe_response_validation(self):
        good = {
            "version": 1, "kind": "ordinary", "request_id": "r1",
            "provider_id": "p1", "profile_sha256": PROFILE_SHA, "response_text": "x",
        }
        worker._validate_observe_response(good)
        for bad in (
            {**good, "version": 2},
            {**good, "kind": "audit"},
            {**good, "request_id": "bad id!"},
            {**good, "provider_id": ""},
            {**good, "profile_sha256": "short"},
            {**good, "response_text": 3},
        ):
            with self.assertRaises(worker.WorkerOpError):
                worker._validate_observe_response(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
