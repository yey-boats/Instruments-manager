// Per-device secrets (instruments-manager#19).
//
// Each paired display gets its own random web API password. Secrets live in
// `device-secrets.json` in the plugin data dir, written 0600, and are kept out
// of registry.json / the audit log / any admin JSON. SignalK has no plugin
// secret store, so a private file next to the other plugin data is the best
// available option.
//
// Never log a password or put one in an error message.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// The fleet-wide default every manager pushed before #19. Kept ONLY so devices
// paired back then (which still enforce it) can be reached once and migrated
// to a per-device password. It is never pushed to a device.
const LEGACY_SHARED_WEB_PASSWORD = 'yeyboats-dev'

// 24 random bytes = 192 bits, base64url (URL-safe, no padding) = 32 chars,
// within the firmware's 63-char web password limit.
const WEB_PASSWORD_BYTES = 24
const MAX_FALLBACKS = 3

function generateWebPassword () {
  return crypto.randomBytes(WEB_PASSWORD_BYTES).toString('base64url')
}

function nowIso () {
  return new Date().toISOString()
}

class DeviceSecretStore {
  constructor (dataDir) {
    this.file = path.join(dataDir, 'device-secrets.json')
    this.data = { devices: {} }
  }

  load () {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!this.data || typeof this.data.devices !== 'object') this.data = { devices: {} }
      // Tighten a file created by hand / an older version.
      try { fs.chmodSync(this.file, 0o600) } catch (e) { /* best effort */ }
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`cannot read device secrets: ${err.code || 'invalid JSON'}`)
      this.data = { devices: {} }
    }
    return this
  }

  save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    try { fs.unlinkSync(tmp) } catch (e) { /* not there */ }
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, this.file)
  }

  web (id) {
    const rec = this.data.devices[id]
    return rec && rec.web && rec.web.password ? rec.web : null
  }

  // Issue a fresh password. `fallbacks` are passwords the device may still be
  // enforcing until it pulls the config carrying the new one.
  issueWeb (id, reason, fallbacks) {
    const at = nowIso()
    const previous = this.web(id)
    const web = {
      password: generateWebPassword(),
      fallbacks: dedupe(fallbacks || []).slice(0, MAX_FALLBACKS),
      state: 'pending',
      reason,
      createdAt: previous && previous.createdAt ? previous.createdAt : at,
      rotatedAt: at,
      verifiedAt: null
    }
    this.data.devices[id] = { ...(this.data.devices[id] || {}), web }
    this.save()
    return web
  }

  rotateWeb (id) {
    const current = this.web(id)
    const fallbacks = current ? [current.password, ...(current.fallbacks || [])] : []
    return this.issueWeb(id, 'rotated', fallbacks)
  }

  markWebVerified (id, password) {
    const web = this.web(id)
    if (!web || web.password !== password) return false
    web.state = 'verified'
    web.fallbacks = []
    web.verifiedAt = nowIso()
    this.save()
    return true
  }

  remove (id) {
    if (!this.data.devices[id]) return
    delete this.data.devices[id]
    this.save()
  }
}

function dedupe (list) {
  const out = []
  for (const v of list) if (v && !out.includes(v)) out.push(v)
  return out
}

module.exports = {
  DeviceSecretStore,
  generateWebPassword,
  LEGACY_SHARED_WEB_PASSWORD
}
