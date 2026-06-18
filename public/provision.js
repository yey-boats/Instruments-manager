// provision.js — post-flash WebSerial provisioning for a fresh espdisp MFD.
//
// After Step 1 (esp-web-tools flash) the device boots blank. This sends the
// boat WiFi credentials over USB serial using the firmware's own console
// command, sourced from the manager's System Settings via the auth-gated
// /provisioning/payload route. The command mirrors tools/provision_device.py:
//
//     wifi "<ssid>" <password>      (ssid quoted only if it contains a space)
//
// `wifi <ssid> <pass>` REBOOTS the device to join the network, so the serial
// port drops right after. The device number + OTA password are therefore NOT
// sent here — they are applied server-side via config-push (Slice 7) once the
// device registers. We only do the WiFi bootstrap over serial.
(function () {
  'use strict'

  const BAUD = 115200
  const log = (msg) => {
    const el = document.getElementById('prov-log')
    if (!el) return
    const stamp = new Date().toLocaleTimeString()
    if (el.textContent === '(provisioning log will appear here)') el.textContent = ''
    el.textContent += '[' + stamp + '] ' + msg + '\n'
    el.scrollTop = el.scrollHeight
  }

  // Mirror tools/provision_device.py: quote the SSID only when it has a space.
  const quoteSsid = (ssid) => (/\s/.test(ssid) ? '"' + ssid + '"' : ssid)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function provision () {
    const button = document.getElementById('provision')
    if (!('serial' in navigator)) {
      log('WebSerial unavailable (open via localhost/HTTPS).')
      return
    }

    let port = null
    let writer = null
    let reader = null
    let readLoop = null
    if (button) button.disabled = true

    try {
      log('Fetching provisioning payload from the manager…')
      const res = await fetch('/plugins/yey-boats-display-manager/provisioning/payload', { credentials: 'include' })
      if (!res.ok) throw new Error('payload HTTP ' + res.status)
      const payload = await res.json()
      const ssid = payload && payload.wifi && payload.wifi.ssid
      const pass = (payload && payload.wifi && payload.wifi.password) || ''
      if (!ssid) throw new Error('no WiFi SSID configured in System Settings')
      // Never log the password.
      log('Will join WiFi network "' + ssid + '".')

      log('Requesting a serial port — pick the device in the browser prompt…')
      port = await navigator.serial.requestPort()
      await port.open({ baudRate: BAUD })
      log('Serial port open at ' + BAUD + ' baud.')

      // Background reader: stream device output into the log.
      if (port.readable) {
        reader = port.readable.getReader()
        const decoder = new TextDecoder()
        readLoop = (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              if (value && value.length) {
                const text = decoder.decode(value, { stream: true }).replace(/\r/g, '')
                if (text.trim()) log('device › ' + text.replace(/\n+$/, ''))
              }
            }
          } catch (_) {
            // Reader is cancelled / port drops on reboot — expected.
          }
        })()
      }

      writer = port.writable.getWriter()
      const encoder = new TextEncoder()
      const send = async (line) => {
        await writer.write(encoder.encode(line + '\n'))
      }

      // Small settle before the first command so the console is ready.
      await sleep(300)

      const cmd = 'wifi ' + quoteSsid(ssid) + ' ' + pass
      // Log the command but mask the password.
      log('→ wifi ' + quoteSsid(ssid) + ' ******')
      await send(cmd)
      log('sent wifi creds; device will reboot and join "' + ssid + '".')
      // Give the firmware a moment to ACK before the reboot tears down serial.
      await sleep(1500)

      log('Note: device number + OTA password will be applied by the server ' +
          'via config-push once the device registers. (Not sent over serial — ' +
          'the device reboots after the wifi command and the port drops.)')
      log('Provisioning bootstrap complete. You can close this tab.')
    } catch (err) {
      log('Error: ' + (err && err.message ? err.message : String(err)))
    } finally {
      // Tear everything down; the port may already be gone after the reboot.
      try { if (writer) { writer.releaseLock() } } catch (_) {}
      try { if (reader) { await reader.cancel(); reader.releaseLock() } } catch (_) {}
      try { if (readLoop) await readLoop } catch (_) {}
      try { if (port) await port.close() } catch (_) {}
      if (button) button.disabled = false
    }
  }

  const wire = () => {
    const button = document.getElementById('provision')
    if (button) button.addEventListener('click', provision)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire)
  } else {
    wire()
  }
})()
