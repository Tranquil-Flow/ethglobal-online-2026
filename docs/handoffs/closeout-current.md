# Current local closeout evidence

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
