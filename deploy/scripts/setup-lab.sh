#!/usr/bin/env bash
#
# Full lab / nav-server bring-up for the YEY Boats Display Manager.
# Installs AND runs every component required to host the manager on a fresh
# Ubuntu/Debian box:
#
#   1. Docker engine + compose plugin
#   2. the `yey-net` WiFi AP (hostapd + dnsmasq on wlan-ap0, 10.42.0.0/24,
#      with the lab device pinned at 10.42.0.67 via static DHCP lease)
#   3. SignalK server + this manager plugin + the boat simulator
#      (docker compose: containers `signalk-server` + `boat-sim`)
#   4. a systemd unit (`yeydisp-signalk`) so the stack restarts on boot
#   5. (optional) ufw firewall rules
#
# Run from a checkout of THIS repo, on the target host, as a sudoer:
#
#   AP_PSK='<wifi-passphrase>' sudo -E bash deploy/scripts/setup-lab.sh
#
# Re-runnable / idempotent. Flags:
#   --skip-ap     don't touch the WiFi AP (host has its own network)
#   --skip-sim    SignalK only, no boat simulator
#   --skip-fw     don't apply ufw rules
#   --no-systemd  start the stack now but don't install the boot unit
#
# Env overrides: AP_PSK (required unless --skip-ap), DEPLOY_DIR, SK_SERVICE,
#   SIGNALK_IMAGE, SIM_IMAGE.
set -euo pipefail

SKIP_AP=0; SKIP_SIM=0; SKIP_FW=0; NO_SYSTEMD=0
for a in "$@"; do case "$a" in
    --skip-ap) SKIP_AP=1 ;; --skip-sim) SKIP_SIM=1 ;;
    --skip-fw) SKIP_FW=1 ;; --no-systemd) NO_SYSTEMD=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
esac; done

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo -E bash $0 ...)" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$REPO_ROOT/deploy}"
SK_SERVICE="${SK_SERVICE:-yeydisp-signalk}"
SUDO_USER_HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"

log()  { printf '\033[1;34m[setup-lab]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[setup-lab] OK\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-lab] !!\033[0m %s\n' "$*"; }

# Pick `docker compose` (v2) or `docker-compose` (v1).
compose() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }

# ---------------------------------------------------------------- 1. Docker
if ! command -v docker >/dev/null 2>&1; then
    log "installing Docker engine"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    systemctl enable --now docker
    ok "Docker installed"
else
    ok "Docker present ($(docker --version | head -1))"
fi

# ---------------------------------------------------------------- 2. yey-net AP
if [ "$SKIP_AP" -eq 0 ]; then
    : "${AP_PSK:?AP_PSK (WiFi passphrase, >=8 chars) is required — or pass --skip-ap}"
    log "configuring the yey-net WiFi AP (wlan-ap0)"
    YEY_NET_PSK="$AP_PSK" bash "$HERE/lab-ap-setup.sh"
    ok "yey-net AP up"
else
    warn "skipping WiFi AP (--skip-ap)"
fi

# ---------------------------------------------------------- 3. SignalK + sim
log "pulling images"
docker pull -q "${SIGNALK_IMAGE:-signalk/signalk-server:latest}" >/dev/null
[ "$SKIP_SIM" -eq 0 ] && docker pull -q "${SIM_IMAGE:-ghcr.io/yey-boats/simulator:latest}" >/dev/null || true

log "starting SignalK + manager plugin${SKIP_SIM:+}$([ "$SKIP_SIM" -eq 0 ] && echo ' + boat simulator')"
cd "$DEPLOY_DIR"
if [ "$SKIP_SIM" -eq 1 ]; then compose up -d signalk; else compose up -d; fi

# Wait for SignalK HTTP.
for i in $(seq 1 20); do
    if curl -sf http://localhost:3000/signalk >/dev/null 2>&1; then ok "SignalK up at http://localhost:3000"; break; fi
    [ "$i" -eq 20 ] && warn "SignalK didn't answer in 60s — check: docker logs signalk-server"
    sleep 3
done

# ---------------------------------------------------------------- 4. systemd
if [ "$NO_SYSTEMD" -eq 0 ]; then
    UNIT="/etc/systemd/system/${SK_SERVICE}.service"
    log "installing boot unit $UNIT"
    COMPOSE_BIN="$(command -v docker) compose"; docker compose version >/dev/null 2>&1 || COMPOSE_BIN="$(command -v docker-compose)"
    cat > "$UNIT" <<EOF
[Unit]
Description=yeydisp lab SignalK + manager + simulator (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DEPLOY_DIR
ExecStart=$COMPOSE_BIN up -d
ExecStop=$COMPOSE_BIN down
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SK_SERVICE"
    ok "boot unit $SK_SERVICE enabled"
else
    warn "skipping systemd unit (--no-systemd)"
fi

# ---------------------------------------------------------------- 5. firewall
if [ "$SKIP_FW" -eq 0 ] && [ -f "$HERE/ufw-rules.sh" ] && command -v ufw >/dev/null 2>&1; then
    log "applying ufw rules"; bash "$HERE/ufw-rules.sh"; ok "ufw configured"
fi

# ---------------------------------------------------------------- summary
echo
echo "================ YEY Boats lab ready ================"
docker ps --format '  {{.Names}}\t{{.Status}}' | grep -E 'signalk-server|boat-sim' || true
echo "  SignalK / manager : http://$(hostname -I | awk '{print $1}'):3000"
echo "  Plugin UI         : .../plugins/yey-boats-display-manager/ui"
[ "$SKIP_AP" -eq 0 ] && echo "  WiFi AP           : yey-net  (devices get 10.42.0.x; lab MFD pinned 10.42.0.67)"
[ "$SKIP_SIM" -eq 0 ] && echo "  Simulator admin   : http://$(hostname -I | awk '{print $1}'):8088"
echo "===================================================="
echo "Next: in the manager's System Settings, set the WiFi SSID to 'yey-net'"
echo "so freshly-flashed devices are provisioned onto this network."
