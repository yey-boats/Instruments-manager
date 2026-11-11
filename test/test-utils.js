const fs = require('fs')
const os = require('os')
const path = require('path')
const { YeyBoatsDisplayManager } = require('../lib/manager')

// Legacy suites predate instruments-manager#23 and drive the manager with the
// shared development token, so they opt in to the explicit dev auth mode
// (`auth.devAuth`, which the plugin only sets from YEYBOATS_MANAGER_DEV_AUTH=1).
// Suites that exercise the production auth model use makeSecureManager().
function makeManager (options) {
  return buildManager({ auth: { mode: 'dev-shared-token', devAuth: true } }, options)
}

// The production default: per-device tokens + a generated manager API token.
function makeSecureManager (options) {
  return buildManager({}, options)
}

function buildManager (authBase, options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-boats-display-manager-'))
  const app = {
    getDataDirPath: () => dataDir,
    debug: () => {}
  }
  const merged = mergeTestOptions({
    ...authBase,
    discoveryUdp: { enabled: false },
    deviceDiscoveryUdp: { enabled: false },
    firmware: { github: { enabled: false } },
    network: { mdns: { browser: false, advertiseManager: false } }
  }, options || {})
  return {
    dataDir,
    app,
    manager: new YeyBoatsDisplayManager(app, merged),
    auth: { bearer: options && options.auth && options.auth.devToken ? options.auth.devToken : 'yeyboats-dev' }
  }
}

function mergeTestOptions (base, override) {
  const out = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeTestOptions(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

// Log a skip notice for a test that needs an optional external (a live
// SignalK install, a sibling `instruments` checkout, ...) which is absent.
// Tests must call this and return instead of throwing, so `npm test` stays
// green on a bare clone (see MGR-1).
function skip (name, reason) {
  console.log(`SKIP ${name}: ${reason}`)
}

module.exports = { makeManager, makeSecureManager, mergeTestOptions, skip }
