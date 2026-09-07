# Review addendum for already-running lanes

## Coordination
The user confirmed implementation sessions are already running. Their worktrees were NOT
updated. Keep your branch, existing code and bootstrap-v1 history; do not pull, merge, reset,
copy shared scripts into your checkout or change another lane. Read this addendum from the
immutable tag handoff-review-v1 using git show. Read that same tag's docs/PORTS.md,
docs/RELEASE.md and docs/lanes.json as the reviewed shared contract. Only implement changes
inside your already-owned package and handoff files. The integrating owner merges the gate
updates on main and revalidates combined work after writers finish.

## Review adjudication
The reviewer inspected an earlier snapshot. Worktree creation, profile lookup/catalog,
request-bound quote selection and tested-revision comparison were fixed before bootstrap-v1.
Those findings do not require rework. No new Mycelium/Gas Killer scope is added.
Remaining confirmed findings were an implicit payment-header seam and incomplete handoff coverage.

## Core and payments: explicit header policy
PaymentsPort exposes a readonly headerPolicy property {request:string[],response:string[]}.
Names are lowercase, based on the pinned real x402 SDK/version. Core reads this through the
injected port, not a sibling-package import or guessed header names. Reject authorization,
cookie/set-cookie, host, proxy-authorization and hop-by-hop names at startup. Copy only allowed
payment request fields into authorize; preserve bounded bytes, reject duplicates. Relay only
allowed payment response fields. Never give a session bearer/cookie to a facilitator or wallet
callback. Add production-boundary tests for malicious policy/header injection and preserved
legitimate payment challenge bytes. See reviewed PORTS.md for full definition.
Access must preserve real x402 challenge handling and never pass its original authenticated
request headers/session bearer to paymentAuthorizer. No new HTTP route is required by this change.

## Every lane: complete handoff evidence matrix
Use your lane's acceptanceIds and externalGateIds from the reviewed docs/lanes.json.
Do not edit your checkout's shared lanes.json or root gate scripts; record the required data
in your owned docs/handoffs/<lane>.json. Your existing local gate may not enforce these extra
fields yet; the integrating owner's updated gate will.

Required fields beyond lane/status/codeRevision/contractRequests:
- commands: [{id, command, exitCode:0, evidence}]. Evidence is a nonempty relative file inside
  your checkout; prefer committed docs/handoffs/<lane>.md with safe command outputs. No secrets.
- acceptanceCases: [{id, status:"passed", commandIds:[...], evidence}]. Cover every required ID;
  commandIds reference actual successful command records. Include all detailed brief acceptance
  cases under these IDs, not merely one happy-path test per label.
- externalGates: [{id, status:"qualified"|"blocked"|"inapplicable", reason, evidence?}]. Record
  every required ID. Qualified requires existing evidence containing verifiable external handles.
  Blocked is normal for unapproved live transactions/deployments. Mycelium/Gas Killer/replay
  exclusions may be inapplicable with the explicit current-scope reason, never "qualified".

These records must represent actual execution. File existence is not proof of truth; the owner
will inspect command coverage, evidence content and external references. Do not invent artifacts,
mark unknown gates qualified or silently omit them. Unknown approval stays blocked.

Continue the rest of your original goal autonomously; this is a small additive correction, not
permission to restart the project or broaden scope. Commit only your owned changes locally.

## Verification of the addendum machinery
Main's npm run check passed: 22 contract tests and 6 gate/handoff tests. New negative tests reject
missing acceptance coverage, omitted external gates, missing evidence, invented command references
and unsupported qualified claims. Tests use explicitly local fixtures, not live provider evidence.
