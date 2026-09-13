#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${W6_SUPERVISOR_ENV_FILE:-$HOME/.config/mycelium/w6-supervisors.env}"
DEST_DIR="$HOME/Library/LaunchAgents"

if [ ! -f "$ENV_FILE" ]; then
  printf 'missing supervisor env file: %s\n' "$ENV_FILE" >&2
  exit 66
fi
if [ "$(/usr/bin/stat -f '%Lp' "$ENV_FILE")" != 600 ]; then
  printf 'supervisor env file must have mode 0600: %s\n' "$ENV_FILE" >&2
  exit 77
fi

/bin/mkdir -p "$HOME/Library/Logs" "$DEST_DIR"
for label in \
  now.mycelium.paid-app \
  now.mycelium.free-app \
  now.mycelium.edge \
  now.mycelium.route27b \
  now.mycelium.local-verifier
do
  source_plist="$SOURCE_DIR/$label.plist"
  /usr/bin/plutil -lint "$source_plist" >/dev/null
  /usr/bin/install -m 644 "$source_plist" "$DEST_DIR/$label.plist"
  case "$label" in
    now.mycelium.paid-app|now.mycelium.free-app|now.mycelium.edge)
      /usr/bin/plutil -replace EnvironmentVariables.W6_SUPERVISOR_ENV_FILE -string "$ENV_FILE" "$DEST_DIR/$label.plist"
      ;;
  esac
  /usr/bin/plutil -lint "$DEST_DIR/$label.plist" >/dev/null
done

printf '%s\n' 'Installed files only. No LaunchAgent was loaded.'
printf '%s\n' 'At the owner-present H3 cutover, after releasing the existing listeners, run:'
printf 'launchctl bootstrap gui/%s "%s"\n' "$(id -u)" "$DEST_DIR/now.mycelium.free-app.plist"
printf 'launchctl bootstrap gui/%s "%s"\n' "$(id -u)" "$DEST_DIR/now.mycelium.paid-app.plist"
printf 'launchctl bootstrap gui/%s "%s"\n' "$(id -u)" "$DEST_DIR/now.mycelium.edge.plist"
printf '%s\n' 'The route27b and local-verifier placeholders remain disabled and must not be bootstrapped.'
