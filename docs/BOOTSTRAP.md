# Bootstrap verification

This is verification of the setup/contract scaffold only, not the application.

- Node 20.19.5 / npm 10.8.2 used locally.
- Shared Request validation, canonical hashing and state separation tests were exercised RED:
  six behavioral failures against a temporary non-enforcing implementation, then GREEN.
- Assessment-event required metadata check was exercised RED, then fixed in the schema.
  Ajv strict schema compilation rejected the initial conditional; properties were declared in
  conditional branches rather than disabling strict validation.
- Final `npm run check`: 22 contract/schema-example tests passed, layout check passed,
  and 2 gate-controller tests passed. Gate-controller tests use tiny isolated Git/package
  fixtures, not fake application results. These are retrospective controller verification.
- `npm --prefix packages/contracts audit --audit-level=moderate`: zero vulnerabilities reported.
  The initial Ajv 8.17.1 advisory was resolved by pinning 8.20.0; lockfile retained.
- `npm run check:all` correctly failed for all five absent application implementations.
  That expected failure guards against treating the bootstrap as component readiness.
- Citation checks passed for SPONSORS.md and GOALS.md. Sponsor constraints are snapshots,
  not a final eligibility ruling.

No Mycelium/Gas Killer source or processes changed. No models run/downloaded. No public
contract deployment/payment/Graph publication performed. Repository is private at setup;
public visibility, license and live qualification remain explicit user gates.

Each implementation lane must create its own real tests, production-path smoke, evidence,
provenance and local commits. See RELEASE.md and the individual lane briefs.
