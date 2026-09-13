#!/bin/bash
set -euo pipefail

if [ "${W6_RESET_PAID_ROOT+x}" = x ]; then
  printf '%s\n' 'refusing to start: paid journal reset variable is present' >&2
  exit 78
fi

ENV_FILE="${W6_SUPERVISOR_ENV_FILE:-$HOME/.config/mycelium/w6-supervisors.env}"
if [ ! -f "$ENV_FILE" ] || [ "$(/usr/bin/stat -f '%Lp' "$ENV_FILE")" != 600 ]; then
  printf '%s\n' 'refusing to start: supervisor env file must exist with mode 0600' >&2
  exit 78
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ "${W6_RESET_PAID_ROOT+x}" = x ]; then
  printf '%s\n' 'refusing to start: paid journal reset variable is present' >&2
  exit 78
fi
: "${W6_PUBLIC_ORIGIN:?W6_PUBLIC_ORIGIN must be set in the supervisor env file}"
export W6_REUSE_PAID_ROOT=1
export W6_PUBLIC_ORIGIN

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="${W6_NODE_BIN:-/Users/evinova-self/.nvm/versions/node/v22.22.2/bin/node}"
[ -x "$NODE_BIN" ] || { printf '%s\n' 'refusing to start: W6_NODE_BIN is not executable' >&2; exit 78; }
cd "$REPO_ROOT"
exec "$NODE_BIN" "$REPO_ROOT/composition/w6-supervisors/resume-retained-app.mjs" paid
