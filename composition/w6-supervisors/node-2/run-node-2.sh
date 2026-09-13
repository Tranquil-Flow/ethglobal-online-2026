#!/bin/bash
set -euo pipefail

if [ "${W6_RESET_PAID_ROOT+x}" = x ]; then
  printf '%s\n' 'refusing to start: journal reset variable is present' >&2
  exit 78
fi
ENV_FILE="${W6_NODE2_ENV_FILE:-/Users/evinova/mycelium-w6-n2/supervisor/node-2.env}"
if [ ! -f "$ENV_FILE" ] || [ "$(/usr/bin/stat -f '%Lp' "$ENV_FILE")" != 600 ]; then
  printf '%s\n' 'refusing to start: node-2 env file must exist with mode 0600' >&2
  exit 78
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
if [ "${W6_RESET_PAID_ROOT+x}" = x ]; then
  printf '%s\n' 'refusing to start: journal reset variable is present' >&2
  exit 78
fi
: "${W6_NODE2_EXECUTABLE:?W6_NODE2_EXECUTABLE is required}"
: "${W6_NODE2_ARGUMENTS_FILE:?W6_NODE2_ARGUMENTS_FILE is required}"
: "${W6_NODE2_WORKDIR:?W6_NODE2_WORKDIR is required}"
[ "${W6_NODE2_EXECUTABLE#/}" != "$W6_NODE2_EXECUTABLE" ] || { printf '%s\n' 'W6_NODE2_EXECUTABLE must be absolute' >&2; exit 78; }
[ -x "$W6_NODE2_EXECUTABLE" ] || { printf '%s\n' 'W6_NODE2_EXECUTABLE is not executable' >&2; exit 78; }
[ -d "$W6_NODE2_WORKDIR" ] || { printf '%s\n' 'W6_NODE2_WORKDIR is not a directory' >&2; exit 78; }
[ -f "$W6_NODE2_ARGUMENTS_FILE" ] || { printf '%s\n' 'W6_NODE2_ARGUMENTS_FILE is missing' >&2; exit 78; }
[ "$(/usr/bin/stat -f '%Lp' "$W6_NODE2_ARGUMENTS_FILE")" = 600 ] || { printf '%s\n' 'W6_NODE2_ARGUMENTS_FILE must have mode 0600' >&2; exit 78; }

args=()
while IFS= read -r argument || [ -n "$argument" ]; do
  [ -z "$argument" ] || args+=("$argument")
done < "$W6_NODE2_ARGUMENTS_FILE"
[ "${#args[@]}" -gt 0 ] || { printf '%s\n' 'W6_NODE2_ARGUMENTS_FILE must contain one argument per line' >&2; exit 78; }
cd "$W6_NODE2_WORKDIR"
exec "$W6_NODE2_EXECUTABLE" "${args[@]}"
