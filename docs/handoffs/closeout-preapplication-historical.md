# Current external qualification closeout

The authorized Hedera/Blocky402, canonical ENSv2 Sepolia and free hosted Graph
technical qualification is complete. `external-qualification.md`,
`hedera-qualification.json`, `ens-qualification.json` and
`graph-studio-deployment.json` retain public transaction and consumption evidence.
The exact final candidate, clean-worktree checks, seven command exits and log hashes
are in `artifacts/closeout/external-final-verification.json`. Reproduce external
reads and the non-paying loopback quote decision with
`node scripts/revalidate-testnet.mjs`; this command never loads transaction keys.

The first fresh attempt failed because all three required pinned Docker images
were absent. Its original receipts/logs are preserved under
`artifacts/closeout/external-final-attempt-1/`. The registry manifests established
315,164,663 compressed download bytes; only those exact images were restored.
The unchanged candidate then passed setup, check:all, separate integration smoke,
three repeat smokes and external revalidation. No tests were skipped or relaxed,
and unrelated containers/volumes were not modified.

This proves testnet integrations and deterministic non-inference consumption, not
public inference hosting, inference correctness, sponsor eligibility or submission.
No source push, paid hosting, mainnet or Mycelium/Gas Killer operation occurred.

## Historical local-only closeout evidence

Tested code revision: `a4b48df9af9bb291d23a877661499132570293ef`.
Fresh owned checkout: `ethglobal-online-2026-verify-a4b48df`.
Runtime: Node 22.22.2 / npm 10.9.7 on macOS arm64.

Observed exit status **0** for documented `npm run setup`; then for each of
core, payments, discovery, indexing and access, separately:

```
npm --prefix packages/<lane> run check
npm --prefix packages/<lane> run smoke
```

Observed exit status **0** for separate `npm run smoke:integration`, exercising
actual local ENSv2 + EVM + Graph Node, History decisions and reorg recovery,
SDK/CLI/MCP/browser composition, native payment test transports, private-state
backup/restore and explicit development executor injection. No model ran.

Raw local evidence under `artifacts/closeout/`: `fresh-a4b48df-setup.log`,
`fresh-a4b48df-<lane>-<check|smoke>.log`, `fresh-a4b48df-lanes.json` and
`fresh-a4b48df-integration.log`.
Prior handoffs and earlier commands remain in `archive/pre-closeout-*.json`;
they are not evidence for this revision. Current acceptance mappings refer to
the current complete package checks, smokes and combined application rather
than historical environment-specific aliases.

No hosted CI, live sponsor qualification, Mycelium execution, Gas Killer
compatibility or public release approval is established. The revision-bound
full gate and final-candidate repeated smoke receipt remain separate from
these prerequisite package results.

## Discovery correction: `04391f596e9a3cdeae48fc0f2f70edd65f7a6a77`

The subsequent fresh full gate rejected real History-driven selection. Diagnostic
`artifacts/closeout/graph-selection-diagnostic.log` proved History was fresh but
selection labelled it stale: its clock had been captured before awaiting History.
The deterministic regression fails on the prior implementation and passes when
History and observation ages use the post-response clock. Future-date rejection
is preserved. The initial block-time hypothesis was disproved and its test-wait
change reverted, restoring the original selection oracle.

Current discovery check and smoke both exited 0 (`discovery-response-clock-green.log`);
actual local-service composition exited 0 after removing the false-hypothesis wait
(`response-clock-original-oracle.log`). These logs are under `artifacts/closeout/`.
Other package code is unchanged from the fresh prerequisite verification above.

## Full clean-candidate closure

`af665e0cf18889a2445c388e9d54d7548939eea6` passed fresh owned-checkout setup,
`npm run check:all`, separate `npm run smoke:integration`, and three further
integration smokes, each exit 0. The verification checkout was clean afterward.
`verified-code.json` retains log hashes and claim boundaries. Subsequent closeout
documentation changes do not modify package or composition code. The final documentation
candidate is checked separately; its receipt is `artifacts/closeout/final-verification.json`.
## Application foundation closure: `7cde8c1ec03391cc80d0d3d1160cc77c6b6638ae`

The Session B foundation implementation commit `7cde8c1ec03391cc80d0d3d1160cc77c6b6638ae` is the tested package/composition source revision for the updated core and access handoffs. It was committed before final component gates. Foundation receipts and logs are retained outside the tracked checkout under `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/logs/` and indexed in `/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/SAFE-LOG-INDEX.json`; the compact tracked summary is `docs/handoffs/foundation-verification.json`.

Observed exit status **0** for:

```text
npm --prefix packages/core run check
npm --prefix packages/core run smoke
npm --prefix packages/access run check
npm --prefix packages/access run smoke
npm run smoke:integration
npm run check:operations
node --test composition/test/mycelium-v3-journey.test.mjs
```

The root `npm run check:all` initially returned exit 1 because the core/access handoff JSON still pointed at older tested revisions (`implementation differs from tested revision`) even though the composition TAP output showed 101/101 passing. This documentation-only closure updates those handoff revision pointers without changing implementation bytes. Live wallet/Graph public external qualifications are not requalified by this foundation scope; they remain historical/external, not current proof of real-model execution or public readiness.
