#!/usr/bin/env bash
# Wave 6 v3 — wrapper for `graph deploy` of `ethonline-sepolia-receipts`
# to The Graph Studio. Owner-gated: requires GRAPH_DEPLOY_KEY in the
# supervisor env (~/.config/mycelium/w6-supervisors.env, mode 0600) or
# passed inline as the second positional argument.
#
# Usage:
#   packages/indexing/scripts/subgraph-deploy.sh [version-label] [deploy-key]
#
# Defaults:
#   version-label = v0.3.2
#   deploy-key    = $GRAPH_DEPLOY_KEY (from env)
#
# Side effects:
#   * cd to packages/indexing
#   * runs graph codegen + build
#   * runs graph deploy --version-label <label>
#   * writes artifacts/indexing/w6-<label>-deploy-{started,finished}.json
#
# Exit codes:
#   0  deploy accepted by Studio
#   2  GRAPH_DEPLOY_KEY missing
#   3  supervisor env file not 0600
#   4  graph codegen failed
#   5  graph build failed
#   6  graph deploy failed (Studio rejected)

set -euo pipefail

LABEL="${1:-v0.3.2}"
KEY="${2:-${GRAPH_DEPLOY_KEY:-}}"
WORKBENCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG_DIR="${WORKBENCH_ROOT}/packages/indexing"
ARTIFACT_DIR="${WORKBENCH_ROOT}/artifacts/indexing"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_FILE="${ARTIFACT_DIR}/w6-${LABEL}-deploy-started.json"
FINISHED_FILE="${ARTIFACT_DIR}/w6-${LABEL}-deploy-finished.json"
LOG_FILE="${ARTIFACT_DIR}/w6-${LABEL}-deploy.log"

mkdir -p "${ARTIFACT_DIR}"

# 1. Try to source supervisor env if we don't have a key yet.
if [[ -z "${KEY}" && -f "${HOME}/.config/mycelium/w6-supervisors.env" ]]; then
  perms="$(stat -f '%Lp' "${HOME}/.config/mycelium/w6-supervisors.env")"
  if [[ "${perms}" != "600" ]]; then
    echo "FATAL: supervisor env mode is ${perms}, must be 600" >&2
    exit 3
  fi
  set +u
  # shellcheck disable=SC1091
  . "${HOME}/.config/mycelium/w6-supervisors.env"
  set -u
  KEY="${GRAPH_DEPLOY_KEY:-}"
fi

if [[ -z "${KEY}" ]]; then
  cat <<EOF >&2
FATAL: GRAPH_DEPLOY_KEY is not set.
Set it in ~/.config/mycelium/w6-supervisors.env (mode 0600) and re-run, or pass
it as the second positional argument:

  $0 ${LABEL} '<deploy-key-from-thegraph-studio>'

The key is the Studio subgraph deploy token (NOT a wallet key). Find it in
https://thegraph.com/studio/subgraph/ethonline-sepolia-receipts -> "Deploy"
button -> "Show access token".
EOF
  exit 2
fi

cd "${PKG_DIR}"
GRAPH_BIN="${PKG_DIR}/node_modules/.bin/graph"

# 2. Write started record.
cat > "${STARTED_FILE}" <<EOF
{
  "label": "${LABEL}",
  "startedAt": "${STARTED_AT}",
  "subgraph": "ethonline-sepolia-receipts",
  "studioNode": "https://api.studio.thegraph.com/deploy/",
  "manifest": "subgraph/subgraph.yaml"
}
EOF

# 3. codegen (idempotent).
echo "[deploy] codegen..." | tee -a "${LOG_FILE}"
if ! "${GRAPH_BIN}" codegen subgraph/subgraph.yaml \
     --output-dir subgraph/generated >>"${LOG_FILE}" 2>&1; then
  echo "FATAL: graph codegen failed; see ${LOG_FILE}" >&2
  exit 4
fi

# 4. build.
echo "[deploy] build..." | tee -a "${LOG_FILE}"
if ! "${GRAPH_BIN}" build subgraph/subgraph.yaml >>"${LOG_FILE}" 2>&1; then
  echo "FATAL: graph build failed; see ${LOG_FILE}" >&2
  exit 5
fi

# 5. deploy.
echo "[deploy] graph deploy --version-label ${LABEL}..." | tee -a "${LOG_FILE}"
DEPLOY_OUTPUT="$("${GRAPH_BIN}" deploy \
  ethonline-sepolia-receipts \
  subgraph/subgraph.yaml \
  --node https://api.studio.thegraph.com/deploy/ \
  --deploy-key "${KEY}" \
  --version-label "${LABEL}" 2>&1)" || true
echo "${DEPLOY_OUTPUT}" >> "${LOG_FILE}"

# 6. Extract IPFS / deployment hash if present.
IPFS_HASH="$(echo "${DEPLOY_OUTPUT}" | sed -n 's/.*Build completed: \([A-Za-z0-9]\{46\}\).*/\1/p' | head -n1)"
DEPLOYMENT_ID="$(echo "${DEPLOY_OUTPUT}" | sed -n 's/.*Deployment ID: \([A-Za-z0-9]\{46\}\).*/\1/p' | head -n1)"

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 7. Detect success/failure from output.
if echo "${DEPLOY_OUTPUT}" | grep -q "Deployment ID:"; then
  EXIT_CODE=0
  STATUS="accepted"
elif echo "${DEPLOY_OUTPUT}" | grep -q "Failed to deploy to Graph node"; then
  EXIT_CODE=6
  STATUS="rejected"
else
  EXIT_CODE=6
  STATUS="unknown"
fi

cat > "${FINISHED_FILE}" <<EOF
{
  "label": "${LABEL}",
  "startedAt": "${STARTED_AT}",
  "finishedAt": "${FINISHED_AT}",
  "ipfsHash": "${IPFS_HASH}",
  "deploymentId": "${DEPLOYMENT_ID}",
  "status": "${STATUS}",
  "exitCode": ${EXIT_CODE},
  "logPath": "${LOG_FILE}"
}
EOF

if [[ "${EXIT_CODE}" -ne 0 ]]; then
  echo "FATAL: deploy failed (${STATUS}); see ${LOG_FILE} and ${FINISHED_FILE}" >&2
  exit "${EXIT_CODE}"
fi

echo "OK: deployed ${LABEL} (deploymentId=${DEPLOYMENT_ID}, ipfsHash=${IPFS_HASH})"
echo "Next: run the verification queries in packages/indexing/scripts/subgraph-deploy.md §4"
