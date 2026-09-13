#!/bin/bash
set -euo pipefail

ENV_FILE="${W6_SUPERVISOR_ENV_FILE:-$HOME/.config/mycelium/w6-supervisors.env}"
if [ ! -f "$ENV_FILE" ] || [ "$(/usr/bin/stat -f '%Lp' "$ENV_FILE")" != 600 ]; then
  printf '%s\n' 'refusing to start: supervisor env file must exist with mode 0600' >&2
  exit 78
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
NODE_BIN="${W6_NODE_BIN:-/Users/evinova-self/.nvm/versions/node/v22.22.2/bin/node}"
[ -x "$NODE_BIN" ] || { printf '%s\n' 'refusing to start: Node 22.22.2 binary unavailable' >&2; exit 78; }
[ "$($NODE_BIN --version)" = "v22.22.2" ] || { printf '%s\n' 'refusing to start: Node must be 22.22.2' >&2; exit 78; }

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# Deliberately pass only non-secret status flags. Keys, bearers, and signer
# material sourced by other supervisors never enter the console process.
exec /usr/bin/env -i \
  HOME="$HOME" USER="${USER:-evinova-self}" TMPDIR="${TMPDIR:-/tmp}" PATH="/usr/bin:/bin:/opt/homebrew/bin" \
  OWNER_CONSOLE_HOST="127.0.0.1" OWNER_CONSOLE_PORT="4360" \
  OWNER_CONSOLE_FEEDBACK_FILE="${OWNER_CONSOLE_FEEDBACK_FILE:-/Users/evinova-self/Documents/playground/mycelium-parallel-prompts-3zwvxhg7/foundation/continuations/hackathon-app-03/workbench/artifacts/owner-feedback/feedback.jsonl}" \
  W6_DEMO_SPONSOR_ENABLED="${W6_DEMO_SPONSOR_ENABLED:-}" W6_DEMO_SPONSOR_ACCOUNT="${W6_DEMO_SPONSOR_ACCOUNT:-}" \
  W6_HEDERA_WALLET_ENABLED="${W6_HEDERA_WALLET_ENABLED:-}" W6_WALLET_W2_PASSED="${W6_WALLET_W2_PASSED:-}" \
  W6_05B_ENSEMBLE_V6_PASSED="${W6_05B_ENSEMBLE_V6_PASSED:-}" W6_27B_ENABLED="${W6_27B_ENABLED:-}" W6_27B_M2_PASSED="${W6_27B_M2_PASSED:-}" \
  W6_VERIFIER_TEE_URL="${W6_VERIFIER_TEE_URL:-}" W6_VERIFIER_LOCAL_CMD="${W6_VERIFIER_LOCAL_CMD:-}" W6_VERIFIER_POLICY_VERSION="${W6_VERIFIER_POLICY_VERSION:-}" \
  W6_APP_STATE_DIR="${W6_APP_STATE_DIR:-}" \
  W6_VERIFIER_AUDIT_PROBABILITIES_JSON="${W6_VERIFIER_AUDIT_PROBABILITIES_JSON:-}" W6_TEE_G11_PASSED="${W6_TEE_G11_PASSED:-}" \
  W6_ESCROW_ENABLED="${W6_ESCROW_ENABLED:-}" W6_ESCROW_G14_PASSED="${W6_ESCROW_G14_PASSED:-}" \
  W6_STAKING_ENABLED="${W6_STAKING_ENABLED:-}" W6_SLASHING_ENABLED="${W6_SLASHING_ENABLED:-}" W6_SLASHING_G16_PASSED="${W6_SLASHING_G16_PASSED:-}" \
  W6_VERIFICATION_LEDGER_GRAPH_ENDPOINT="${W6_VERIFICATION_LEDGER_GRAPH_ENDPOINT:-}" \
  W6_JUDGE_PACKAGE_ENABLED="${W6_JUDGE_PACKAGE_ENABLED:-}" W6_A8_J3_PASSED="${W6_A8_J3_PASSED:-}" W6_JUDGE_AUDITS_ENABLED="${W6_JUDGE_AUDITS_ENABLED:-}" \
  "$NODE_BIN" "$SCRIPT_DIR/src/cli.mjs"
