# External gates and future adapter onboarding

Local integration authority does not grant any of the approvals below. No public deployment,
transaction, spending, push, visibility or license change was made. Mycelium/Gas Killer and real
replay are excluded, not blocked tasks to quietly implement. Historical handoffs are retained; `docs/COMPLETION.md` and
`docs/handoffs/closeout-current.md` hold the current local disposition.

## One consolidated approval packet (owner: Evi)

| Gate | Required decision/input | Observable completion, after approval |
|---|---|---|
| Track/pool/eligibility | Confirm Classic/Continuity, sponsor eligibility, pre-existing work and AI rules with organizers | Written eligibility basis tied to actual reuse/provenance; repo creation is not proof |
| Source publication | Select license; approve exact visibility/push/release scope | Reviewed license compatibility, approved public commit/URL; no agent-chosen license |
| Funded testnet payments | Explicit Hedera testnet payer/receiver authority, provisioned operator callback, exact per-action/total budget and approved service | Real Blocky402/Hedera paid request + transaction/mirror evidence + actual consumed service; local simulated consensus does not count |
| ENSv2 Sepolia write | Approved owned name/parent/registry, public owner/delegate addresses, wallet authority, exact preview and budget | Authorized update, transaction receipt, before/after real resolver change and revocation check |
| Registry / Graph deployment | Approved Sepolia registry deployment/publisher, start block/code hash, Graph project/provider and designated credential source, budget | Deployed contract+index receipts, actual fresh query with provenance and meaningful combined client decision |
| Public demo/submission | Review final exact code, security/dependency/runtime posture, actual human contributions and demo narrative | Human-approved truthful demo/submission; no public submission automatically |

Do not send signing secrets in chat. After scoped approval, use a designated operator-managed wallet
and explicit signing interface. Never search sibling repositories or messages for credentials.
Optional HCS publication and refunds need their **own** exact action approval; they are not implied.

## Independent pre-public engineering qualification (not claimed complete)

- Node 22.22.2 / npm 10.9.7 is the maintained local pin; native rebuild/load and full
  clean-checkout gates pass. Other operating systems remain unqualified.
- Indexing runtime-only npm audit is clean for the recorded candidate. Eight development-tool
  findings remain, including one critical archive-extraction dependency. See CLOSEOUT-OPERATIONS.md
  for concrete exposure, pinned remediation and restrictions; no blanket security certification.
- Execute hosted CI after an approved push. The local clean-checkout result does not establish a
  GitHub runner result. Linux/Windows setup and multi-host/database coordination are unqualified.
- Live configuration, independent key trust/distribution, rate limits/TLS and operational backup
  recovery need production-specific review. A loopback app does not qualify internet operation.

These do not block the agreed **local synthetic application** milestone, but do block a production
readiness claim. No external credential can substitute for these engineering gates.

## Versioned onboarding instructions

1. Read AGENTS.md, ARCHITECTURE/PORTS/HTTP/RELEASE and the integration receipt. Verify the exact
   candidate and all lane histories; preserve historical handoffs and the immutable bootstrap tag.
2. Keep each package independent: import actual factories only in composition and inject ports into
   core/discovery. Constructors must not discover secrets, open public listeners or broadcast.
3. Payments: use `createPayments`, native `headerPolicy`, a retained durable payment store and the
   explicitly configured real facilitator/mirror/operator callback. Keep quote/principal/request/key
   binding. Exact quote-resource URLs are accepted by access without relaxing origin/quote checks.
4. Discovery: replace only the explicitly synthetic resolver with the pinned supported ENSv2
   onchain resolver/config. Supply `history`; no prompt fan-out or arbitrary fetched endpoints.
5. Indexing: use `createGraphClient`/`createHistory` with verified deployment metadata and actual
   provider endpoint. Enable `createEventSink` only with authorized signer, durable journal, exact
   deployment identity and limits. Core remains responsible for consent/outbox; events are claims.
6. Do not reuse `composition/synthetic.mjs` as live infrastructure. Its Graph deployment identifier,
   block hashes, balances and consensus records are intentionally synthetic, clearly labelled.
7. Execution/Assessment: keep development executor and absent assessor in this scope. Mycelium,
   Gas Killer, physical inference and independent replay require a **new explicit task** with
   versioned profile/adapter contracts and actual qualification; no relabelling synthetic success.
8. Repeat failure/restart/price/header/privacy/browser gates and exact candidate checks before
   claiming any newly wired layer. Record real external handles, not synthetic substitutes.
