# Operator runbook: flash + provision a device from the manager

This is the end-to-end (spec Slice 8) for taking a **bare or factory-default
ESP32-4848S040** to a registered, controllable, OTA-ready device using only the
manager console and a USB cable. It exercises every slice (1–7) on real hardware.

## Prerequisites

1. **A central computer** running a Chromium-based browser (Chrome/Edge) — the one
   the device will be **cabled to**. WebSerial requires a **secure context**, so
   open the manager via **`http://localhost`** on that computer, or over **HTTPS**.
   Plain-HTTP LAN access (`http://mythra-nav:3000`) will show the secure-context
   notice and no flash button — this is expected, not a bug.
2. **A firmware factory image** in the manager catalog. The merged factory `.bin`
   (bootloader+partitions+boot_app0+app at `0x0`) is produced by the firmware build
   (`pio run -e esp32-4848s040` → `.pio/build/esp32-4848s040/firmware-factory.bin`,
   via `tools/merge_factory.py`). Publish it as a firmware artifact (CI release or
   manual upload) so it appears in **Firmware** and as a manifest at
   `GET /firmware/manifest/:artifactId`.
3. **System Settings filled in** (manager → **Settings**):
   - **Network**: the WiFi SSID + password the device should join (the *server's*
     network, not the cabled laptop's).
   - **OTA password**: the password OTA jobs will use. Stored masked; **never**
     leaves the server except over the device's authenticated config-fetch.
   - **Numbering**: prefix + pad (e.g. `espdisp-` / `3` → `espdisp-001`).

## Steps

### 1. Flash over USB (Slice 4 + 5)
1. On the central computer, open the manager at `http://localhost:3000/...` (secure
   context) and go to **Devices → Flash new device (USB)** (`/.../flash.html`).
2. Plug the device in. Click the install button, pick the serial port, let
   ESP Web Tools write the factory image. (First flash of a bare chip may need the
   board held in download mode per the Sunton instructions.)

### 2. Network bootstrap over serial (Slice 4, server-sourced)
3. After flashing, the flash page opens a **WebSerial console** and pushes the
   **server's** WiFi creds (fetched from System Settings via `/provisioning/payload`,
   which returns **only** `{wifi:{ssid,password,mdnsDomain}}` — no OTA password, no
   number). It sends the firmware's existing text command (`wifi "<ssid>" <pass>`),
   the device reboots and joins the network.
   - The cabled laptop's own network is never used; the OTA password never transits
     the cable.

### 3. Auto-registration + auto-numbering (Slice 7)
4. On joining, the device registers with the manager. Because it reports its default
   name (empty / equal to its id), the manager **assigns the next number** from
   System Settings (e.g. `espdisp-001`), stored as both `assignedNumber` and `name`.
   Re-registration never re-numbers an already-numbered device.
5. The device fetches its config. The manager includes the System-Settings **OTA
   password** in that config (`config.ota.password`); the firmware applies it to NVS
   (`net::setOtaPassword`, namespace `net` / key `ota_pass`) so OTA uses it after
   reboot. A config without an OTA password never clobbers an existing one.

### 4. Verify controllable + OTA-ready (Slice 6)
6. The device appears in the merged **Devices** table as online. Open it; the
   **Update Firmware** section shows the connection-validation checklist
   (`online` / `addressKnown` / `hasArtifact`). When all pass, the **OTA** submit is
   enabled; **Serial (USB)** links back to the flash page.
7. Trigger an OTA job against a catalog artifact and watch the firmware-job progress
   (device pulls `/firmware/download/:jobId` and self-flashes) to confirm the runtime
   OTA password is in effect.

## Expected end state
- Device is in the registry with an auto-assigned number, online, controllable.
- OTA password is set on the device (from System Settings), so OTA jobs authenticate.
- No secret (OTA password) ever crossed the USB cable or a client network.

## Troubleshooting
- **No flash button / "secure context" notice** → you opened the manager over plain
  HTTP on the LAN. Use `http://localhost` on the cabled computer, or HTTPS.
- **Device joins but never registers** → check it reached the server's network
  (serial console: it echoes the WiFi association); confirm the manager endpoint is
  reachable from that subnet.
- **OTA validation never goes green** → no firmware artifact in the catalog
  (`hasArtifact` false), or the device has no known address yet (`addressKnown`).
- **Session expired** → manager actions now prompt a re-login modal instead of
  silently no-opping; click through to `/admin/#/login` and retry.
