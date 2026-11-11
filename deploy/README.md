# SignalK Test Server

This directory contains the SignalK server configuration and deploy scripts
for running the `yey-boats-display-manager` plugin locally or on a remote host.

`deploy/scripts/run.sh` and `deploy/scripts/run-remote.sh` start a SignalK
container with the plugin mounted directly from the repo root so plugin changes
take effect after a server restart without reinstalling.  The `docker-compose.yml`
in this directory does the same for Compose-based workflows.

**Synthetic boat data** comes from the **`yey-boats/simulator`** image
(`ghcr.io/yey-boats/simulator:latest`), built by GitHub Actions.  The scripts
pull and run it as the `boat-sim` container.  Override the image with
`SIM_IMAGE=ghcr.io/yey-boats/simulator:edge ./deploy/scripts/run.sh`.

**Production lab** deployment is a docker volume-mount on the SignalK host
(`mythra-nav`); use `run-remote.sh` (or the `Makefile` targets) to sync and
restart the container there.

---

It is used for local firmware testing with:

- SignalK HTTP/WebSocket on `localhost:3000`
- NMEA 0183 TCP output on `localhost:10110`
- ESP display SignalK discovery responder on UDP `34300`
- ESP display device announcement listener on UDP `34301`
- official NMEA 0183 conversion plugin
- official autopilot plugin in emulator mode
- synthetic boat data from the `boat-sim` container (`ghcr.io/yey-boats/simulator`)
- repo-owned `yey-boats-display-manager` plugin for display registry, dashboard presets,
  generated dashboard config, command delivery, and firmware job testing

Project-level manager concepts and screenshots are documented in the
[plugin README](../README.md).

Current manager UI screenshots are stored under `docs/images/` (see the
[plugin README](../README.md) for these rendered inline):

```text
devices-home.png      # merged Devices console (stats, discovery, registered table)
system-settings.png   # network / OTA password / device-numbering defaults
device-detail.png     # live HUD, command queue, Update Firmware (serial/OTA + validation)
flash-usb.png         # ESP Web Tools USB flashing
```

## Start

```sh
make demo-up
```

or directly:

```sh
./deploy/scripts/run.sh
```

The deploy stack installs the local plugin from the repo root through
`deploy/config/package.json`:

```json
"yey-boats-display-manager": "file:../plugins/yey-boats-display-manager"
```

That path is the fastest way to test plugin changes from this checkout. The
run script starts SignalK with:

```text
-v deploy/config:/home/node/.signalk
-v <repo-root>:/home/node/plugins/yey-boats-display-manager
```

and runs `npm install` inside `/home/node/.signalk` before starting the server.

## Stop

```sh
make demo-down
```

or directly:

```sh
./deploy/scripts/stop.sh
```

## Install YEY Boats Display Manager From This Repo

For a normal SignalK server, install the packed plugin tarball attached to the
matching GitHub release. Releases include firmware binaries and:

```text
yey-boats-display-manager-<version>.tgz
SHA256SUMS
```

Download both files from the release page. On the SignalK host, optional
checksum verification from the download directory is:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

Install the release asset into the SignalK home directory:

```sh
cd ~/.signalk
npm install /path/to/yey-boats-display-manager-<version>.tgz
```

Then restart SignalK and enable/configure `YEY Boats Display Manager` in the SignalK
admin plugin UI. The plugin UI is served at:

```text
/plugins/yey-boats-display-manager/ui
/yey-boats-display-manager/
```

The release package is the recommended install path because it is built by CI
from the tagged source and published alongside the matching firmware artifacts.
Every push/PR also uploads a `yey-boats-display-manager-<sha>` workflow artifact
for branch testing, but those artifacts are not release-pinned.

### OTA Password In CI And Release Builds

Firmware reads ArduinoOTA auth from `OTA_PASSWORD` in generated
`include/secrets.h`. The repository does not store this file. GitHub Actions
generates it from repository secrets:

```text
YEYBOATS_OTA_PASSWORD
```

The regular CI firmware matrix uses this secret when available. The tagged
release workflow requires it and fails before building firmware artifacts if it
is missing, so release images are not accidentally built with unauthenticated
ArduinoOTA.

For local builds, set the same environment variable before `make build` or
`make ota`:

```sh
YEYBOATS_OTA_PASSWORD='<ota-password>' make build
YEYBOATS_OTA_PASSWORD='<ota-password>' make ota DEVICE_IP=<device-ip>
```

The OTA password is embedded in the firmware image. If release assets are
public or distributed outside the intended deployment group, rotate the
password.

## Firmware Upgrade Artifacts From GitHub

The YEY Boats Display Manager firmware catalog can import firmware artifacts directly
from this repository's GitHub releases. Release assets are versioned by Git tag
and board target, for example:

```text
esp32-4848s040-merged_firmware.bin
waveshare-touch-lcd-7b_1024x600-merged_firmware.bin
SHA256SUMS
```

When the GitHub release source is enabled, the plugin reads the latest release,
matches `*-merged_firmware.bin` assets against supported board ids, verifies
that each asset is listed in `SHA256SUMS`, and adds catalog entries with:

- firmware version from the release tag
- board compatibility from the asset name
- SHA-256 from `SHA256SUMS`
- GitHub release download URL for device pull-OTA jobs

Refresh the catalog from the API:

```sh
curl -X POST http://<signalk-host>:3000/plugins/yey-boats-display-manager/firmware/catalog/refresh
```

The device firmware update command then points at the GitHub asset URL and
includes the matching SHA-256 so firmware can verify the downloaded image.

### Build A Local Plugin Package

For development, build a local tarball from the repo checkout:


```sh
cd /path/to/yey-boats-display-manager
npm ci
npm test
npm pack
```

That creates:

```text
yey-boats-display-manager-<version>.tgz
```

Install it into the SignalK home directory on the target server:

```sh
cd ~/.signalk
npm install /path/to/yey-boats-display-manager/yey-boats-display-manager-<version>.tgz
```

## Verify SignalK

```sh
curl http://localhost:3000/signalk
```

ESP display firmware in default `sk-host auto` mode first tries mDNS
`_signalk-ws._tcp`. If that is not advertised by the LAN or Docker setup, it
broadcasts `yeyboats.signalk.discover.v2` to UDP `34300`. The manager plugin
replies with the SignalK HTTP/WebSocket port; the device uses the reply source
address when no explicit advertised host is configured, then TCP-probes the
target before opening the SignalK WebSocket.

For manager discovery, the plugin can also advertise `_yeyboats-mgmt._tcp.local`
with TXT metadata for protocol, base path, auth mode, TLS flag, SignalK port,
and NMEA TCP port. Firmware can query this with `manager-discover`. This works
on LANs or containers where multicast DNS UDP `5353` reaches the display.

ESP display firmware also broadcasts `yeyboats.device.announce.v2` to UDP
`34301` after joining WiFi. The manager plugin listens on that port and adds
unclaimed displays to the Discovery page without needing a subnet scan.

The firmware also advertises Bonjour/mDNS service `_yeyboats._tcp.local`.
The manager plugin passively listens for those advertisements and uses the
TXT fields (`device_id`, `board`, `firmware`, `version`, `display`, `auth`,
`cfg_ver`, `cfg_hash`, `seq`) to update the same Discovery page. Firmware
refreshes the Bonjour TXT records on boot, periodically, and after managed
configuration/auth changes.

## Discovery Troubleshooting

From the repo root, verify device visibility:

```sh
python3 -m tests.system.discovery --json --listen-udp --timeout 5
```

If the device does not appear:

- check the display is connected to the same WiFi as SignalK
- check firmware logs for `[mdns] advertise` and `[discovery] announce`
- confirm mDNS multicast UDP `5353` is allowed between the SignalK host and
  display network
- confirm UDP `34301` is exposed when SignalK runs in Docker
- use an explicit host as a fallback:

```sh
YEYBOATS_HOST=<device-ip> pytest tests/system/unattended/test_boot_health.py
```

## Verify NMEA 0183 TCP

After the fake boat producer is running:

```sh
nc localhost 10110
```

Expected sentences include `GGA`, `RMC`, `HDT`, `MWV`, `VWR`, `VWT`, `DBT`,
and `MTW` when the required SignalK paths have data.

## Verify Autopilot Emulator

```sh
curl http://localhost:3000/signalk/v1/api/vessels/self/steering/autopilot/state/value
```

Expected default:

```text
"standby"
```

Authenticated state command example:

```sh
TOKEN=$(curl -s -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' \
  http://localhost:3000/signalk/v1/auth/login | jq -r .token)

curl -s -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"value":"auto"}' \
  http://localhost:3000/signalk/v1/api/vessels/self/steering/autopilot/state
```

Then query the state path again.

## Verify YEY Boats Display Manager

SignalK protects plugin routes with its normal HTTP auth. Device management
auth is carried separately with `X-YeyBoats-Authorization`.

Manager auth (instruments-manager#23):

- On first start the plugin generates its own **manager API token** (256-bit,
  `manager-api-token.json` in the plugin data dir, mode 0600). Open the manager
  UI **Settings** page to copy it; it is shown until you press *I have saved
  it*, after which only a hash is kept. *Rotate token* issues a new one.
- The manager API token pairs NEW displays (`POST /devices/register`),
  announces discovered devices and lets tooling read a device config with its
  secrets redacted. It never acts as a display, and it cannot re-pair a
  display that is already paired (`409 reclaim_required`); neither can a
  provisioning token.
- Each display gets its own random token at pairing. Only that token can send
  its heartbeat (and so change its address), poll its commands or receive its
  web password / OTA password in `GET /devices/:id/config`.
- New displays running stock firmware (compiled-in bootstrap token) show up
  under Discovery and join only when you press *Claim* (no trust on first
  use); Claim pushes the display its token over its web API. A sighting of an
  id that is already paired cannot be claimed over it.
- **Re-claim** (device page, or `POST /devices/:id/reclaim`; *Rotate token*
  does the same) is the only way to re-key a paired display. A display that
  still has its token proves itself with it: its next heartbeat asks it to
  re-register and it collects the new token; its current token keeps working
  until then, so nobody can lock it out. The new token is never returned to
  the caller.
- Operator routes (everything that changes state, except the few the displays
  call) need the manager API token (`X-YeyBoats-Authorization: Bearer ...`,
  or *Sign in* on the manager UI, which sets an HttpOnly SameSite cookie),
  or a SignalK admin session when SignalK security is on. **With SignalK
  security off, nothing can be changed without the token**, and the Settings
  page does not show it: read it on the server from `manager-api-token.json`
  (`reveal` field) and sign in.
- The pairing-code field (`pairingCode` on Claim / Re-claim) is reserved for
  the one-time code the display will show on screen; until the firmware
  supports it a code is refused (501).

Upgrading from a release that used the shared `yeyboats-dev` token
(release note):

- Displays paired with the shared token keep working but are marked
  **needs re-claim**: the shared token keeps them online, cannot change their
  address and does not get their secrets. The manager does **not** send them
  anything on start, because the address it has on file could have been set
  by anyone holding the public token.
- Open *Settings → Displays to re-claim*. For each display check the address
  (and last-seen time) against the display itself, correct it if needed and
  press *Confirm & re-claim*. Only then does the manager push the display its
  web password and own token, to that address only. The shared token is
  retired for the display once it uses its new one.
- The shared dev token and `auth.mode=disabled` only take effect when SignalK
  runs with `YEYBOATS_MANAGER_DEV_AUTH=1` (local development only).
- State-changing routes refuse cross-site browser requests (CSRF); scripts and
  displays (no `Origin`/`Sec-Fetch-Site` headers) are unaffected.

```sh
TOKEN=$(curl -s -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' \
  http://localhost:3000/signalk/v1/auth/login | jq -r .token)

curl -s \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/plugins/yey-boats-display-manager/.well-known/yeyboats-management

# Manager API token from the manager UI Settings page.
MANAGER_TOKEN=ybm_...

curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-YeyBoats-Authorization: Bearer $MANAGER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"device":{"id":"yey-d-aabbccddeeff","board":"esp32-4848s040"}}' \
  http://localhost:3000/plugins/yey-boats-display-manager/devices/register
```

The built-in operator UI is available at:

```text
http://localhost:3000/plugins/yey-boats-display-manager/ui
```

It is also exposed as an installed SignalK webapp and as an App Dock tile named
`ESP Displays`:

```text
http://localhost:3000/yey-boats-display-manager/
http://localhost:3000/@signalk/app-dock/
```

UI pages:

```text
/plugins/yey-boats-display-manager/ui
/plugins/yey-boats-display-manager/ui/devices
/plugins/yey-boats-display-manager/ui/devices/:id
/plugins/yey-boats-display-manager/ui/devices/:id/config
/plugins/yey-boats-display-manager/ui/discovery
/plugins/yey-boats-display-manager/ui/profiles
/plugins/yey-boats-display-manager/ui/profiles/:id
/plugins/yey-boats-display-manager/ui/firmware
```

The operator UI is intentionally structured, not a raw JSON editor:

- the device page shows current status, firmware jobs, and recent commands
- the device config page edits the dashboard from SignalK: preset assignment,
  day/night theme, default screen, data sources, autopilot flags, widget font
  sizes, and debug/touch options
- `Save and send to device` saves the generated config inputs and queues a
  `config.reload` command for the device to poll
- `Save as preset` stores the same settings as a reusable profile/preset
- preset rows export dashboard configs as JSON or YAML
- the preset import form accepts `yeyboats.dashboard.v2` JSON/YAML
- the preset detail page applies one preset to multiple selected devices and
  can clear device overrides before queuing reload commands

The current dashboard editor is table/form based. It is useful for editing
widgets, SignalK paths, font sizes, screens, and tile row/column assignments,
but it is not yet a visual layout builder. The planned visual builder should
keep the same generated dashboard schema while adding:

- a device-size preview canvas based on registered display geometry
- a widget palette for supported widget types
- drag/drop placement and direct tile resize/reorder
- a SignalK path picker instead of free-text path entry
- role/display templates for common helm, cabin, nav, and engine pages
- validation for missing widgets, duplicate tile positions, unsupported widget
  types, and layouts that do not fit the target display
- import/export compatibility with the existing `yeyboats.dashboard.v2`
  preset format

The layout builder is summarized in the [plugin README](../README.md#capabilities).

Presets are implemented with the plugin profile store. A device's generated
dashboard config is:

```text
selected preset/profile
  + per-device overrides
  + display/layout/widget variant selection
  + unsupported widget filtering
  + font-size resolution against device capabilities
```

Device-local dashboard config endpoints are available on the ESP web UI for
bench work:

```text
GET/PUT /api/dashboard/config.json
GET/PUT /api/dashboard/config.yaml
GET     /api/security
```

The device `.yaml` endpoint intentionally uses JSON-compatible YAML syntax.
Full block-style YAML import/export is handled by the SignalK plugin.

Implemented v1 endpoints:

```text
GET  /plugins/yey-boats-display-manager/.well-known/yeyboats-management
GET  /plugins/yey-boats-display-manager/capabilities
GET  /plugins/yey-boats-display-manager/dashboard
GET  /plugins/yey-boats-display-manager/discovery/devices
POST /plugins/yey-boats-display-manager/discovery/devices
GET  /plugins/yey-boats-display-manager/devices
GET  /plugins/yey-boats-display-manager/groups
GET  /plugins/yey-boats-display-manager/provisioning/tokens
POST /plugins/yey-boats-display-manager/provisioning/tokens
POST /plugins/yey-boats-display-manager/devices/register
GET  /plugins/yey-boats-display-manager/devices/:id
PATCH /plugins/yey-boats-display-manager/devices/:id
GET  /plugins/yey-boats-display-manager/devices/:id/auth/status
POST /plugins/yey-boats-display-manager/devices/:id/profile
POST /plugins/yey-boats-display-manager/devices/:id/status
GET  /plugins/yey-boats-display-manager/devices/:id/config
GET  /plugins/yey-boats-display-manager/profiles
POST /plugins/yey-boats-display-manager/profiles
GET  /plugins/yey-boats-display-manager/profiles/:id/dashboard.json
GET  /plugins/yey-boats-display-manager/profiles/:id/dashboard.yaml
POST /plugins/yey-boats-display-manager/profiles/import-dashboard
POST /plugins/yey-boats-display-manager/devices/:id/command
GET  /plugins/yey-boats-display-manager/devices/:id/commands
GET  /plugins/yey-boats-display-manager/devices/:id/commands/:commandId
POST /plugins/yey-boats-display-manager/devices/:id/commands/:commandId/ack
POST /plugins/yey-boats-display-manager/devices/:id/commands/:commandId/cancel
POST /plugins/yey-boats-display-manager/devices/:id/tokens/rotate
POST /plugins/yey-boats-display-manager/devices/:id/tokens/revoke
POST /plugins/yey-boats-display-manager/groups/:groupId/command
POST /plugins/yey-boats-display-manager/automation/event
GET  /plugins/yey-boats-display-manager/firmware/catalog
POST /plugins/yey-boats-display-manager/firmware/artifacts
GET  /plugins/yey-boats-display-manager/firmware/artifacts/:artifactId
GET  /plugins/yey-boats-display-manager/firmware/download/:jobId
GET  /plugins/yey-boats-display-manager/devices/:id/firmware/jobs
POST /plugins/yey-boats-display-manager/devices/:id/firmware/jobs
GET  /plugins/yey-boats-display-manager/devices/:id/firmware/jobs/:jobId
POST /plugins/yey-boats-display-manager/devices/:id/firmware/jobs/:jobId/progress
POST /plugins/yey-boats-display-manager/devices/:id/firmware/confirm
```

Discovery announcements are a lightweight bridge for mDNS scanners, future
firmware provisioning, or test fixtures. They do not claim/register the device;
they only populate the Discovery UI and mark whether the same device id is
already in the registry.

Device registration may include display geometry and widget capabilities. The
plugin uses those fields to select layout and widget variants.

The manager control-plane benchmark and async persistence design are documented
in [SignalK Manager Load and Async Design](../docs/architecture/signalk-manager-load-and-async.md).

```json
{
  "display": {
    "width": 480,
    "height": 480,
    "rotation": 0,
    "colorDepth": 16,
    "shape": "square"
  },
  "capabilities": {
    "widgets": {
      "numeric": true,
      "text": true,
      "map": false
    },
    "fonts": {
      "sizes": [12, 14, 16, 18, 24, 32, 42, 48]
    }
  }
}
```

Profiles can provide `layout.variants` and `widgets.variants` keyed by
display match rules. Generated configs contain only the selected layout plus
supported widgets, with font sizes resolved to the device's supported font
list.

Profiles may also include a `match` object. On first registration, the plugin
assigns the highest-priority matching profile before falling back to `default`:

```json
{
  "id": "wide-helm",
  "priority": 50,
  "match": {
    "display": {
      "width": 800,
      "height": 480
    }
  }
}
```

If unsupported widgets are filtered out, layout tiles referencing those widget
ids are removed from the generated config before the device sees it.
