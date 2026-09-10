# Mycelium hackathon application

## Current managed application (v2)

The checker-independent application supports independently configured provider identities, signed offers, optional ENSv2 discovery, scoped non-economic access, encrypted same-attempt recovery, open attributed history and private operator backup/restore. Native execution needs explicit accepted pins and a fresh owner grant; absent checking does not block ordinary serving. Protected paid mode remains refused.

```sh
npm run setup
npm run demo:application
```

The finite demo uses two synthetic provider identities and closes its owned services. For persistent init/doctor/start/stop and optional TLS/ENS/Graph configuration, use [Application quickstart](docs/APPLICATION_QUICKSTART.md). See [recovery and portability](docs/APPLICATION_PORTABILITY.md), [R1–R12 completion/evidence ledger](docs/APPLICATION_COMPLETION.md), and [literal verification integration boundary](docs/VERIFICATION_INTEGRATION.md). The final adjacent handoff binds the exact accepted commit; historical external receipts are not current approval.

## Preserved earlier workbench (v1)

A composed service for named provider discovery, bounded quotes, explicit payment authorization, streamed jobs, signed private receipts, evidence replay, consented publication and history-informed provider selection. HTTP, SDK, CLI, MCP and browser use the same retained jobs.

**Execution is an explicit deterministic staged simulator, not inference.** It computes and streams real lightweight results. It does not contact Mycelium, Gas Killer, models or a fleet. Simulation uses synthetic payments without funds and real **local** ENS/EVM/Graph infrastructure; simulated assessments do not enter the public qualification dataset.

## Run the complete local workbench

Use repository-pinned **Node 22.22.2 / npm 10.9.7** (`.nvmrc`, runtime guard). Docker must be running for local ENS/Graph. Install and run using the same Node/native ABI.

```sh
npm run setup
npm run start:workbench
```

Open the printed URL. The example config is `composition/workbench.example.json`: two explicitly named providers, private persistent state, bounded prices and no injected faults. Connect, discover, quote, authorize, submit, stream, verify receipt integrity, replay and inspect publication. Stop with Ctrl-C. Reuse the same config/data directory to resume retained jobs.

[Configuration, client commands, privacy, TLS, backup and live binding contract](docs/WORKBENCH.md).

## Verify

```sh
npm run check:all
npm run smoke:integration
npm run check:operations
npm --prefix packages/indexing run smoke:ingestion
```

Canonical integration includes the actual local Graph feedback loop: a deliberately divergent provider receives a mismatching replay assessment; that consented indexed evidence changes the next provider decision. Tests also cover cancellation, uncertainty/deduplication, private deletion, restart, CLI/MCP/Chromium consumption, encrypted backup and certificate-pinned local TLS.

[Current implementation checklist](docs/WORKBENCH-IMPLEMENTATION.md) distinguishes implemented functionality from final candidate verification. Historical failures and earlier exact-candidate receipts remain under `docs/handoffs/` and local `artifacts/closeout/`.

## Boundaries

- Receipt integrity, execution, payment, replay assessment and publication are separate states. A simulator match is not proof of inference correctness or physical distribution.
- Replay requires authorized private evidence and explicit key pins. Same-owner reexecution is not independently operated verification. Publication requires request-bound consent; deletion cannot erase public commitments.
- Historical testnet payment/ENS/registry/hosted-Graph packets exist separately. They have not requalified the v2 candidate or renewed public-action authority. Local simulation does not qualify a real runtime.
- Live startup requires explicitly injected runtime, exact profiles and signing authorities, and fails closed if missing. [Mycelium mapping and physical qualification](docs/MYCELIUM-ADAPTER.md) remain unverified.
- No bonds, slashing, bounty markets, random-audit service or Gas Killer integration is offered. Public exposure, source pushes, licensing/visibility changes and submission remain approval-gated.

[Architecture](docs/ARCHITECTURE.md) · [Ports](docs/PORTS.md) · [HTTP](docs/HTTP.md) · [Provenance](docs/PROVENANCE.md) · [Release policy](docs/RELEASE.md)

The earlier thin offline fixture remains available with `npm start -- --development --data-dir PATH --port PORT`; it is not the full simulator/ENS/Graph workbench above.
