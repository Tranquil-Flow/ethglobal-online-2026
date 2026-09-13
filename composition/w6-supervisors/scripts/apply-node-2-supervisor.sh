#!/bin/bash
# Installs node-2 files over the already-approved fleet SSH path. It never
# bootstraps or kickstarts the LaunchAgent.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
KEY="$HOME/.ssh/id_ed25519_m4pro_to_laptop"
REMOTE="evinova@100.126.111.123"
REMOTE_ROOT="/Users/evinova/mycelium-w6-n2/supervisor"
REMOTE_PLIST="/Users/evinova/Library/LaunchAgents/now.mycelium.node-2.plist"
SSH=(/usr/bin/ssh -i "$KEY" -o BatchMode=yes "$REMOTE")
SCP=(/usr/bin/scp -i "$KEY" -o BatchMode=yes)

[ -f "$KEY" ] || { printf 'missing SSH identity: %s\n' "$KEY" >&2; exit 66; }
/usr/bin/plutil -lint "$SOURCE_DIR/node-2/now.mycelium.node-2.plist" >/dev/null

"${SSH[@]}" "/bin/mkdir -p '$REMOTE_ROOT' '/Users/evinova/Library/LaunchAgents' '/Users/evinova/Library/Logs' && /bin/chmod 700 '$REMOTE_ROOT'"
"${SCP[@]}" "$SOURCE_DIR/node-2/run-node-2.sh" "$SOURCE_DIR/node-2/now.mycelium.node-2.plist" "$REMOTE:$REMOTE_ROOT/"
"${SSH[@]}" "/bin/chmod 700 '$REMOTE_ROOT/run-node-2.sh' && /usr/bin/install -m 644 '$REMOTE_ROOT/now.mycelium.node-2.plist' '$REMOTE_PLIST' && test -f '$REMOTE_ROOT/node-2.env' && test \"\$(/usr/bin/stat -f '%Lp' '$REMOTE_ROOT/node-2.env')\" = 600 && /usr/bin/plutil -lint '$REMOTE_PLIST'"

printf '%s\n' 'Installed node-2 files only. No remote LaunchAgent was loaded.'
printf '%s\n' 'At owner-present N3, after releasing the current node-2 process, run:'
printf "ssh -i '%s' -o BatchMode=yes '%s' 'launchctl bootstrap gui/\$(id -u) \"%s\"'\n" "$KEY" "$REMOTE" "$REMOTE_PLIST"
