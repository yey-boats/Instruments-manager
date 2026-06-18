#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_DIR="$ROOT/deploy/config"
PLUGIN_DIR="$ROOT"
CONTAINER="${SIGNALK_CONTAINER:-signalk-server}"
IMAGE="${SIGNALK_IMAGE:-signalk/signalk-server:latest}"
SK_HOST="${SK_HOST:-localhost}"
SK_PORT="${SK_PORT:-3000}"
PYTHON="${PYTHON:-/usr/bin/python3}"

mkdir -p "$CONFIG_DIR/plugin-config-data"

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker rm -f "$CONTAINER" >/dev/null
fi

docker run --rm \
  --entrypoint npm \
  -v "$CONFIG_DIR:/home/node/.signalk" \
  -v "$PLUGIN_DIR:/home/node/plugins/signalk-espdisp-manager" \
  -w /home/node/.signalk \
  "$IMAGE" \
  install

docker run -d \
  --name "$CONTAINER" \
  -p 3000:3000 \
  -p 10110:10110 \
  -p 34300:34300/udp \
  -p 34301:34301/udp \
  -v "$CONFIG_DIR:/home/node/.signalk" \
  -v "$PLUGIN_DIR:/home/node/plugins/signalk-espdisp-manager" \
  "$IMAGE" >/dev/null

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "$PYTHON" - "$SK_HOST" "$SK_PORT" <<'PY'
import sys
import urllib.request

host, port = sys.argv[1], int(sys.argv[2])
try:
    urllib.request.urlopen(f"http://{host}:{port}/signalk", timeout=2)
except Exception:
    raise SystemExit(1)
PY
  then
    break
  fi
  sleep 1
done

# Synthetic boat data: the productized simulator image built by GitHub Actions
# (ghcr.io/yey-boats/simulator). It shares the SignalK container's network
# namespace, so it reaches the server at localhost:$SK_PORT.
SIM_IMAGE="${SIM_IMAGE:-ghcr.io/yey-boats/simulator:latest}"
docker rm -f boat-sim >/dev/null 2>&1 || true
if docker pull "$SIM_IMAGE" >/dev/null 2>&1 || docker image inspect "$SIM_IMAGE" >/dev/null 2>&1; then
  docker run -d --name boat-sim \
    --network "container:$CONTAINER" \
    -e SIGNALK_HOST=localhost -e SIGNALK_PORT="$SK_PORT" \
    -e SIGNALK_USERNAME=admin -e SIGNALK_PASSWORD=admin \
    -v sim-data:/data \
    "$SIM_IMAGE" >/dev/null
  echo "boat simulator: container 'boat-sim' ($SIM_IMAGE)"
else
  echo "could not obtain $SIM_IMAGE; skipping synthetic data (set SIM_IMAGE=... or check ghcr access)." >&2
fi

echo "SignalK at http://$SK_HOST:$SK_PORT"
echo "NMEA 0183 TCP at $SK_HOST:10110"
echo "ESP display SignalK discovery UDP at $SK_HOST:34300"
echo "ESP display device announcement UDP at $SK_HOST:34301"
echo "boat simulator logs: docker logs -f boat-sim"
