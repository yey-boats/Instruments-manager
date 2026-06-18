#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${SIGNALK_CONTAINER:-signalk-server}"

docker rm -f boat-sim >/dev/null 2>&1 || true
docker stop "$CONTAINER" >/dev/null 2>&1 || true

echo "demo stopped."
