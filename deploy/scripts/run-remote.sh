#!/usr/bin/env bash
# Bring up the SignalK demo stack on a remote Docker host (default:
# nav-server), then start the boat-sim container on the remote host so it
# pushes synthetic deltas into the remote SK server.
#
# Override defaults:
#   REMOTE_HOST=user@host SK_HOST=host SK_PORT=3000 ./run-remote.sh
#
# The remote host needs: docker, rsync, ssh access without password
# prompts (key-based auth recommended).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG_DIR="$ROOT/deploy/config"
PLUGIN_DIR="$ROOT"

REMOTE_HOST="${REMOTE_HOST:-nav-server}"
if [ -z "${REMOTE_DIR:-}" ]; then
  if [[ "$REMOTE_HOST" == *@* ]]; then
    REMOTE_USER="${REMOTE_HOST%@*}"
  else
    REMOTE_USER="nav-server"
  fi
  REMOTE_DIR="/home/$REMOTE_USER/espdisp-signalk"
fi
SK_HOST="${SK_HOST:-${REMOTE_HOST##*@}}"
SK_PORT="${SK_PORT:-3000}"
CONTAINER="${SIGNALK_CONTAINER:-signalk-server}"
IMAGE="${SIGNALK_IMAGE:-signalk/signalk-server:latest}"
PYTHON="${PYTHON:-/usr/bin/python3}"

echo "==> remote host: $REMOTE_HOST  (sk endpoint: $SK_HOST:$SK_PORT)"
echo "==> remote dir:  $REMOTE_DIR"

# 0a. local port collision guard.  A stale local `signalk-server`
# container from a previous `make demo-up` will bind 34300/34301/udp
# even after the container is stopped (Docker Desktop on macOS keeps
# the proxy until removed).  When that happens, pytest's UDP discovery
# listener can't bind to 34301 and the whole suite errors at
# collection time with a confusing "Address already in use".  Detect
# it now, surface a clear message, and exit with guidance.
collision=""
for port in 3000 10110 34300 34301; do
  if lsof -nP -iUDP:$port -iTCP:$port -sTCP:LISTEN 2>/dev/null | grep -q ' LISTEN\| UDP '; then
    collision="${collision} ${port}"
  fi
done
if [ -n "$collision" ]; then
  echo >&2
  echo "==> port collision on the LOCAL machine:$collision" >&2
  echo "    The remote SK container will bind these on $SK_HOST," >&2
  echo "    but pytest also listens locally for UDP 34301 and will fail." >&2
  echo "    Most likely cause: an old \`make demo-up\` (local SK) is still" >&2
  echo "    running. Stop it first:" >&2
  echo "        make demo-down" >&2
  exit 2
fi

# 0b. quick remote reachability + dependency check
ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE_HOST" \
  'command -v docker >/dev/null || { echo "docker not on PATH on remote" >&2; exit 1; }'

# 1. sync config + plugin to the remote so changes here propagate
ssh "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR/config/plugin-config-data' '$REMOTE_DIR/plugins/signalk-espdisp-manager'"
rsync -az --delete \
  --exclude 'node_modules' --exclude '*.log' \
  "$CONFIG_DIR/" "$REMOTE_HOST:$REMOTE_DIR/config/"
rsync -az --delete \
  --exclude 'node_modules' --exclude '*.log' --exclude 'deploy' --exclude '.git' \
  "$PLUGIN_DIR/" "$REMOTE_HOST:$REMOTE_DIR/plugins/signalk-espdisp-manager/"

# The signalk image runs as uid 1000 (node) inside the container.  On
# Linux remotes (unlike macOS docker desktop), bind mounts enforce
# strict ownership, so npm install would fail with EACCES against the
# files we just rsynced as the SSH user.  a+rwX is fine on a dev host
# and matches what `docker run --rm -v ...` expects to see.
# `|| true` — node_modules from a prior npm install is owned by the
# in-container `node` user (uid 1000) and we can't chown those as the
# SSH user.  Those files already have the right perms; we only need
# to widen the rsync'd files (configs, plugin sources).
ssh "$REMOTE_HOST" "chmod -R a+rwX '$REMOTE_DIR/config' '$REMOTE_DIR/plugins' 2>/dev/null || true"

# 2. (re)create the container on the remote.  We replicate run.sh's
#    sequence (npm install in the volume, then a detached server) so
#    plugin changes from the synced tree take effect immediately.
ssh "$REMOTE_HOST" REMOTE_DIR="$REMOTE_DIR" CONTAINER="$CONTAINER" IMAGE="$IMAGE" bash -s <<'REMOTE'
set -euo pipefail
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker rm -f "$CONTAINER" >/dev/null
fi
docker run --rm \
  --entrypoint npm \
  -v "$REMOTE_DIR/config:/home/node/.signalk" \
  -v "$REMOTE_DIR/plugins:/home/node/plugins" \
  -w /home/node/.signalk \
  "$IMAGE" \
  install
docker run -d \
  --name "$CONTAINER" \
  --network host \
  -v "$REMOTE_DIR/config:/home/node/.signalk" \
  -v "$REMOTE_DIR/plugins:/home/node/plugins" \
  "$IMAGE" >/dev/null
# --network host: the container sees every interface on the box
# (eth0 + wlan-ap0), so UDP broadcasts from the esp-lab subnet land
# on the SK discovery responder.  This is required for the device's
# 34300 discovery probe to be answered from nav-server.
REMOTE

# 3. poll until the remote SK answers HTTP, then start the simulator on the remote
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if "$PYTHON" - "$SK_HOST" "$SK_PORT" <<'PY'
import sys, urllib.request
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

# Synthetic boat data on the remote: the GitHub-Actions-built simulator image.
# Runs with --network host so it (a) reaches SignalK at localhost:$SK_PORT
# regardless of how SK was networked (bridge -p or host) and (b) exposes its web
# admin UI on the host. Pulling the (private) image needs a one-time
# `docker login ghcr.io` on the remote with a read:packages token.
#   SIM_WEB_PORT: the app default is 8080, but that's frequently taken on lab
#   hosts (e.g. mythra-nav runs voicex there), so default to 8088 here.
SIM_IMAGE="${SIM_IMAGE:-ghcr.io/yey-boats/simulator:latest}"
SIM_WEB_PORT="${SIM_WEB_PORT:-8088}"
ssh "$REMOTE_HOST" SIM_IMAGE="$SIM_IMAGE" SK_PORT="$SK_PORT" SIM_WEB_PORT="$SIM_WEB_PORT" bash -s <<'REMOTE'
set -euo pipefail
# Retire the legacy KDCube subtree simulator if it's still around — otherwise it
# and boat-sim both write vessels.self and clobber each other. Best-effort; needs
# sudo, no-op if absent/already disabled.
sudo systemctl disable --now kdcube-sim.service >/dev/null 2>&1 || true
docker rm -f boat-sim >/dev/null 2>&1 || true
docker pull "$SIM_IMAGE" >/dev/null 2>&1 || true
docker run -d --name boat-sim --restart unless-stopped \
  --network host \
  -e SIGNALK_HOST=localhost -e SIGNALK_PORT="$SK_PORT" \
  -e SIGNALK_USERNAME=admin -e SIGNALK_PASSWORD=admin \
  -e SIM_WEB_HOST=0.0.0.0 -e SIM_WEB_PORT="$SIM_WEB_PORT" \
  -e DATA_DIR=/data -v sim-data:/data \
  "$SIM_IMAGE" >/dev/null
REMOTE

cat <<EOF
SignalK at http://$SK_HOST:$SK_PORT
NMEA 0183 TCP at $SK_HOST:10110
ESP display SignalK discovery UDP at $SK_HOST:34300
ESP display device announcement UDP at $SK_HOST:34301
boat simulator: container 'boat-sim' on $REMOTE_HOST (docker logs -f boat-sim)
boat simulator web admin at http://$SK_HOST:$SIM_WEB_PORT/

Test env (firmware repo): source $ROOT/../espdisp/.env.test
EOF
