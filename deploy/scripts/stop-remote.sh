#!/usr/bin/env bash
# Stop the SignalK demo stack on the remote Docker host and stop the
# boat-sim simulator container running there.
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-nav-server}"
CONTAINER="${SIGNALK_CONTAINER:-signalk-server}"

ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" \
  "docker rm -f boat-sim >/dev/null 2>&1 || true; docker stop '$CONTAINER' >/dev/null 2>&1 || true"

echo "remote demo stopped (host=$REMOTE_HOST container=$CONTAINER)."
