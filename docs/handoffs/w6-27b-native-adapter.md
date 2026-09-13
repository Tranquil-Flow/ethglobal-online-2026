# W6 27B native adapter — `qwen3_5` / `linear_attn` / `language_model.model.*` support, stage-pack dry run

Status: **adapter/naming support landed on an isolated worktree; prep-only stage-pack dry run complete; stage/load now gets past the previous failure point. A follow-up lane (§8) added pre-quantized affine 4-bit (U32-packed) source loading — verified against the real artifact. A third lane (§9) implemented the hybrid linear-attention execution kernel (gated delta-net + gated full attention, reference/slow path, fail-closed shape gate) — both previous blockers are cleared: the prep-only dry run now runs end-to-end and the loader returns a full `LoadedStage` with a deterministic hybrid probe proof (§9.4).** What remains before a real stage/qualify/serve is driver-side serving work and the owner commit (§9.5/§9.7). No live fleet tree, run root, or service was touched; nothing was committed.

Worktree (all edits live here, unstaged): `/Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter`
Branch: `w6-27b-native-adapter` (new, created from `integration/wave8-a5-a6-a8` @ `b9001e6`)
Base repo inspected read-only: `/Users/evinova-self/Documents/playground/mycelium-wave8-integration` (not modified)

---

## 1. The blocker, reproduced (BEFORE)

Probe (`/tmp/w6-27b-probe/before_probe.py`, later copied to `artifacts/w6-27b-native-adapter/`), run against the unpatched checkout with the **real** `mlx-community/Qwen3.8-27B-4bit` snapshot:

```
"adapter_for_config": "REJECTED ValueError: unsupported model_type: 'qwen3_5'"
"adapter_for_runtime": "REJECTED ValueError: runtime adapter unavailable: 'qwen3_5'"
"compile_model_manifest": "REJECTED ValueError: unsupported model_type: 'qwen3_5'"
"validate_normalized_mlx_runtime": "REJECTED ValueError: unsupported runtime architecture; expected gpt2, qwen2, or qwen3"
```

This is the first failure in both the stage-pack build path (`model_manifest.compile_model_manifest` → `model_adapters.adapter_for_config`, line 227 pre-change) and the load path (`runtime_loader._validate_range_and_prefixes` → `adapter_for_runtime`). With the adapter added, the same probe on the patched worktree returns:

```
"adapter_for_config": "ACCEPTED architecture=qwen3_5"
"adapter_for_runtime": "ACCEPTED architecture=qwen3_5"
"compile_model_manifest": "ACCEPTED num_layers=64 runtime_model=present"
"validate_normalized_mlx_runtime": "ACCEPTED qwen3_5"
```

Real 27B facts used throughout: `model_type: qwen3_5`, `architectures: ["Qwen3_5ForConditionalGeneration"]`, `num_hidden_layers: 64`, 48 `linear_attention` + 16 `full_attention` layers, tensors under `language_model.model.layers.*` / `language_model.model.embed_tokens.*` / `language_model.model.norm.*` / `language_model.lm_head.*` plus a 333-tensor `vision_tower.*` tower; MLX 4-bit affine quantization with `.scales`/`.biases` companion tensors.

## 2. Files changed (worktree only, unstaged)

`git diff --stat` (worktree): `5 files changed, 407 insertions(+), 19 deletions(-)` + 1 new untracked test file.

### `/Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter/model_adapters.py`
- New exact suffix tuples captured from the verified checkpoint index: `QWEN3_5_LINEAR_ATTENTION_TENSOR_SUFFIXES` (30 tensors incl. `linear_attn.A_log`, `linear_attn.conv1d.weight`, `linear_attn.dt_bias`, all four `in_proj_*` with quantized companions) and `QWEN3_5_FULL_ATTENTION_TENSOR_SUFFIXES` (25 tensors incl. `self_attn.q_norm/k_norm`), plus the exact static key tuples (lines 60–135).
- `ModelAdapter` gains three default-empty, opt-in fields (lines 153–162): `decoder_tensor_suffixes_by_layer_type`, `excluded_tensor_prefixes`, `exact_static_component_keys`. All existing adapters leave them empty → zero behavior change.
- New `"qwen3_5"` adapter entry (line 303): prefix `language_model.model.layers.{layer}.`; components `input_embedding`/`decoder`/`final_norm`/`lm_head` in the `language_model.*` namespace; layer count from `text_config.num_hidden_layers`; per-layer-type suffix map; `vision_tower.` excluded from route ownership; `runtime_backends=("mlx","numpy")` (tensor-ownership authority only — execution is separately gated, see §5).

### `.../model_manifest.py`
- `_is_causal_lm` allowlist extended with `Qwen3_5ForConditionalGeneration` (line 84) — the VLM wrapper name does not end in `ForCausalLM`.
- `vision_tower.*` keys are dropped from the fail-closed "unowned tensor keys" check only for adapters that declare `excluded_tensor_prefixes` (lines 184–189); unknown foreign namespaces still fail closed (pinned by test).
- New `runtime_model` branch for `qwen3_5` (lines 237–243) so assignments/stage packs carry the normalized runtime.

### `.../runtime_contracts.py`
- `QWEN3_5_MODEL_CONFIG_FIELDS` (line 54): the Qwen2 12-field set plus `partial_rotary_factor`, `layer_types`, and the five linear-attention dims.
- `normalize_qwen3_5_model_config` (line 253): reads the nested `text_config`, accepts `rope_theta` from `rope_parameters`, validates `layer_types` length/values, linear dims, and `partial_rotary_factor ∈ (0,1]`. Deliberately does **not** enforce the Qwen2 `n_embd == n_head*head_dim` identity — Qwen3.5 gated attention has 24×256 q-dim against 5120 hidden.
- `_normalize_architecture_runtime` dispatch gains the `qwen3_5` branch (line 392); the error text now lists `qwen3_5`.

### `.../runtime_loader.py`
- `_validate_range_and_prefixes`: `qwen3_5` namespace `language_model.model.` (line 287).
- `_resolve_aliases`: tied-head source for `qwen3_5` (line 314; unused on this route because `tie_word_embeddings` is false — `lm_head` is explicit).
- `_validate_component_ownership` (lines 402–455): when the adapter declares per-layer-type suffixes, decoder ownership is computed per layer via `runtime.model_config.layer_types` (mixed ranges such as 0..63 now validate exactly); static component ownership is checked against the adapter's exact key tuples (`language_model.model.embed_tokens.{biases,scales,weight}`, `language_model.model.norm.weight`, `language_model.lm_head.{biases,scales,weight}`). Legacy hardcoded expectations are untouched for gpt2/qwen2/qwen3.
- `load_assignment_stage` fail-closed execution gate (lines 1982–1988): a `qwen3_5` runtime that reaches execution raises `qwen3_5 linear-attention execution is not implemented by this loader` instead of being misrouted through the GPT-2 shape validator.

### `.../stage_pack.py`
- `_VERIFICATION_SCHEMA` (line 198) and `_PACK_RUNTIME_SCHEMA` (line 375) gain a third runtime `map` variant for the 19-field `qwen3_5` model_config (incl. `layer_types` as a string list). Without this, a compiled 27B pack failed `verify_stage_pack` with `ValueError: stage pack schema is invalid` (observed at `/private/tmp/w6-27b-adapter-stage-test-20260913T133624Z`, root since cleaned up).

### New test file
`/Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter/tests/model/test_qwen3_5_runtime.py` (9 tests; repo layout/style follows `tests/model/test_qwen3_runtime.py`). The exact 27B namespace is captured at tiny synthetic sizes so tests stay bounded and do not depend on the 16 GB snapshot.

Diff/scripts retained for the driver: `docs/handoffs/w6-27b-native-adapter.md` (this file) + `artifacts/w6-27b-native-adapter/` (`worktree.diff`, `before_probe.py`, `dry_run.py`, `dry-run-<run-root>.log`, `test_qwen3_5_runtime.py`, `run-root-path.txt`, and the run-root control/marker JSONs under `run-root-control/`).

## 3. Tests (real output)

New behavior tests (GREEN after, RED before via `git stash` of the four source files in the worktree):

```
$ env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 -m pytest -q -p no:cacheprovider tests/model/test_qwen3_5_runtime.py
9 passed

RED (same command, source changes stashed):
ERROR tests/model/test_qwen3_5_runtime.py
E   ImportError: cannot import name 'QWEN3_5_EMBEDDING_TENSOR_KEYS' from 'model_adapters'
    (plus the four REJECTED probe lines in §1)
```

Regression (targeted set incl. every module touched):

```
$ ... /opt/homebrew/bin/python3.14 -m pytest -q -p no:cacheprovider \
    test_model_adapters.py test_model_manifest.py test_runtime_loader.py test_stage_pack.py \
    tests/model/ tests/live/test_stage_pack_builder.py
554 passed in ~46s
```

Environment: python 3.14.4, numpy 2.5.1, mlx 0.31.1. Pitfall for the driver: run pytest from the worktree root; with `-I` and cwd off `sys.path`, a single `tests/model/...` file cannot import repo-root modules (root-level test files seed `sys.path`, this dir alone does not).

## 4. Prep-only stage-pack dry run (NEW run root; real files)

Script: `/tmp/w6-27b-probe/dry_run.py` (copied to `artifacts/w6-27b-native-adapter/`) — a 27B analog of the live run-root `probe-stage-load.py` chain. Run root (NEW, created by the script, never an existing root):

`/private/tmp/w6-27b-adapter-stage-test-20260913T133815Z` (= `/tmp/...` via the macOS symlink; canonical path required by the pack validators)

```
$ env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 -I dry_run.py \
    /Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter \
    /private/tmp/w6-27b-adapter-stage-test-20260913T133815Z
[15:38:18] run root (NEW): /private/tmp/w6-27b-adapter-stage-test-20260913T133815Z
[15:38:18] manifest compiled: num_layers=64 digest=sha256:b0659e8e65e45c45ef624cc5c2337da81ccc11926d4a53a02f9a7c5b2f880b15
[15:38:18] node-0: assignment compiled id=0d4fb4f3-… layers=0..63 components=['input_embedding','decoder'] loader-naming=ACCEPTED
[15:38:18] node-2: assignment compiled id=5c1ea903-… layers=63..64 components=['decoder','final_norm','lm_head'] loader-naming=ACCEPTED
[15:38:18] provisioning node-2 covering files: ['model-00003-of-00003.safetensors']
[15:38:26] provisioned: cache_hit_bytes=5357087557 verified_files=1
[15:38:26] stage pack compiled: digest=sha256:7a2ec03e0e7225c56143fa72d675a57cb1ee0380d17542f226e3761d8649b0ef
[15:38:31] stage pack verified: verification_digest=sha256:fc639fd8a0919833f27081ed7b1c9e38f0db5a7111318a745b0daec4b3563b28
[15:38:35] artifact report adapted for loader: ready_for_load=True
[15:38:41] load attempt: STOPPED_AT_RUNTIME_BOUNDARY -> unverified or quantized source dtype for tensor language_model.lm_head.weight: U32
```

Evidence produced in the run root:
- Marker file created: `.mycelium-stage-dry-run.json` (protocol `mycelium.stage_pack_dry_run.v1`, `dry_run: true`, `route_ready: false`), plus `stage-pack-dry-run.json` summary and `dry-run.log`.
- `control/`: real `model-manifest.json`; both node assignments; node-0/node-2 `*-loader-naming-check.json` (both `accepted: true`; node-0 covers 1818 expected tensor keys across layers 0–62, node-2 covers 29 keys for layer 63 + norm + lm_head); `node-2-stage-pack.json`; `node-2-stage-pack-verification.json`; `node-2-artifact-report.json`; `node-2-artifact-report-for-loader.json`; `node-2-load-attempt.json`.
- `node-2-artifacts/model-00003-of-00003.safetensors` — real 5,357,087,557-byte staged copy from the local HF cache (no network; digest verified against the manifest).

Honest boundaries of this dry run:
- The load stops at `runtime_loader.py:925` (`_load_numpy_safetensors` source-dtype gate) / the twin MLX gate at `runtime_loader.py:1033-1037`: pre-quantized 4-bit source tensors (`.weight` stored as `U32` + bf16 `.scales`/`.biases`) are not loadable by either backend. Everything before that point — assignment identity, architecture adapter, per-layer ownership, artifact report, stage-pack binding — passed on real data. **This is the “past the previous failure point” boundary the lane asked to prove.**
- The assignment `control_plane_binding` in the dry run is a format-valid placeholder (zero digests), labelled as such in `node-2-load-attempt.json`; a real binding only exists after the operator plan is bound to seed (prep handoff §5). No load proof was produced (`route_ready: false` throughout).
- The canonical `.mycelium-stage.json` marker is written only by the controller remote-stage path (`physical_inference_qualification.py` `_REMOTE_STAGE_SCRIPT`, marker write at lines ~195–200). Running that requires the bound operator plan and live peers, which the hard rules forbid — so it was not run, and no such marker was forged. The run shows the pre-stage half of the pipeline is unblocked; on-node staging itself is unchanged by this change set.
- `mycelium_live/stage_pack_builder.py` acquisition-manifest generation was not exercised: it requires real owner-authorization evidence (`owner_provenance: "owner-approved-exact-representation"` is baked into its output), which the lane must not fabricate.

## 5. Remaining required work before a real stage/qualify/serve

> Update (follow-up lane, §9): item 2 below (hybrid execution kernel) is **implemented and verified**, and the prep-only dry run now completes with `load_result: LOADED` on the real artifact. Item 1 (§8) is likewise implemented. Items 3 and §9.5 notes remain.

1. **4-bit source loading** — `runtime_loader.py:925` (numpy) and `:1033-1037` (MLX) reject the verified artifact's `U32` weights. Either add MLX-affine dequant-on-load (group_size 64, bits 4) or produce a float16/float32 re-quantized representation through the authorized preparation path (the 0.5B route staged float source and quantized at load; the 27B snapshot is pre-quantized).
2. **Hybrid execution kernel** — ~~no `linear_attn` execution exists anywhere in the runtime~~ **Done (§9).** `load_assignment_stage` no longer fails closed at the `qwen3_5` gate: the loader validates the exact per-layer-type tensor contract and executes a reference `linear_attn` (gated delta-net, recurrent) and gated full-attention path for both backends, with a fail-closed gate for unsupported configurations.
3. **Commit/merge + windowing** — owner commits this branch (or cherry-picks); the prep handoff's constraints stand: laptop disk/SSH, node-0 memory pressure, load proofs computed on the target host, controller staging via the bound operator plan.

## 6. Hard-rule compliance

- Edits only in the new worktree; the live checkout `mycelium-wave8-integration` and `/Users/evinova-self/mycelium-physical-run/**` were never written to (live tree status before/after: unchanged pre-existing A13 dirt only).
- No `git commit`, no push, no trailers; worktree holds unstaged modification + one untracked test file. `serve-native.py`, launchd, and all services untouched.
- Stage-pack dry run ran in a brand-new `/private/tmp` run root (the intermediate partial root from the schema-gap run was removed after capture; ~5 GB of evidence remains in the final root, ~34 GB disk free at completion).
- No secrets printed; no network downloads (all bytes came from the already-verified local HF cache).
- Python runs used `env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 ...` (with `-I` for scripts/tests where applicable).

## 7. GO / NO-GO for the driver

**GO — the 27B route can now proceed to the next prep steps on this branch/worktree**: manifest build, two-node assignment build, stage-pack build/verify, and loader naming/ownership validation all succeed against the real verified 27B artifact (digests above), i.e. stage/load is past the `qwen3_5`/naming failure that this lane existed to remove.

**NO-GO (as of this change set) for actual node staging → load-proof → qualify → serve**, because the load stops at the 4-bit source-dtype gate (`runtime_loader.py:925` / `:1033-1037`) and no linear-attention execution exists (§5 items 1–2). Those are implementation tasks, not blockers of this adapter work. Owner commit of the worktree is required before anything runs from the live tree.

---

## 8. Follow-up lane — pre-quantized affine 4-bit (U32-packed) weight loading

Status: **implemented and verified in the same worktree/branch (unstaged; nothing committed).** The verified 27B artifact's U32-packed 4-bit weights now load through a new, fail-closed affine-4-bit path; the prep-only dry run gets past the previous tensor-load failure and stops at the next known boundary (hybrid execution kernel). No live fleet tree, run root, or service touched; no network downloads (local HF cache reads only).

### 8.1 What changed (worktree, unstaged; on top of §2)

`runtime_loader.py`
- Format constants (line ~85): `_AFFINE4BIT_PACKED_VALUES_PER_WORD = 8`, `_AFFINE4BIT_GROUP_SIZE = 64`, `_AFFINE4BIT_DEQUANT_CHUNK_FLOAT_BYTES = 32 MiB` — exactly the verified artifact's declared `quantization_config` (`{bits: 4, group_size: 64, mode: affine}`, `value = quant * scale + bias`).
- New helpers (placed before `_load_rowwise_int8_weight`, mirroring its structure):
  - `_unpacked_affine4bit_words` — LSB-first nibble unpack of U32 words → uint8 values (nibble order verified against `mlx.core.quantize`/`dequantize`).
  - `_dequantize_affine4bit_rows` — strict shape validation + per-64-value-group `q*scale+bias` → float32.
  - `_load_affine4bit_float_companion` — loads one `.scales`/`.biases` BF16/F16/F32 companion as a float32 matrix.
  - `_load_affine4bit_weight` — validates U32 + 2-D `.weight` + assigned companions, then decodes in bounded row chunks (32 MiB float bytes/chunk, same convention as the int8 path).
- `_load_numpy_safetensors`: a `U32` source routes to `_load_affine4bit_weight`; every other source dtype keeps the exact previous code path and fail-closed message.
- `_load_exact_tensors` (MLX branch): a file whose selected tensors include U32 sources materializes through the same numpy decoder and converts to MLX arrays; the trigger condition is widened from `quantize_qwen`-only to `quantize_qwen or any selected source is U32` (float-only files keep the `mx.load` path exactly as before).
- `load_assignment_stage`: comment updated at the `qwen3_5` gate (sources are now materialized; the execution kernel remains fail-closed).

Fail-closed properties (pinned by tests): U32 `.weight` without its assigned `.scales`/`.biases`; non-2-D U32; wrong byte length; non-float companion dtype; unsupported group layout/size — each raises `RuntimeLoadError` with a precise message. Existing routes never carry U32 sources, so their behavior is unchanged (regressions below).

Residual note (documented; not a blocker): the (bits, group_size) pair of MLX affine quantization is not jointly recoverable from shapes alone (e.g. 4-bit/gs64 and 8-bit/gs32 have the same shape signature). The loader therefore implements exactly the declared format (bits=4, group_size=64) and fails closed on any other group size; a differently-quantized artifact needs an explicit loader extension, never a silent mis-decode.

`tests/model/test_qwen3_5_runtime.py` — new cases (14 tests total: 9 from §2 + 5 new):
1. `test_qwen3_5_affine4bit_dequantize_matches_hand_computed_reference` — hand-packed 2×64 fixture (quants `c % 16` / `15 - c % 16`, scales 0.5/0.25, biases −3.0/+1.5, BF16 companions); asserts the exact hand-computed matrix, the companion tensors, and the missing-companion fail-closed error.
2. `test_qwen3_5_affine4bit_unpack_matches_mlx_quantize_layout` — seeded 4×128 tensor quantized with `mx.quantize(..., group_size=64, bits=4)`; loader decode compared against `mx.dequantize` (layout ground truth).
3. `test_qwen3_5_affine4bit_loader_reads_bounded_row_chunks` — instrumented reader proves one packed 32-byte row per read (chunking).
4. `test_qwen3_5_affine4bit_load_path_materializes_quantized_sources_and_stops_at_execution_gate[numpy|mlx]` — full tiny U32-packed artifact + assignment/artifact-report pipeline through `load_assignment_stage`; a spy proves all 29 node-2-shaped keys materialize with exact values, and the load then stops at the execution gate, for both backends.

### 8.2 Tests (real output)

```
$ cd /Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter && \
  env PYTHONPATH=/Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter \
      PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 -m pytest tests/ -q
5 failed, 3827 passed, 13 skipped in 298.19s (0:04:58)
```

RED → GREEN for the new behavior:
```
GREEN (this change set): tests/model/test_qwen3_5_runtime.py  ....  14 passed in 0.43s
RED (only runtime_loader.py swapped back to the §2-era version):
  tests/model/test_qwen3_5_runtime.py  5 failed, 9 passed in 0.28s
  (exactly the five affine-4-bit cases fail; none of the §2 tests change)
```

Root-level target set (files outside `tests/`: the previous lane's set plus every root test importing `runtime_loader`):
```
$ ... pytest -q test_layer_assignment.py test_model_adapters.py test_model_manifest.py \
    test_numpy_runtime.py test_numpy_stage_runtime.py test_router_mlx_runtime.py \
    test_router_numpy_qwen_kv.py test_router_numpy_runtime.py test_runtime_loader.py \
    test_stage_pack.py test_two_process_inference_qualification.py tests/model/ tests/live/test_stage_pack_builder.py
718 passed in 52.42s
```

Honest failure accounting — the same 5 failures with and without this change set (all pre-existing):
- 4 (`tests/contracts` ×2, `tests/governance` ×2): contract-manifest drift. The manifest hash-pins `model_adapters.py`, `model_manifest.py`, `runtime_contracts.py`, `runtime_loader.py`, all of which carry uncommitted lane edits, so the audit correctly reports drift. Provenance probe (`drift_provenance.py` in the artifacts bundle): for all four files `HEAD == pinned`, and the **previous lane's** worktree state already broke every one of those pins before this change set (rebuilt from the archived `worktree.diff`). These clear when the owner commits and regenerates the contract manifest — not a code defect.
- 1 (`tests/seed_coordinator/test_local_two_node.py::test_local_two_node_native_process_e2e`): pre-existing at HEAD (fails identically with all lane changes stashed) — a `destination_placement_id` trace-allowlist mismatch in `mycelium_router` trace output, untouched by this lane.
- Baseline comparison: full `pytest tests/` on the §2-era tree = `5 failed, 3821 passed`; 3821 + 1 (one test absent from the archived baseline copy of the §2 test file) + 5 (this lane's new cases) = 3827 ✓.

### 8.3 Prep-only stage-pack dry run (NEW root) — previous failure point cleared

Root (NEW, canonical absolute `/private/tmp` path — the relative-path failure mode `artifact cache root for node-0 must be absolute` is avoided by passing it absolute):

`/private/tmp/w6-27b-adapter-stage-test-20260913T143026Z`

```
$ env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 -I dry_run.py \
    /Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter \
    /private/tmp/w6-27b-adapter-stage-test-20260913T143026Z
[16:30:31] run root (NEW): /private/tmp/w6-27b-adapter-stage-test-20260913T143026Z
[16:30:31] manifest compiled: num_layers=64 digest=sha256:b0659e8e... (same manifest digest as §4)
[16:30:31] node-0: assignment compiled ... loader-naming=ACCEPTED
[16:30:31] node-2: assignment compiled ... loader-naming=ACCEPTED
[16:30:38] provisioned: cache_hit_bytes=5357087557 verified_files=1
[16:30:38] stage pack compiled: digest=sha256:c38bf31b...
[16:30:42] stage pack verified: verification_digest=sha256:2fc9234e...
[16:30:47] artifact report adapted for loader: ready_for_load=True
[16:30:57] load attempt: STOPPED_AT_RUNTIME_BOUNDARY -> qwen3_5 linear-attention execution is not implemented by this loader
```

Before (§4 root): `-> unverified or quantized source dtype for tensor language_model.lm_head.weight: U32`. Now: the load materializes all 29 assigned tensors (including the 8 U32-packed sources) and stops at the next known boundary (the hybrid execution kernel, §5 item 2). **That is the “past the previous tensor-load failure” proof.**

Real-artifact materialization probe (`load_probe.py`; `load-probe.json` inside the run root and in the artifacts bundle):
- 29 tensors, 6.31 GiB float32, materialized in 5.7–6.3 s; peak RSS 3778 MiB / 4618 MiB (previous/new root).
- 8 U32 sources decoded with correct shapes: `lm_head.weight U32(248320, 640) → float32(248320, 5120)`; layer-63 q/k/v/o + mlp weights likewise; value ranges sane (|w| ≤ ~1.02), zero non-finite tensors.
- Real-data ground truth: spot decode of `language_model.model.layers.63.self_attn.k_proj.weight` matches `mlx.dequantize` **bit-for-bit** (`max_abs_diff = 0.0`).

Run-root contents (new): `control/` (manifest, both assignments, both loader-naming checks, stage pack + verification, artifact report for loader, load attempt), `node-2-artifacts/model-00003-of-00003.safetensors` (real 5,357,087,557-byte staged copy), `load-probe.json`, `.mycelium-stage-dry-run.json` marker (`dry_run: true`, `route_ready: false`), `stage-pack-dry-run.json`, `dry-run.log`.

Honest boundaries: the §4 notes stand (placeholder control-plane binding, no canonical `.mycelium-stage.json` marker — controller remote-stage path only, no load proof, `route_ready: false`). New note: materialization expands packed weights to float32 — the node-2 slice alone is 6.31 GiB, so full-model serving must consume the packed form (or dequantize per-tensor on the fly) inside the execution kernel; that is §5 item 2 work, not this loader path.

### 8.4 Hard-rule compliance (this change set)

- Edits only in the worktree; live checkout and `/Users/evinova-self/mycelium-physical-run/**` untouched; `serve-native.py`, launchd/services untouched.
- No `git commit`/push/trailers; worktree holds the same 5 modified files + 1 untracked test file (unstaged).
- New evidence only under `/private/tmp/w6-27b-adapter-stage-test-20260913T143026Z` (fresh root) plus the workbench `artifacts/w6-27b-native-adapter/` bundle; the §4 root was opened read-only by the follow-up probe.
- No secrets printed; no network downloads (local HF cache only; the dry-run fetch stub asserts model/revision).
- Python hygiene: `env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 ... python3.14 -I` for scripts; explicit `PYTHONPATH=<worktree>` for the required pytest commands.

### 8.5 GO / NO-GO for the driver

**GO — pre-quantized 4-bit (U32-packed) source loading is implemented, fail-closed, and verified on the real verified artifact**: hand-computed and MLX-ground-truth unit vectors, RED→GREEN, full + targeted regressions (no new failures; the 5 pre-existing ones accounted for above), a real-artifact materialization probe (bit-exact vs `mx.dequantize`), and a fresh prep-only stage-pack dry run that passes the previous failure point. On this branch/worktree the 27B route's only remaining pre-serve implementation gap is the hybrid linear-attention execution kernel (§5 item 2).

**NO-GO (as of this change set) for actual node staging → load-proof → qualify → serve**, because (a) the execution kernel does not exist — `load_assignment_stage` still fails closed at the `qwen3_5` gate; (b) serving must consume packed weights or dequantize on the fly (full-model float32 materialization is not viable: ~6.31 GiB for the 1-layer+lm_head slice alone); (c) owner commit + contract-manifest regeneration is required (the 4 contracts/governance failures above are the uncommitted-state signal, not a code defect); (d) §5 item 3 constraints (owner commit, laptop disk/SSH, node-0 memory pressure, controller staging via the bound operator plan) stand.

---

## 9. Follow-up lane — hybrid linear-attention execution kernel (`linear_attn` + gated full attention)

Status: **implemented and verified in the same worktree/branch (unstaged; nothing committed).** The `qwen3_5` fail-closed execution gate is replaced by an exact per-layer-type validation gate plus a correctness-first (slow) execution kernel for both hybrid layer kinds on both backends. The prep-only dry run now completes end-to-end: `load_result: LOADED` with a full `LoadedStage` proof, and a second dry-run variant additionally executes a real `linear_attention` layer on artifact weights. No live fleet tree, run root, or service touched; no network downloads (local HF cache reads only).

### 9.1 What changed (worktree, unstaged; on top of §2/§8)

`runtime_loader.py`
- `_qwen3_5_layer_shapes(config, layer_type)` + `_validate_qwen3_5_shapes(...)` (placed after `_validate_qwen2_shapes`): the new execution gate. Validates per layer type (selected via `model_config.layer_types`) the exact tensor contract: all quantized projections must carry their affine-4-bit `.scales`/`.biases` companions shaped `(rows, in/64)`; `conv1d.weight` is `(conv_dim, conv_kernel, 1)`; `A_log`/`dt_bias` are `(num_v_heads,)`, `linear_attn.norm.weight` is `(value_head_dim,)`; full-attention tensors require the `attn_output_gate` layout (`q_proj` rows `2*n_head*head_dim`), `q_norm`/`k_norm` `(head_dim,)`; static components and the lm_head (with companions) are validated too. Config relations fail closed: `head_dim * partial_rotary_factor` must be an even dimension ≥ 2, attention heads divisible, `num_v_heads % num_k_heads == 0`, hidden and all companion columns divisible by 64. Unsupported layer types are rejected. The gate call replaces the previous unconditional `raise _fail("qwen3_5 linear-attention execution is not implemented by this loader")` in `load_assignment_stage` (previously at §8's `runtime_loader.py:2155-2162`).
- MLX reference kernel (after `_qwen2_rope`): `_qwen3_5_rope` (partial rotary, rotate_half style over the first `head_dim*partial_rotary_factor` dims — numerically identical to `mx.fast.rope(traditional=False)` within float32 rounding, verified), `_qwen3_5_full_attention` (q_proj split into query+gate, per-head RMS norms, partial RoPE, causal softmax, `* sigmoid(gate)`, o_proj), `_qwen3_5_gated_delta_net` (gated delta-net: depthwise causal conv1d + silu, in_proj a/b/z, `beta=sigmoid(b)`, `decay=-exp(A_log)*softplus(a+dt_bias)` computed in float32, q/k RMS-normalized on the head dim with the delta-rule scale 1/sqrt(d_k) folded into q as `(inv_scale**2) * rms_norm(q)`, recurrent delta rule, gated RMS norm `rms_norm(x) * silu(z)`, out_proj), `_qwen3_5_block` (pre-norm residual decoder layer with qwen2-style SwiGLU MLP).
- `_run_qwen3_5_probe(...)` — deterministic hybrid probe (synthetic hidden states or embedding lookups, per-layer dispatch by `layer_types`, final norm, lm_head); wired into `load_assignment_stage`'s MLX probe dispatch.
- `execute_loaded_stage` (MLX) gains qwen3_5 branches (namespace `language_model.model.`, embedding, layer loop, final norm, `language_model.lm_head.weight` default head key) so post-load stage execution works for the new architecture rather than only the load probe.
- `_digest_probe_output`: qwen3_5 NumPy probes are now digested like qwen2/qwen3 ones (top-8 ordered logits per position) so the load-proof digest does not bind BLAS rounding noise.

`numpy_runtime.py`
- Same kernel and shape logic in NumPy: `_sigmoid` (logaddexp-stable), `_qwen3_5_layer_tensor_shapes` (asserting the suffix set equals the adapter's per-layer-type tuple), `_qwen3_5_rope`, `_qwen3_5_full_attention`, `_qwen3_5_gated_delta_net`, `_qwen3_5_block`.
- `_stage_namespace` recognizes `language_model.model.`; `_stage_shapes` builds the exact qwen3_5 stage inventory (companions included) for the NumPy inventory/dtype checks; `execute_loaded_stage` gains the qwen3_5 branches (embedding, layer loop, final norm, lm_head).

Reference semantics (both kernels match the artifact's native runtime, `mlx_lm.models.qwen3_5`): stored norm weights are used directly as scales — the mlx-community conversion's `sanitize()` is a no-op for this artifact (no `mtp.` keys; `conv1d.weight` already `(dim, k, 1)`), and the stored norm values are ≈1 (e.g. layer-0 `input_layernorm` mean 0.97; `linear_attn.norm` ≈0.87), i.e. the effective-scale convention, not HF's zero-centered `(1 + w)`. The q/k normalization uses the RMS convention with eps inside the mean (the mlx_lm placement); see §9.2 for the controlled experiment that isolates this choice.

No changes to any existing architecture path: all new branches are keyed on `runtime["architecture"] == "qwen3_5"`; gpt2/qwen2/qwen3 behavior is untouched (full + targeted regressions below).

### 9.2 Numeric cross-checks against independent references

Scratch evidence (`/tmp/w6-27b-kernel-probe/cross_check.py`, `hf_cross_check.py`; copies retained in the artifacts bundle). Tiny 2-layer hybrid model (layer 0 `linear_attention`, layer 1 `full_attention`, hidden 64, head_dim 16, partial rotary 0.5, group size 64), identical deterministic weights consumed by every implementation:

```
$ env -u PYTHONPATH <pipx mlx-lm venv python> cross_check.py
layer 0 (linear_attention): mlx_lm vs worktree MLX  max_abs_diff=2.623e-06 (max 5.035)
layer 1 (full_attention):   mlx_lm vs worktree MLX  max_abs_diff=4.649e-06 (max 6.193)
final logits: mlx_lm vs MLX kernel  2.205e-06
              mlx_lm vs NumPy kernel 3.010e-06
              MLX kernel vs NumPy kernel 3.934e-06   (float32 rounding level)
ALL-CLOSE(rtol=1e-4,atol=1e-4): True
```

Second reference (transformers 5.7 `Qwen3_5TextModel`, torch CPU; HF state-dict norms shifted by −1.0 to match the artifact's effective-scale convention):
```
$ env -u PYTHONPATH <ml-venv python> hf_cross_check.py
logits max_abs_diff=1.144e-03  (HF as-shipped)
eps-aligned logits max_abs_diff=4.351e-06  -> ALL-CLOSE True
```
The 1.1e-3 residual is a controlled, isolated difference: transformers' torch fallback l2-normalizes q/k with eps inside the *sum* (`sum(x²)+1e-6`), while the artifact's native mlx_lm folds the scale around an RMS normalization with eps inside the *mean* (`sum(x²)+d*1e-6`). Patching only HF's `l2norm` to the mlx placement collapses the difference to float32 noise (4.4e-6), proving the kernels are otherwise semantically identical to both references. The worktree kernels implement the mlx_lm (artifact-native) placement.

### 9.3 Tests (real output)

`tests/model/test_qwen3_5_runtime.py` now has 22 tests (14 from §2/§8 + 8 new):
- Updated: the two §8 tests that pinned the old gate boundary now assert the full load passes the gate and returns a stage (`..._passes_execution_gate`), with materialization-spy assertions retained.
- New gate-pass tests (numpy + mlx, 4): `test_qwen3_5_execution_gate_passes_for_hybrid_layers` (tiny full hybrid model, 59 tensors, both layer types + final norm + lm_head; probe shape `[1,3,32]`; probe digest determinism on repeat load) and `test_qwen3_5_execution_gate_passes_for_entry_stage` (embedding + layer 0; hidden-state probe `[1,3,64]`).
- New fail-closed tests (3): unsupported rotary factor (`int(16*0.1)=1`), incompatible linear heads (`num_v_heads=3 % 2`), and a mis-shaped `q_proj` artifact (rows 129 ≠ 2·n_head·head_dim) — each rejected with the precise `RuntimeLoadError` through the full load path.
- New cross-backend parity test (1): MLX vs NumPy kernel on identical tiny weights (`allclose rtol=1e-3, atol=1e-4`).

```
$ cd /Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter && \
  env PYTHONPATH=/Users/evinova-self/Documents/playground/mycelium-w6-27b-native-adapter \
      PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 -m pytest tests/ -q
5 failed, 3835 passed, 13 skipped in 297.64s (0:04:57)
```

Same 5 pre-existing failures as §8 (4 × contract/governance manifest drift from the uncommitted lane edits; 1 × `tests/seed_coordinator/test_local_two_node.py::test_local_two_node_native_process_e2e`, pre-existing at HEAD). Baseline arithmetic: §8's 3827 passed + 8 new = 3835 ✓.

File alone: `tests/model/test_qwen3_5_runtime.py  22 passed in 0.26s` (no warnings).

Root-level target set (same command as §8):
```
$ ... pytest -q test_layer_assignment.py test_model_adapters.py test_model_manifest.py \
    test_numpy_runtime.py test_numpy_stage_runtime.py test_router_mlx_runtime.py \
    test_router_numpy_qwen_kv.py test_router_numpy_runtime.py test_runtime_loader.py \
    test_stage_pack.py test_two_process_inference_qualification.py tests/model/ tests/live/test_stage_pack_builder.py
726 passed in 53.46s      (§8: 718 passed; +8 new)
```

RED → GREEN for the new behavior: with only the gate call reverted to the §8 `raise` in a scratch copy of the worktree (`/tmp/w6-27b-kernel-probe/red-tree`), all 9 gate tests fail with the pre-lane boundary message:
```
9 failed, 13 deselected in 0.49s
  Actual message: 'qwen3_5 linear-attention execution is not implemented by this loader'
```

### 9.4 Prep-only stage-pack dry run (NEW roots) — route now LOADS end-to-end

Two fresh canonical `/private/tmp` run roots; both produced with the real verified artifact (local HF cache only):

**A. Same node-2 shape as §8 (layer 63 full-attention + norm + lm_head), new root `20260913T152300Z`:**
```
[17:23:09] provisioned: cache_hit_bytes=5357087557 verified_files=1
[17:23:09] stage pack compiled: digest=sha256:9b7bbfdeade330104018dac7ffc00cf5ef8a35a4c90c935b2f2cedf59bbbbe23
[17:23:13] stage pack verified: verification_digest=sha256:2370e71b141fae603240deb2c780cd231ef6b4f3a732e7381c516a0ac23d6ae8
[17:23:17] artifact report adapted for loader: ready_for_load=True
[17:23:40] load attempt: LOADED ->
```
Proof (in `control/node-2-load-attempt.json`): `probe_shape [1, 3, 248320]`, `probe_digest sha256:88fba33c…`, `loaded_tensor_digest sha256:d3fabe8e…`, 29 tensor keys, stage-pack + verification digests bound into the proof, `route_ready: false`.

**B. Linear-attention on real weights: variant root `20260913T152424Z` whose node-2 slice is layers 62..64 (layer 62 = `linear_attention`, layer 63 = `full_attention`) + norm + lm_head:**
```
[17:24:41] artifact report adapted for loader: ready_for_load=True
[17:25:07] load attempt: LOADED ->
```
`load_probe_linear.py` (read-only, run twice against the root):
```
loads: generation 17: probe_digest sha256:d5e8de99… wall 27.64 s; generation 18: same digest, 25.2 s
59 tensors loaded; peak RSS 14845 MiB; probe_digest_stable_across_runs: true
runtime_identity: numpy 2.5.1 / cpu / float32 / quantization none
```
Real-data spot check (`spot_check_linear.py`): the real layer-62 `linear_attn.in_proj_qkv.weight` (U32 packed `(10240, 640)`) materializes to float32 `(10240, 5120)` **bit-exact vs `mx.dequantize`** (|w|max 0.512).

Script updates (this lane): `dry_run.py` now serializes the returned proof via `runtime_loader.canonical_json` — a plain `json.dumps` can never serialize the loader's frozen (mappingproxy) proof, which is why the first attempt reported `STOPPED_AT_UNEXPECTED_BOUNDARY: TypeError: Object of type mappingproxy is not JSON serializable` after the load itself had already succeeded. A hardlink shortcut for the 5.4 GB staging copy was tried and reverted: `stage_pack.py` requires verified artifacts to have exactly one hard link (`nlink == 1`, no aliasing).

Run-root contents (A and B): `control/` (manifest, both assignments, loader-naming checks, stage pack + verification, artifact report for loader, **load attempt with proof**), `node-2-artifacts/model-00003-of-00003.safetensors` (real 5,357,087,557-byte staged copies), `.mycelium-stage-dry-run.json` marker (`dry_run: true`, `route_ready: false`), `stage-pack-dry-run.json`, `dry-run.log`.

### 9.5 Honest boundaries (this change set)

- **Real-artifact execution evidence covers the node-2-class slices only** (layers 62/63 + norm + lm_head). Node-0 (62 layers, 47 of them `linear_attention`, with `input_embedding`) is exercised by the tiny-model unit tests and the mlx_lm/HF cross-checks, not by a full real artifact load — node-0 materialization is a multi-GB, driver-owned stage step, and the dry run (as designed) only builds its naming evidence.
- **Performance is not addressed.** The kernel is the explicit slow path: recurrent (not chunked) gated delta rule, explicit causal convolution, no KV/state cache, full-sequence recompute per probe. It is a correctness + load-proof path, not a serving path.
- **Serving must still consume packed weights or dequantize on the fly** (§8.5 holds): loading a stage materializes float32 (6.31 GiB for layer 63 + head; 7.8 GiB for layers 62–63). The loader-side execution path exists now, but a serving-grade execution/memory strategy is driver work.
- **Norm/eps conventions are pinned to the artifact's native runtime** (mlx_lm). If a future gate compares tiny-fixture numerics against the *transformers torch* reference as-shipped, expect ~1e-3-scale differences from the q/k normalization eps placement (§9.2) — that is a reference-convention difference, not a kernel defect.
- The §8 dry-run caveats stand: placeholder control-plane binding, no canonical `.mycelium-stage.json` marker (controller remote-stage path only), `route_ready: false` throughout, **no load proof claims beyond local deterministic execution**.
- Disk: the two prior-lane roots (5.0 GiB each) remain plus this lane's two LOADED roots (5.0 GiB each; the failed intermediate attempt root was removed after capture). ~16 GiB free on the data volume at lane end — the next 5 GiB-class staging step should be the last comfortable one without cleanup.

### 9.6 Hard-rule compliance (this change set)

- Edits only in the worktree (+ probe scripts under `/tmp/w6-27b-probe/` and fresh `/private/tmp` dry-run roots); live checkout, `/Users/evinova-self/mycelium-physical-run/**`, `serve-native.py`, launchd/services untouched.
- No `git commit`/push/trailers; `git status` still shows the same 6 modified files (model_adapters, model_manifest, runtime_contracts, runtime_loader, numpy_runtime, stage_pack) + 1 untracked test file, all unstaged.
- No secrets printed; no network downloads (local HF cache reads only; the dry-run fetch stub asserts model/revision).
- Python hygiene: `env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 /opt/homebrew/bin/python3.14 -I` for scripts; explicit `PYTHONPATH=<worktree>` for the required pytest commands. Cross-check scripts run in existing local venvs only.

### 9.7 GO / NO-GO for the driver

**GO — the hybrid linear-attention execution kernel is implemented, fail-closed, and verified**: both backends execute both hybrid layer kinds; numeric agreement with the artifact's native mlx_lm runtime (2–4e-6 at float32 rounding) and with transformers-torch once the normalization-eps convention is aligned (4.4e-6); 22 targeted tests green with a 9-test RED proof; full suite identical to the §8 baseline modulo the accounted-for pre-existing failures; and the prep-only dry run now completes with `load_result: LOADED` on the real verified artifact (including a real `linear_attention` layer slice), producing deterministic probe digests across repeated loads.

**NO-GO (as of this change set) for actual node staging → load-proof → qualify → serve**, because (a) the load path is proven only for the node-2-class slices; a full node-0-shaped load proof must be computed on the target host at stage time (memory/disk constrained, driver-owned); (b) serving still needs the packed-weight/dequant-on-the-fly + cache strategy and a performance path (this kernel is the slow reference); (c) owner commit + contract-manifest regeneration is still required (the 4 contracts/governance drift failures are the uncommitted-state signal); (d) §5 item 3 constraints stand (owner commit, laptop disk/SSH, node-0 memory pressure, controller staging via the bound operator plan).

Artifacts for this lane: `artifacts/w6-27b-native-adapter/` gains `worktree.diff` (refreshed), `dry_run.py` (updated), `dry_run_linear.py`, `load_probe_linear.py`, `spot_check_linear.py`, `cross_check.py`, `hf_cross_check.py`, `red_run_kernel.log`, `final_tests_run_kernel.log`, `root_tests_run_kernel.log`, `qwen35_tests_kernel.log`, `dry-run-20260913T152300Z.log`, `dry-run-20260913T152424Z.log`, `load-probe-linear.log`, `run-root-control-kernel-20260913T152300Z/` + `run-root-control-kernel-20260913T152424Z/` (both LOADED roots' control JSONs + markers), `run-root-paths-kernel.txt`.
