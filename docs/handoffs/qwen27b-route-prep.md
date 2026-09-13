# Qwen3.8-27B MLX 4-bit route prep — edge of qualification

Status: **prep-only complete to the safe edge**. I downloaded and verified the literal MTP repo and the actual base 27B MLX 4-bit route weights, inspected the existing 0.5B two-node route shape, documented stage-pack/load-proof bindings, and authored a two-node operator-plan template. I did **not** bind, stage, qualify, serve, restart launchd, or touch the live demo route.

## 1. Model download and verification

### Repos chosen

- **VERIFIED** (`hf download mlx-community/Qwen3.8-27B-MTP-4bit --revision b643c01b6d3b094e325edb6ebd832e16c486c575`): the literal requested repo exists and downloaded, but it is an MTP speculative-decoding draft/head artifact, not the base 27B model.
  - Snapshot: `~/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-MTP-4bit/snapshots/b643c01b6d3b094e325edb6ebd832e16c486c575`
  - `config.json` present.
  - Complete blob count: 9.
  - Complete blob logical bytes: **265,665,065 bytes**.
  - `model.safetensors` file bytes: **238,934,137 bytes**.
  - `model.safetensors.index.json` `metadata.total_size`: **238,930,944 bytes**.
  - On-disk cache size: `du -sh` = **253M**.
  - Reason this is not the base route: HF metadata/config identifies `model_type: qwen3_5_mtp`, tags include `mtp`, `speculative-decoding`, `draft-model`, and `base_model:Qwen/Qwen3.8-27B`; index contains only MTP/fc and one MTP layer scope.

- **VERIFIED** (`hf models info mlx-community/Qwen3.8-27B-4bit`; then `hf download mlx-community/Qwen3.8-27B-4bit --revision 3e6447f082e89cc7f0bc6e5441afd38dfce760ff`): I also downloaded the actual base 27B MLX 4-bit model required for a real 27B route.
  - Chosen because HF metadata says `base_model:Qwen/Qwen3.8-27B`, `model_type: qwen3_5`, 27.36B parameters, and three large safetensor shards.
  - Snapshot: `~/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/snapshots/3e6447f082e89cc7f0bc6e5441afd38dfce760ff`
  - `config.json` present: **4,932 bytes**.
  - `model.safetensors.index.json` present.
  - Snapshot entry count: **15**.
  - Complete blob count: **15**.
  - Complete blob logical bytes: **16,081,490,933 bytes**.
  - Model shard file sizes:
    - `model-00001-of-00003.safetensors`: **5,343,268,662 bytes**
    - `model-00002-of-00003.safetensors`: **5,354,185,130 bytes**
    - `model-00003-of-00003.safetensors`: **5,357,087,557 bytes**
  - Measured shard-file total: **16,054,541,349 bytes**.
  - Index tensor-data total (`metadata.total_size`): **16,054,262,240 bytes**; the 279,109 byte difference is safetensors file/header overhead.
  - Full snapshot logical bytes, all files: **16,081,490,933 bytes**.
  - Current repo cache `du -sh`: **26G**, because the first download attempt was interrupted and left duplicate `.incomplete` files.
  - Leftover interrupted `.incomplete` blob count: **3**.
  - Leftover interrupted `.incomplete` logical bytes: **12,322,584,621 bytes**.
  - Current repo-cache logical bytes excluding symlinks: **28,404,078,017 bytes**.
  - I did **not** delete the incomplete cache residue. It is recoverable disk if the owner approves cleanup.

### Disk after download

- **VERIFIED** (`df -h /System/Volumes/Data` after download): `/System/Volumes/Data` had **51GiB free**, 95% capacity used.
- **VERIFIED** (`du -sh ~/.cache/huggingface/hub/models--mlx-community--Qwen3.8-27B-4bit/`): base model cache directory reports **26G** because it includes the verified model plus 12.32GB interrupted partials.
- **INFERRED**: deleting only the failed `.incomplete` files would recover about **12.32GB**, but I did not remove them.

## 2. Existing 0.5B route shape to reproduce

### 0.5B deployment shape

- **VERIFIED** (`RUN/native-preparation-01/preparation.json`): current 0.5B prep bundle is preparation-only, model `Qwen/Qwen2.5-0.5B-Instruct`, ranges:
  - node-0/stage-000: layers `0..23` exclusive end `23`, layer count 23.
  - node-2/stage-001: layer `23..24`, layer count 1.
  - remote payload bytes in prep record: **309,159,549 bytes**.

- **VERIFIED** (`transfer-bundle/control/m13-route-plan.json`): selected runtime topology is two nodes:
  - `node-0`: MLX backend, placement `stage-000-primary`, layers 0-22, service capacity 15.2555 rps.
  - `node-2`: NumPy backend, placement `stage-001-primary`, layer 23 plus final components, service capacity 7.0175 rps.
  - Route forward edge: `node-0 -> node-2`; loopback edge: `node-2 -> node-0`.
  - `entry_node_id`: `node-0`.

- **VERIFIED** (`transfer-bundle/deployment` file stat script): 0.5B deployment bundle contains 11 files and **999,611,816 logical bytes**:
  - `model-stage-001-of-002.safetensors`: 686,000,304 bytes
  - `model-stage-002-of-002.safetensors`: 29,826,080 bytes
  - `model-static-embedding.safetensors`: 272,269,416 bytes
  - `model-static-output.safetensors`: 1,880 bytes
  - config/tokenizer/index/projection files make up the remainder.

- **VERIFIED** (`transfer-bundle/control/node-0-assignment.json`): node-0 assignment shape:
  - protocol `mycelium.layer_assignment.v2`
  - `components`: `input_embedding`, `decoder`
  - `range`: `start_layer=0`, `end_layer_exclusive=23`, `layer_count=23`
  - runtime: `architecture=qwen2`, `backend=mlx`, `dtype=float32`, `quantization=int8-weight-only`
  - files: stage-001 shard + static embedding.

- **VERIFIED** (`node-2-proof.json`): node-2 assignment shape:
  - components: `decoder`, `final_norm`, `lm_head`
  - range: `start_layer=23`, `end_layer_exclusive=24`, `layer_count=1`
  - runtime backend: `numpy`
  - `resolved_component_aliases`: `lm_head` targets `input_embedding` tensor key for tied embeddings.

### Stage-pack checklist for a 27B stage pack

A 27B stage pack must mirror this structure, with new model identity, runtime config, tensor keys, range, files, and digests:

1. **Deployment payload under `transfer-bundle/deployment/`** — **VERIFIED** from 0.5B bundle and `stage_pack_builder.py`:
   - model config and tokenizer files (`config.json`, `tokenizer_config.json`, `tokenizer.json`, `vocab.json`, plus Qwen3.8 VLM-specific processor/preprocessor files if retained)
   - `model.safetensors.index.json`
   - stage-specific safetensors files whose tensor keys match each assignment's `expected_tensor_keys`
   - optional `m13-placement-projection.json` / route projection if produced by the same builder path.

2. **Per-node control documents under `transfer-bundle/control/`** — **VERIFIED** from existing `transfer-bundle/control/`:
   - `execution-graph.json`
   - `m13-route-plan.json`
   - `m13-planner-snapshot.json`
   - `model-manifest.json`
   - `node-N-assignment.json`
   - `node-N-stage-pack.json`
   - `node-N-stage-pack-verification.json`
   - `node-N-artifact-report.json` for loader input
   - `node-N-load-proof.json` computed after target-host load
   - `node-transfer-manifests.json` and global `transfer-manifest.json` in prepare inputs/operator plan.

3. **Operator-plan control-plane wrapper** — **VERIFIED** from `operator-plan-template.json` / `operator-plan-for-serve-03.json`:
   - top-level: `protocol`, `plan_id`, `run_id`, `now_unix_ms`, `paths`, `verification_keys`, `controller`
   - `controller.membership_snapshot.assignment_offers[]` with each offer's `assignment_id`, `assignment_digest`, `recipient_node_id`, `stage_pack_digest`, `graph_digest`, `load_generation`, peer endpoint records, and seed signature
   - `controller.peers[]` with node ID, process transport, SSH target, key-file path, staging root, host ID and boot ID after run-id rotation
   - `controller.run_plan` with `entry_node_id=node-0`, node ordering, decode request, expected token IDs, deployment/run IDs.

4. **Self-binding digests and IDs**:
   - **VERIFIED** (`mycelium_live/stage_pack_builder.py`, lines around assignment binding): stage pack build rejects unless `assignment_offer.assignment_id == pack.assignment_id`, `assignment_offer.recipient_node_id == pack.node_id`, and `assignment_offer.stage_pack_digest == pack.stage_pack_digest`.
   - **VERIFIED** (`stage_pack_builder.py`): `stage_pack_digest` is computed by hashing the ordered assigned artifact payload bytes; the acquisition manifest stores `stage_pack_digest`, `assignment_id`, `assignment_digest`, `graph_digest`, layer range, component scope, and `tensor_scope_digest`.
   - **VERIFIED** (`runtime_loader.py` `_validated_stage_pack_binding`): loader accepts propagated stage-pack evidence only when `stage_pack`, `stage_pack_manifest`, `stage_pack_verification`, `stage_pack_digest`, and `stage_pack_verification_digest` are all present and mutually validating.
   - **VERIFIED** (`transfer-bundle/control/execution-graph.json` and `live-qualification.json`): each active placement embeds `assignment_id`, `stage_signature`, and `load_proof_digest`; live qualification stage bindings repeat `assignment_id`, `stage_id`, `placement_id`, `node_id`, `endpoint_id`, `process_host_id`, and `load_proof_digest`.
   - **INFERRED**: for 27B, every model digest (`manifest_digest`, `source_manifest_digest`, route graph digest, assignment digest, stage pack digest, load proof digest) must be regenerated from the 27B files and cannot be reused from 0.5B.

## 3. Load-proof host constraint

- **VERIFIED** (`runtime_loader.py`, `_actual_runtime_identity`, lines 1799-1826): load proof includes target-runtime-derived identity:
  - MLX backend version via `importlib.metadata.version("mlx")`
  - MLX device via `str(mx.default_device())`
  - dtype, quantization, architecture.

- **VERIFIED** (`runtime_loader.py`, `load_assignment_stage`, lines 1970-2031): load proof is produced only after exact artifact report validation, tensor load, finite checks, tensor digest computation, runtime identity capture, and deterministic probe execution.

- **VERIFIED** (`mycelium_physical_runner/remote_probe.py`, lines 79-102 and 131-161): physical `host_id` derives from the Darwin `IOPlatformUUID`, then becomes a run-scoped `host-<digest>` using `run_id`.

- **VERIFIED** (`mycelium_qualification/live.py`, lines 377-393): live qualification binds selected placement's `load_proof_digest` to the configured process observation and records `process_host_id=configured_observation["host_id"]`.

- **Conclusion — VERIFIED/INFERRED**: a load proof for a two-node placement must be computed on the host that will run that assignment:
  - node-0 assignment proof must be computed on node-0 (M4 Pro 48GB), from node-0's local artifacts and MLX runtime.
  - node-2/node-3 laptop assignment proof must be computed on the laptop, from the laptop's staged artifacts and runtime.
  - A locally computed proof for the laptop assignment is invalid for qualification because it would carry node-0 runtime identity and would not bind to the laptop's run-scoped host/process observation.

## 4. Feasibility numbers

### Node-0 disk feasibility

- **VERIFIED** after download:
  - `/System/Volumes/Data`: **51GiB free**.
  - Verified base 27B snapshot logical bytes: **16,081,490,933 bytes**.
  - Complete model shard file bytes: **16,054,541,349 bytes**.
  - MTP repo complete blob bytes: **265,665,065 bytes**.
  - Interrupted base download residue: **12,322,584,621 bytes** in `.incomplete` files.

- **INFERRED** from 0.5B deployment packaging: a base-only 27B `transfer-bundle/deployment` copy would require about **16.1GB** logical bytes before control files, or about **16.35GB** if the MTP artifact is also packaged.

- **INFERRED** from `stage_pack_builder.py`: if acquisition chunk objects are materialized in addition to deployment files, budget roughly another copy of assigned payload bytes. Worst-case prep disk for cache + deployment + chunks is about:
  - base-only: ~16.1GB cache + ~16.1GB deployment + ~16.1GB chunks = **~48.3GB logical**
  - current cache already includes the verified model plus 12.3GB failed partials, so the immediate free-space margin is safe but not comfortable.

- **Readiness**: node-0 disk is sufficient for one 27B prep attempt if no more large duplicate partials accumulate. Recommend owner-approved cleanup of the 12.32GB `.incomplete` residue before stage/qualify.

### Node-0 RAM/runtime feasibility

- **VERIFIED** (`config.json` parse): Qwen3.8/Qwen3.5 config:
  - `num_hidden_layers=64`
  - `hidden_size=5120`
  - `num_attention_heads=24`
  - `num_key_value_heads=4`
  - `head_dim=256`
  - `max_position_embeddings=262144`
  - `dtype=bfloat16`
  - `vocab_size=248320`

- **VERIFIED** (header parse, no tensor load): tensor-data categories:
  - language embedding: **715,161,600 bytes**
  - language layers total: **13,702,468,608 bytes**
  - final norm + LM head: **715,171,840 bytes**
  - vision tower: **921,460,192 bytes**
  - total tensor data: **16,054,262,240 bytes**.

- **VERIFIED/INFERRED** (config-derived KV cache math, BF16 K/V): KV-cache memory per request track:
  - 1,024 tokens: **0.25GiB**
  - 4,096 tokens: **1.0GiB**
  - 8,192 tokens: **2.0GiB**
  - 32,768 tokens: **8.0GiB**
  - 262,144 tokens: **64.0GiB**, impossible on the 48GB host before weights.

- **VERIFIED** (`vm_stat`, `memory_pressure`): node-0 total memory is **51,539,607,552 bytes** (48GiB). At measurement time it had about **75k free 16KB pages (~1.15GiB)** and about **976,761 compressor pages (~14.9GiB)**, with substantial historical swap I/O.

- **Conclusion**: 4-bit 27B is **marginal** on node-0 alongside the active desktop/demo fleet. Weights plus short-context KV likely fit on a 48GB M4 Pro if context is capped and no other heavy ML runs, but full 262k context cannot fit, and current memory pressure means qualification should include a fresh memory-pressure gate. Do not serve this beside the live route without a deliberate maintenance window.

### Laptop node disk/RAM feasibility

- **VERIFIED** (successful SSH probe earlier in this run): laptop at `100.126.111.123` reported:
  - macOS 15.6.1, arm64
  - memory: **17,179,869,184 bytes** (16GiB)
  - disk on `/System/Volumes/Data`: **3.2GiB free** at measurement time
  - IOPlatformUUID observed for host identity derivation: `01C8FE98-E6BF-5FF7-9F22-21114FF18F7A`

- **VERIFIED** (later SSH retries): subsequent SSH attempts timed out, so I did not take a new laptop measurement after the model download.

- **VERIFIED** (header parse): minimal final-stage artifact sizes if using a node-0-heavy split:
  - final 1 language layer + final norm + LM head: **924,580,864 bytes**
  - final 2 language layers + final norm + LM head: **1,140,245,952 bytes**
  - final 4 language layers + final norm + LM head: **1,571,576,128 bytes**
  - final 8 language layers + final norm + LM head: **2,427,980,416 bytes**
  - final 16 language layers + final norm + LM head: **4,140,788,992 bytes**

- **Conclusion**:
  - The laptop cannot hold the full base snapshot or any plan requiring full-model staging.
  - A minimal **1-final-layer** stage should fit on disk if only one artifact copy is staged, but it is tight if the staging process materializes both deployment files and chunk-object copies.
  - With only 3.2GiB free, final 4 layers is unsafe if duplicated; final 8+ is not safe.
  - If using the laptop as node-2/node-3, free at least several additional GB before stage; for comfortable one-layer qualification target **>=6-8GiB free**.

## 5. Ordered two-node operator-plan template (prep only; not bound)

Chosen topology: **node-0 + node-2**, not node-3, because the current durable seed state already has `node-0` and `node-2` members. A node-3 variant is possible only after node-3 membership/endpoint identity exists in seed state.

- **VERIFIED** (`seed/state.sqlite3` read-only): seed members include `node-0` and `node-2`; there is no `node-3` row in the inspected seed state.
- **VERIFIED** (`operator-plan-for-serve-03.json`): current 0.5B operator plan uses `node-0` local and `node-2` SSH with key path `/Users/evinova-self/.ssh/id_ed25519_m4pro_to_laptop` and SSH target `evinova@100.126.111.123`.

### Proposed split

- **stage-000 / placement-000 / node-0**
  - components: `input_embedding`, `decoder`
  - layers: `0..63` exclusive end `63` (63 of 64 language layers)
  - if VLM assets are retained, put `vision_tower` on node-0 only.
  - text-only approximate assigned bytes: **14,208,221,184 bytes**
  - with vision tower approximate assigned bytes: **15,129,681,376 bytes**
  - backend: MLX on node-0.

- **stage-001 / placement-001 / node-2**
  - components: `decoder`, `final_norm`, `lm_head`
  - layers: `63..64` exclusive end `64` (1 final language layer)
  - approximate assigned bytes: **924,580,864 bytes**
  - backend: preferably MLX if available on laptop and loader supports the model; NumPy fallback likely too slow but may satisfy proof/load if compatible.

### Exact fields that differ from the 0.5B plan

Every digest below must be regenerated by the native prep/build path; none can be copied from the 0.5B route.

```json
{
  "protocol": "mycelium.physical_runner_operator_plan.v1",
  "plan_id": "w6-qwen38-27b-two-node-prep",
  "run_id": "w6-qwen38-27b-native-01",
  "controller": {
    "source_root": "/Users/evinova-self/mycelium-physical-run/w6-qwen38-27b-prep-01/native-preparation-01/transfer-bundle",
    "run_plan": {
      "deployment_id": "<new-27b-deployment-id>",
      "entry_node_id": "node-0",
      "run_id": "w6-qwen38-27b-native-01",
      "nodes": [
        {"node_id": "node-0", "stage_id": "stage-000", "placement_id": "placement-000"},
        {"node_id": "node-2", "stage_id": "stage-001", "placement_id": "placement-001"}
      ]
    },
    "peers": [
      {
        "node_id": "node-0",
        "process_transport": "local",
        "ssh_target": "evinova-self@m4pro",
        "ssh_identity_file": null,
        "staging_root": "/Users/evinova-self/mycelium-w6-qwen38-27b-n0",
        "host_id": "<refreshed-by-bind_operator_plan_to_seed>",
        "boot_id": "<refreshed-by-bind_operator_plan_to_seed>"
      },
      {
        "node_id": "node-2",
        "process_transport": "ssh",
        "ssh_target": "evinova@100.126.111.123",
        "ssh_identity_file": "/Users/evinova-self/.ssh/id_ed25519_m4pro_to_laptop",
        "staging_root": "/Users/evinova/mycelium-w6-qwen38-27b-n2",
        "host_id": "<refreshed-by-bind_operator_plan_to_seed>",
        "boot_id": "<refreshed-by-bind_operator_plan_to_seed>"
      }
    ],
    "membership_snapshot": {
      "deployment_id": "<new-27b-deployment-id>",
      "assignment_offers": [
        {
          "message": {
            "assignment_id": "<new-node-0-assignment-id>",
            "recipient_node_id": "node-0",
            "assignment_digest": "<sha256 over node-0 27b assignment>",
            "stage_pack_digest": "<sha256 over node-0 assigned artifacts>",
            "graph_digest": "<sha256 over 27b execution graph>",
            "load_generation": "<new 27b load generation>"
          }
        },
        {
          "message": {
            "assignment_id": "<new-node-2-assignment-id>",
            "recipient_node_id": "node-2",
            "assignment_digest": "<sha256 over node-2 27b assignment>",
            "stage_pack_digest": "<sha256 over node-2 assigned artifacts>",
            "graph_digest": "<sha256 over 27b execution graph>",
            "load_generation": "<new 27b load generation>"
          }
        }
      ]
    }
  }
}
```

### Required assignment/runtime field changes

- `model_id`: use `mlx-community/Qwen3.8-27B-4bit` for the downloaded immutable MLX route artifact.
- `resolved_commit`: `3e6447f082e89cc7f0bc6e5441afd38dfce760ff`.
- `runtime.model_config`: regenerate from the 27B `config.json`:
  - layers 64, hidden size 5120, vocab 248320, KV heads 4, head dim 256, max positions 262144.
- `runtime.architecture`: must be a native-supported architecture string. **Blocker:** current code has no `qwen3_5` handling.
- tensor keys/prefixes: must change from `model.layers.*` Qwen2 tensors to `language_model.model.layers.*`, `linear_attn.*`, `language_model.model.embed_tokens.*`, `language_model.lm_head.*`, and possibly `vision_tower.*`.
- `node_transfer_manifests.manifests`: keys must be `node-0` and `node-2`, with 27B control/deployment files and digests.
- `verification_keys`: regenerated if a fresh load-proof signer is used; otherwise bound by the prep builder's signer output.
- `paths`: point to the 27B prep run root, not `native-preparation-01` from the live 0.5B route.

### Exact rebind command (do not run yet)

Use the native runtime interpreter discipline specified by the owner:

```bash
env -u PYTHONPATH PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  /opt/homebrew/bin/python3.14 -I \
  /Users/evinova-self/Documents/playground/mycelium-wave8-integration/scripts/bind_operator_plan_to_seed.py \
  --operator-plan /Users/evinova-self/mycelium-physical-run/w6-qwen38-27b-prep-01/native-preparation-01/operator-plan-template.json \
  --seed-state-root /Users/evinova-self/mycelium-physical-run/w6-ethonline-20260912T090309Z/seed \
  --output /Users/evinova-self/mycelium-physical-run/w6-qwen38-27b-prep-01/native-preparation-01/operator-plan-bound.json \
  --rotate-run-id w6-qwen38-27b-native-01
```

This command only binds/refreshes the template against current seed members and run-scoped host IDs; it is still **before** stage/qualify/serve. I did not run it.

## 6. Blockers and assumptions

### Hard blockers before stage/qualify/serve

1. **Native runtime compatibility is not proven for Qwen3.8/Qwen3.5 VLM tensors.**
   - **VERIFIED** (`search_files`): native repo has no matches for `qwen3_5`, `linear_attn`, or `language_model.model`.
   - Existing runtime handles Qwen2-style tensor names and architecture values `qwen2`/`qwen3`; Qwen3.8 model files use `qwen3_5`, `language_model.model.layers.*`, and `linear_attn.*` tensors.
   - This likely blocks `assignment_stage_pack` generation and/or `load_assignment_stage` until adapter/runtime support is added or confirmed elsewhere.

2. **Laptop disk is too tight for anything but a minimal final-stage placement.**
   - **VERIFIED**: laptop free space was 3.2GiB on successful SSH probe.
   - A 1-final-layer final stage is ~924.6MB before staging overhead; with chunk/object duplication it can approach ~1.85GB plus control/runtime files.
   - Free several GB before staging; otherwise artifact copy/proof may fail mid-stage.

3. **Laptop SSH became unavailable during later probes.**
   - **VERIFIED**: later `ssh ... evinova@100.126.111.123` attempts timed out.
   - Must be reachable before any rebind/identity refresh/stage attempt.

4. **Single-host route is not live-valid.**
   - **VERIFIED** (`mycelium_live/supervisor.py`, lines 112-126): startup rejects if `len(node_ids) < 2` with `startup_endpoint_identity_invalid`.
   - Therefore a single 48GB host may load the model for local testing, but cannot satisfy Mycelium live route identity rules.

5. **Full 262k context cannot fit on 48GB.**
   - **VERIFIED/INFERRED**: KV cache alone is ~64GiB at 262,144 tokens, before 16GB weights and runtime overhead.

6. **Interrupted cache residue should be cleaned only with owner approval.**
   - **VERIFIED**: 12,322,584,621 bytes of `.incomplete` files remain in the HF cache.
   - Not a functional blocker now, but it reduces the disk margin for future stage-pack generation.

### Assumptions that would invalidate the plan

- If the actual intended route requires the **MTP speculative draft** in addition to the base model, add 265,665,065 complete blob bytes plus integration work for the MTP head.
- If stage-pack tooling insists on staging the **entire base model** on every node, the laptop placement is impossible with current disk.
- If the route must use node-3 specifically, node-3 must first exist in seed membership with endpoint identity; current inspected seed state has node-2, not node-3.
- If `build_qwen_live_route.py` cannot be parameterized away from the built-in 0.5B Qwen2 assumptions, a new prep builder or adapter changes are required before qualification.
- If the live demo route must remain active with no maintenance window, node-0 memory pressure makes concurrent 27B qualification risky.

## 7. Next safe step

Single next step: **do not stage yet**. First, add or confirm native support for `mlx-community/Qwen3.8-27B-4bit` / `qwen3_5` tensor naming and linear-attention execution in the stage-pack/runtime loader path, then perform a dry-run assignment/stage-pack build into a new prep-only run root. After that, compute load proofs on node-0 and the laptop in a controlled window.
