# Application v2 operator and developer quickstart

## Integration successor update (2026-09-11)

See `MANAGED_INTEGRATIONS.md` for the implemented managed publisher/budget/journal closure, hosted History RPC, private CLI/MCP pins and non-economic submission policy, provider payment factory, and method-neutral assessor/artifact lifecycle. These are exercised local integration paths, not a selected verifier or protected-finance release. Historical statements below about wholly missing adapters or wholly absent public deployments must not override this later source and its final receipt. The earlier native success and public Registry/Graph assets remain real; a new managed native start failed because A's advertised socket/processes were absent. Current real native/public qualification remains blocked on A's maintained binding/topology and any exact remaining activation authority. Do not infer completion until the adjacent `NONVERIFICATION-INTEGRATION-HANDOFF.json` binds final source and observed gates.


This is the verification-independent **non-economic** application. It runs without a checker, registry, wallet or payment service. `development` is synthetic echo, not inference. `live` means a native runtime is configured, not qualified correctness. Neither mode offers protected payment. v1 launcher/config/backups remain separate and supported; they are not silently migrated.

## Clean install and finite demo

Use Node **22.22.2**, npm **10.9.7**, a supported C/C++ build toolchain for the pinned SQLite/fs-ext native addons, and the versions in the committed lockfiles. From a clean exported application checkout:

```sh
npm run setup
npm run demo:application
```

Setup installs pinned package dependencies, exercises native addon loads, installs Chromium, builds the viewer and generates subgraph types. It does not load a model. The finite demo uses a fresh temporary private directory, two independently generated identities and the real core/access/storage services, then deletes only its temporary state. It emits JSON with `LOCAL_DEMO_PASSED` only after retained output and buyer-bound offline integrity checks pass. It does not perform public transactions, real inference or a computation check. Actual final setup/demo receipts are indexed by `docs/APPLICATION_COMPLETION.md`.

## Durable local operator lifecycle

Choose a private parent owned by your account. The target state directory must not already exist at initialization. Do not put it in a shared/synced repository.

```sh
npm run operator -- init --data-dir "$PRIVATE/mycelium-app" --provider alpha.local --provider beta.local
npm run operator -- doctor --config "$PRIVATE/mycelium-app/application.json"
npm run operator -- start --config "$PRIVATE/mycelium-app/application.json"
```

Open the returned loopback URL. The same URL serves browser and API routes. The generated `application.json` pins each provider/profile/runtime/key and bounded limits. `operator.json` binds each identity to a private key file and explicitly synthetic runtime descriptor. Both and all signing keys must be regular owner-only files; directories are private. Provider IDs are user-chosen, not a project-admin allowlist. Each provider has its own runtime database and receipt signer. Shared model aliases do not permit cross-provider failover.

Doctor performs offline configuration/identity checks. Its JSON distinguishes `networkContacted:false`, `modelLoaded:false`, `grantVerified:false`, and port availability checked at start. Start refuses occupied configured ports before provider creation, stale authority, mismatched runtime/profile/provider keys, unsafe private state, oversized queues and unsupported financial modes. It does not silently change requested mode. The underlying OS listener remains authoritative if another process races the preflight.

Use SIGINT or SIGTERM to stop the process. The service stops admitting work, cancels/drains owned tasks, checkpoints stores and releases its private lock. Keep the same directory and start command for restart. Do not delete `.application.lock` or copy a running SQLite database. Retained jobs, idempotency, recovery authority and historical public receipt keys are durable. Reusing a key ID for another key/provider is refused. A new receipt key needs a new key ID and explicit matching private-key config; old public verification keys remain in the core database.

Errors are safe machine-readable reasons plus human-readable text. Useful reasons include `PRIVATE_CONFIG_REQUIRED`, `PRIVATE_KEY_REQUIRED`, `INVALID_MANAGED_BINDING`, `RUNTIME_PROVIDER_CATALOG_MISMATCH`, `RUNTIME_MODE_MISMATCH`, `INVALID_CORE_LIMIT`, `PORT_UNAVAILABLE`, `PRIVATE_STATE_REQUIRED`, `DATASET_RUNTIME_MISMATCH`, `RECEIPT_KEY_REBOUND`, `PROTECTED_PAYMENT_UNAVAILABLE` and `OPERATOR_ACCESS_GRANT_REQUIRED`. A failure is not a request to disable a guard.

## Native runtime and native coalition onboarding

No private native state is managed by this app. Use the native project's reviewed `docs/swarm-multi-device-onboarding.md` and `docs/contracts/external-tester-boundary.md` from a pinned checkout. The inspected compatibility source is `79cf71ea9efe388de1f914f5630d35c8c54db7d2`; this pin is source inspection/local conformance, not a physical deployment claim. Application installation does not copy or edit native code.

The existing native primitives are:

- Initialize/start the durable seed with `python -m mycelium_seed` and a private seed state directory.
- Mint separate short-lived, mode-0600 invitation files with `scripts/mint_swarm_invites.py`. The tool verifies the live seed signer. This is a separately authorized network action, not doctor.
- Join each independently owned device with `python -m mycelium_node --join-bundle-file ...` and that device's own private identity/state. Never paste invitation tokens into a browser, chat, argument or log.
- Stop the seed before offline `scripts/manage_seed_membership.py inventory` / `revoke --node-id ... --expected-generation ... --reason operator_revoked`. A stale generation fails closed. Restart the same native seed state after completion.
- Native seed backup/restore and key rotation remain under the native maintenance runbook, not this application's backup archive.

Do not infer route activation from enrollment. Configured members, assigned participants and observed execution are distinct. Browser/probe/heartbeat evidence is not inference. Physical admission requires signed capabilities, placement/artifact/link qualification and the native route authority. The application only advertises the accepted pinned runtime endpoint; it cannot force another coalition to admit a node.

For each live application provider, replace its managed runtime descriptor with:

```json
{"kind":"mycelium","inputFile":"native/provider-input.json","grantFile":"native/grant.json","credentialFiles":{"credential-ref":"native/gateway-credential"}}
```

Paths are relative, under this private state root, and reject traversal/symlinks. Use `mycelium.workbench.operator.v2` for primary-only native access: omit the replay endpoint/origin and set `scope.maxReplayRequests` to `0`. Use the existing operator validation/schema source and `docs/VERIFICATION_INTEGRATION.md`, not this abbreviated descriptor as a fabricated complete native grant. Update `application.json` to live mode and its exact provider/profile/key/runtime digest pins. `bindingDigest` is the validated native input digest. No native numerical profile is inferred from a model alias.

Obtain the native owner's accepted profile/qualification/binding and scoped resource grant before start. Initialization never generates such a grant. Changing a runtime/profile under a directory with retained jobs fails dataset identity validation; use a new namespace and explicitly reconcile historical data instead of relabelling it. No generic module import, upstream model launcher, resident-service probing or automatic replay is needed for unchecked serving.

## Buyer/browser and SDK behavior

Choose provider and profile using the configured dropdowns, connect explicitly, discover the signed offer, inspect bounds/expiry, obtain a request-bound zero-value quote and submit. The signed offer's endpoint and key pins are checked. Same-origin supplied public keys are a availability path, not independent identity trust; obtain the expected provider key through a trusted channel for external deployment.

Only the admitted request semantics are supported. The OpenAI-compatible endpoint supports the declared single-user/no-tools/greedy profile, not arbitrary chat templates, logprobs or usage. Use the SDK's listed models rather than copying profile digests. Cancellation, transport refresh, evidence integrity and computation checking are separate operations. Output is provisional; a passed observational checker does not authorize money movement.

Private export contains original buyer context and evidence. Offline `checkBuyerEvidenceJson(text,pins,expected)` binds request/job/quote/payment identity and, when supplied, the complete output. It checks integrity, not inference. Server-side deletion does not erase already exported files or consented public claims. Do not publish low-entropy secret hashes as if automatically anonymous.

Recovery, backup and final integrated gate details are in `APPLICATION_COMPLETION.md` and `APPLICATION_PORTABILITY.md`. Submission/release requires the separate gates in the completion ledger; this quickstart is not approval to expose loopback services publicly.

## CLI/MCP offered-profile selection

Keep provider pins in a private JSON file obtained from the trusted operator. CLI sessions are scoped to the user's private home directory; use a separate OS home/profile for independent concurrent principals.

```sh
node packages/access/src/cli.mjs connect --base-url "$APP_URL" --pins-file "$PRIVATE/provider-pins.json"
node packages/access/src/cli.mjs offers --base-url "$APP_URL" --pins-file "$PRIVATE/provider-pins.json"
node packages/access/src/cli.mjs quote --base-url "$APP_URL" --pins-file "$PRIVATE/provider-pins.json" --provider alpha.local --profile-index 0 --prompt-file "$PRIVATE/prompt.txt" --max-output 8
```

`--profile-index` selects a profile from the fresh authenticated offer; there is no manual digest copy. An omitted index is accepted only for a single-profile offer. Existing explicit `--profile` remains supported, but cannot be combined with an index. Quote writes private request/quote files; it does not submit. MCP `access_offers` and `access_quote` with `profileIndex` use the same SDK resolution. `access_submit` still requires explicit caller authorization and the separate host policy.

## Prepared HTTPS deployment boundary

`application.json` optionally accepts `publicOrigin`, a normalized HTTPS origin with no credentials/path/query. It binds browser API configuration, signed offers and advertised provider endpoints to the intended service origin. The application listener remains loopback only. Do not expose it until the external deployment gate is approved.

The existing bounded HTTPS proxy is reused by:

```sh
npm run serve:application:https -- --config "$PRIVATE/tls.json"
```

Its closed private JSON config is `{upstream,publicOrigin,certFile,keyFile,port}`: `upstream` is the exact managed application's loopback origin; `publicOrigin` must match the application setting; `certFile`/`keyFile` are owner-only certificate/private-key file paths; `port` is the loopback TLS listening port. Keep TLS material outside the application's exact backup closure and provision/renew it under host policy. Invalid permissions are not fixed silently. Stop this owned proxy with SIGINT/SIGTERM as well as stopping the app.

The proxy enforces allowed host/origin, strips forwarded/spoofable headers, bounds requests and propagates disconnects. This source supports an approved ingress forwarding to its fixed loopback port; it does not provision DNS, certificates, public listeners, tunnels, firewall rules or paid hosting. The local test uses generated ephemeral certificates and real verified TLS—not global TLS-verification bypass—and does not qualify a public HTTPS endpoint.

## Optional ENSv2 discovery in the managed application

`operator.json` can include `discovery` with the existing `collectEnsV2Config` public input contract: explicit `mode`, `rpcUrl`, `universal`, `root`, `names`, and optional bounded TTL/timeout/cache fields. Development local-chain rehearsal also needs `allowLoopback: true`. The mode must match the application; the managed reader refuses the transaction-preview `operator` field. Doctor validates this configuration offline, without resolving names or broadcasting.

Publish records through the existing separately authorized ENS operator workflow: `ethonline.endpoint` is the application's origin; profiles match the configured offer; network/asset are `non-economic`/`none`; receiver is that provider ID; history points to the application's `/v1/providers/<encoded-provider-id>/history` gateway. Names must be valid ENS names supported by the existing resolver. The application checks resolved records against its configured offer and checks canonical provenance again at selection. Changed/missing/mismatched ENS records cannot redirect execution: they yield an explicit error rather than direct-discovery fallback.

Omitting `discovery` retains direct configured discovery without ENS contact. With ENS enabled, authenticated `/v2/offers` and direct OpenAI access remain available independently, but an explicitly requested ENS selection does not fall back. The local `application-ens.test.mjs` uses official contract fixtures, changes a real record, proves rejection and verifies offline doctor after chain shutdown. Public ENS qualification remains separate.

## Native configuration import (successor 03)

Prepare a private plan beside the owner's existing native operator-input files. This is an application import format, not a replacement producer contract or a grant:

```json
{"schema":"mycelium.application.native-import.v1","providers":[{"inputFile":"alpha-input.json","aliases":["model"]},{"inputFile":"beta-input.json","aliases":["model"]}],"port":0}
```

`inputFile` is a relative regular owner-only file containing the existing closed `mycelium.workbench.operator.v1` or `.v2` input with exactly one provider. The plan also accepts the existing bounded `core` configuration and optional `publicOrigin`; other fields are rejected. Names/aliases, scopes and profile/key/runtime pins are validated before materialization. Primary-only operation uses operator v2 with no replay gateway and zero replay allowance.

```sh
npm run operator -- plan-native --config "$PRIVATE/import-plan.json" --data-dir "$PRIVATE/new-native-app"
npm run operator -- init-native --config "$PRIVATE/import-plan.json" --data-dir "$PRIVATE/new-native-app"
npm run operator -- doctor --config "$PRIVATE/new-native-app/application.json"
```

`plan-native` writes nothing. `init-native` reserves a new private target, generates separate application receipt identities, copies the exact validated input bytes and derives profiles/aliases/limits. It does **not** create a runtime grant, copy a credential, load a model, query a gateway or start a service. Existing destinations are never overwritten. Inspect the generated `operator.json` for each provider's expected grant and credential file paths; provision them privately only after the actual owner grants authority. No native seed/node identity is created by this command. Missing authority makes start fail before gateway contact or job-store creation.

All native grants are checked before any provider contact; each is rechecked before credential retrieval. Gateway readiness occurs only after application port/state-lock/identity preflight. This fixes the earlier managed-start ordering, whose synthetic-only preflight cases did not cover native readiness.

Native metadata version `1` retains its quantized-greedy selector and exact profile bytes. Legacy operator v1 remains restricted to metadata v1; use operator v2 for raw metadata v2. Additive metadata version `2` declares `selector:{"algorithm":"raw-logit-greedy","tieBreak":"lowest-token-id","nonfinite":"reject"}` without a quantum/rounding field. Its manifest artifact is `mycelium-profile-manifest-v2`. Other metadata requirements remain explicit; live qualification is still owner-declared-unqualified. Raw metadata is refused by the legacy candidate protocol and must use the v3 binding. These fields represent an owner's declared policy; they neither prove the implementation follows it nor make A's historical experimental stdio adapter a production gateway.

## Offline public deployment preflight (successor 03)

Use fixed, distinct application and loopback TLS ports for a deployment plan. `application.json.publicOrigin` must equal the TLS public origin, and TLS upstream must identify that application's exact loopback HTTP port.

```sh
npm run operator -- plan-deployment --config "$PRIVATE/new-native-app/application.json" --tls-config "$PRIVATE/tls.json"
npm run operator -- public-pins --config "$PRIVATE/new-native-app/application.json" --provider alpha.example.eth
```

`public-pins` exports only the selected provider's public signing pins. Transfer them through the trusted operator channel into the client's pins file; receiving a key from an untrusted endpoint is not independent identity trust. No runtime credential or signing private key is exported. Both commands stay offline and open no service listener. The plan validates configuration coherence, certificate/key matching, hostname and validity dates, but reports `chainTrustVerified:false`, `grantVerified:false`, `publicDeployment:false` and `financialProtection:false`. Actual external certificate trust and service qualification remain separate. TLS start reuses the same material checks. Optional `upstreamTimeoutMs` configures upstream **idle** timeout (integer 1–300000 ms, default 30000); choose it explicitly for the admitted model envelope. It does not extend application job/call grants or the request-body upload deadline. The deployment plan reports the configured timeout. A real TLS regression verifies successful traffic, timeout error `503`, upstream close observation, and rejection of invalid bounds.

The indexing package's `deploy:dry-run -- --open-plan <file>` prepares exact versioned registry calldata and complete constructor-specific runtime bytes; `inspectOpenRegistryDeployment` verifies an actual already-mined transaction through a separately authorized read-only provider. See `packages/indexing/README.md` for the closed plan and bounds. Neither operation is a broadcast tool or a financial verdict. Do not invent addresses, nonces, funding or hosted deployment identifiers to complete a public configuration. Configure hosted Graph/ENS through the existing accepted operator interfaces only after target approval, and retain generated manifest/code/receipt provenance.
