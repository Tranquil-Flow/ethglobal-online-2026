#!/usr/bin/env bash
# Fixed-scope laptop control; no caller-selected host, model or SSH identity.
set -euo pipefail
if [[ $# -ne 1 ]]; then printf '%s\n' FIXED_WAVE5_SCOPE >&2; exit 64; fi
case "$1" in install|serve|pull|inspect|stop) ;; *) printf '%s\n' FIXED_WAVE5_SCOPE >&2; exit 64;; esac
if [[ ${WAVE5_LAPTOP_BOOTSTRAP_APPROVED:-} != 1 ]]; then printf '%s\n' LAPTOP_APPROVAL_REQUIRED >&2; exit 64; fi
here=$(cd -- "$(dirname -- "$0")" && pwd)
opts=(-o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -i "$HOME/.ssh/id_ed25519_m4pro_to_laptop")
ssh "${opts[@]}" mycelium-laptop 'set -e; umask 077; test ! -L "$HOME/.private"; test ! -L "$HOME/.private/wave5"; mkdir -p "$HOME/.private/wave5"; chmod 700 "$HOME/.private/wave5"'
scp "${opts[@]}" "$here/ollama-node-bootstrap.py" mycelium-laptop:.private/wave5/ollama-node-bootstrap.py
exec ssh "${opts[@]}" mycelium-laptop "/usr/bin/python3 -B \$HOME/.private/wave5/ollama-node-bootstrap.py $1"
