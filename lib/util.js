const crypto = require('crypto')

function now () {
  return new Date().toISOString()
}

function randomId (prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`
}

function sha256Json (value) {
  const body = JSON.stringify(stable(value))
  return `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`
}

function stable (value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = stable(value[key])
    return acc
  }, {})
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function sanitizeDeviceId (id) {
  return String(id || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '-')
}

// #88: names that resolve on any plain object through Object.prototype
// ('__proto__', 'constructor', 'toString', ...). As a display or preset id they
// would read or WRITE the shared prototype instead of a registry entry.
const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'prototype'])

// A display id as the registry stores it: already in sanitizeDeviceId's form
// ([a-z0-9_.-]), 1..64 chars, and never an Object.prototype member. Check it
// at every boundary where an id arrives from outside (cloud, API, MCP).
function isDisplayId (id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 &&
    id === sanitizeDeviceId(id) && !RESERVED_KEYS.has(id)
}

function isReservedKey (key) {
  return RESERVED_KEYS.has(String(key))
}

// An id-keyed map without a prototype: obj['__proto__'] is an ordinary own key
// there, so a lookup or assignment can never reach Object.prototype.
function nullProto (obj) {
  const out = Object.create(null)
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) out[k] = obj[k]
  }
  return out
}

function hostnameFromPolicy (device, network) {
  const policy = network.namingPolicy || 'device-id'
  const prefix = network.hostnamePrefix || 'yey-d'

  if (device.networkIdentity && device.networkIdentity.desiredHostname) {
    return cleanHostname(device.networkIdentity.desiredHostname)
  }

  if (policy === 'manual' && device.hostname) {
    return cleanHostname(device.hostname)
  }

  if (policy === 'role-location') {
    const bits = [device.location, device.role || 'display'].filter(Boolean)
    if (bits.length > 0) return cleanHostname(bits.join('-'))
  }

  if (device.id && device.id.startsWith(`${prefix}-`)) return cleanHostname(device.id)
  return cleanHostname(`${prefix}-${device.id || 'device'}`)
}

function cleanHostname (value) {
  return String(value || 'yey-d')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'yey-d'
}

function mergeDeep (base, override) {
  const out = clone(base || {})
  if (!override || typeof override !== 'object') return out
  Object.keys(override).forEach((key) => {
    const ov = override[key]
    if (ov && typeof ov === 'object' && !Array.isArray(ov)) {
      out[key] = mergeDeep(out[key] || {}, ov)
    } else {
      out[key] = ov
    }
  })
  return out
}

module.exports = {
  now,
  randomId,
  sha256Json,
  clone,
  sanitizeDeviceId,
  isDisplayId,
  isReservedKey,
  nullProto,
  hostnameFromPolicy,
  mergeDeep
}
