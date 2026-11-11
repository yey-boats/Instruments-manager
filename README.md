# YEY Boats Display Manager

A [SignalK](https://signalk.org/) server plugin (and embedded webapp) for
managing **YEY Boats marine display devices** — ESP32-S3 multi-function displays
running the [`yey-boats/instruments`](https://github.com/yey-boats/instruments)
firmware. It is the single console for discovering, registering, configuring,
flashing, and OTA-updating every display on the boat.

- **Webapp:** `/yey-boats-display-manager/` (appears in SignalK Admin → Webapps as
  **YEY Boats Display Manager**)
- **Plugin UI:** `/plugins/yey-boats-display-manager/ui`
- **Plugin id:** `yey-boats-display-manager`

> **Renamed from “ESP Display Manager”.** A full `espdisp` → `yeyboats`/`yey-display`
> rebrand: the plugin id/webapp/API routes (`yey-boats-display-manager`), the wire
> protocol (`yeyboats.*.v2`, control proto major v2), mDNS services (`_yeyboats._tcp`),
> the well-known path (`/.well-known/yeyboats-management`), the auth header
> (`X-YeyBoats-Authorization`), the device-id prefix (`yey-d-`), and firmware identity
> (`yey-display`). See [Upgrading](#upgrading-from-esp-display-manager) — devices must
> be reflashed and re-provisioned.

---

## Capabilities

### Devices console
One merged landing page: stat tiles (Devices / Online / Config drift / Pending
commands / Firmware jobs), the **pending-discovery** list (devices seen on the
network but not yet claimed), and the **registered devices** table with working
**Clear offline** / **Clear all** bulk actions. Every action detects an expired
SignalK session and prompts re-login instead of silently failing.

![Devices console](docs/images/devices-home.png)

### System settings
Server-held provisioning defaults that are pushed to devices **from the server**
(so a laptop cabled to a device for flashing never has to supply them):

- **Network / WiFi** — SSID, password, mDNS domain relayed to a new device to
  bootstrap it onto the boat network.
- **OTA** — the OTA password. Held server-side, masked, never embedded in a
  firmware image and never sent over the USB cable; delivered only over the
  device’s authenticated config-fetch.
- **Device numbering** — prefix + zero-pad + next-number, so each newly
  provisioned device is auto-named (e.g. `yey-d-001`).

![System settings](docs/images/system-settings.png)

### Flash a new device over USB
Embedded [ESP Web Tools](https://esphome.github.io/esp-web-tools/) flashes a
USB-cabled ESP32-S3 straight from the browser, then bootstraps it onto the
server’s WiFi over a WebSerial console using the firmware’s own text commands.
Gated to secure contexts (open via `http://localhost` or HTTPS on the computer
the device is plugged into).

![Flash a new device over USB](docs/images/flash-usb.png)

### Per-device control, live view & firmware updates
Each device page shows a faithful live HUD mirror, live status/logs, the
generated config, the command queue, and an **Update Firmware** panel: pick an
artifact, pick a method (**OTA** server-side job or **Serial / USB** in-browser),
and a connection-validation checklist (online · address known · artifact in
catalogue) blocks the flash until it can succeed.

![Device detail with Update Firmware](docs/images/device-detail.png)

### Provisioning orchestration
On first registration after a USB flash the manager auto-assigns the next device
number and pushes the OTA password + settings via config-push; the firmware
applies them to NVS and the device becomes controllable and OTA-ready.
Re-registration is idempotent — an already-numbered device is never renumbered.

Pairing also issues the device its **own random web API password** (192-bit,
URL-safe), delivered in the pulled config. The display enforces HTTP Basic Auth
once it has one, and the manager presents it on every device HTTP call (live
status/logs, discovery probe, manager-register, and the layout editor's screenshot proxy, which only sends credentials to a registered device's host). Passwords are kept in
`device-secrets.json` (mode 0600) in the plugin data dir, never in the registry,
logs or admin JSON. **Rotate web password** on the device page issues a new one;
the previous one is still tried until the device confirms the new one. Devices
paired by an older manager (shared default password) are migrated on next
contact: reached with the old password, given a new one through the config
pull, then verified over HTTP before the old one is retired.

### Also included
Firmware catalog with GitHub-release import + OTA-job runner; dashboard presets;
the visual layout editor (per-device screen/widget CRUD, manifest-gated);
SignalK + UDP/mDNS/BLE device discovery.

---

## Install

This plugin is distributed from the
[`yey-boats/Instruments-manager`](https://github.com/yey-boats/Instruments-manager)
repository (not the public npm registry). For local/dev or remote SignalK
servers, build a tarball and `npm install` it into the SignalK home, or mount it
as a plugin directory. Full instructions — including the Docker-based lab
deployment — are in [`deploy/README.md`](deploy/README.md).

After install, restart SignalK, then enable **YEY Boats Display Manager** under
SignalK Admin → Server → Plugin Config. Open it at:

```
/plugins/yey-boats-display-manager/ui        (plugin console)
/yey-boats-display-manager/                   (webapp / app-dock tile)
```

## Upgrading: manager auth (instruments-manager#23)

Release note. The manager no longer accepts the public `yeyboats-dev` token.

- Each install generates its own **manager API token**; displays get their own
  per-device token. New displays join only when you press **Claim**.
- **Changes need an operator**: a SignalK admin session, or (always, and the
  only option when SignalK security is off) the manager API token, either as
  `X-YeyBoats-Authorization: Bearer <token>` or via **Sign in** on the manager
  UI. With SignalK security off the Settings page does not show the token;
  read it on the server from `manager-api-token.json` in the plugin data dir.
- **Displays paired before this release need re-claiming.** They stay online,
  but the manager sends them nothing until you open **Settings → Displays to
  re-claim**, check each display's address and last-seen time, and press
  **Confirm & re-claim**. (The address on file may have been set by anyone who
  had the old public token.)
- Re-keying a paired display is **Re-claim** on its device page: the display
  proves itself with its current token and collects a new one; the current
  token keeps working until then.

Details: [deploy/README.md](deploy/README.md#verify-yey-boats-display-manager).

## Upgrading from “ESP Display Manager”

The rename changes the plugin id, so SignalK treats it as a new plugin and
stores its config + device registry under a new data directory. To carry your
registered devices across, on the SignalK host:

1. Copy the plugin data dir `plugin-config-data/espdisp-manager/` →
   `plugin-config-data/yey-boats-display-manager/`, and the enable-state file
   `espdisp-manager.json` → `yey-boats-display-manager.json` (do the copy as the
   SignalK user so the files stay writable by the server).
2. Point the plugin dependency / node_modules entry at the new package name and
   restart SignalK.
3. **Reflash each device** (`yey-boats/instruments` ≥ the rebrand commit). The
   firmware self-heals on boot: an auto-generated `espdisp-<mac>` id migrates to
   `yey-d-<mac>`, and a stored manager endpoint carrying the old
   `/plugins/espdisp-manager` base is rewritten to `/plugins/yey-boats-display-manager`
   in place — so the device re-registers under its new id at the new path with no
   manual `manager-endpoint` command. (Operator-set custom device names are kept.)
   The manager then auto-assigns the next `yey-d-NNN` number on first re-register.
4. Update the SignalK **app-dock** tile URL/icon to `/yey-boats-display-manager/`.

## Documentation

- [`deploy/README.md`](deploy/README.md) — install, Docker/lab deployment, API
  route reference.
- [`docs/operator-flash-provision.md`](docs/operator-flash-provision.md) —
  end-to-end operator runbook for flashing + provisioning a fresh device.

## License

© 2026 Yey Boats Project. All rights reserved except as expressly licensed (see [NOTICE](NOTICE)).

Source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE) — free for noncommercial use. **Commercial use requires a separate license** (see [COMMERCIAL.md](COMMERCIAL.md)). Contributions under the [DCO](CONTRIBUTING.md).
