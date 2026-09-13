#!/bin/sh
# tee-shim entrypoint: run the upstream Flask verifier on 8765 AND the
# tee_launcher.py shim on 8766 in parallel inside the same container.
#
# Both processes are foreground children of the shim shell.  SIGTERM is
# forwarded to both so docker stop / kubernetes shutdown is clean.
#
# Uses /bin/sh (busybox) semantics — no `wait -n`.  We poll child PIDs
# instead, which works on Alpine/busybox/Debian dash.

set -eu

UPSTREAM_PORT="${MYCELIUM_HTTP_PORT:-8765}"
TEE_PORT="${MYCELIUM_TEE_PORT:-8766}"

echo "[tee-shim] starting upstream verifier on :${UPSTREAM_PORT}"
python -B /opt/mycelium/verifier_server.py &
UPSTREAM_PID=$!

echo "[tee-shim] starting tee_launcher on :${TEE_PORT}"
python -B /opt/tee-launcher/tee_launcher.py &
TEE_PID=$!

shutdown() {
    echo "[tee-shim] signal received, forwarding to children"
    kill -TERM "${UPSTREAM_PID}" 2>/dev/null || true
    kill -TERM "${TEE_PID}" 2>/dev/null || true
    wait "${UPSTREAM_PID}" 2>/dev/null || true
    wait "${TEE_PID}" 2>/dev/null || true
}
trap shutdown TERM INT

# Poll both PIDs until one exits; the first exit triggers teardown.
EXIT_CODE=0
while kill -0 "${UPSTREAM_PID}" 2>/dev/null && kill -0 "${TEE_PID}" 2>/dev/null; do
    sleep 1
done

# One of them has exited.  Report whichever died first and tear down.
if kill -0 "${UPSTREAM_PID}" 2>/dev/null; then
    wait "${TEE_PID}" 2>/dev/null && EXIT_CODE=$? || EXIT_CODE=$?
    echo "[tee-shim] tee_launcher exited, tearing down upstream"
else
    wait "${UPSTREAM_PID}" 2>/dev/null && EXIT_CODE=$? || EXIT_CODE=$?
    echo "[tee-shim] upstream verifier exited, tearing down tee_launcher"
fi

shutdown
exit "${EXIT_CODE}"