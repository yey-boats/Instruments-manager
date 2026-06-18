const assert = require('assert')
const { makeManager } = require('./test-utils')
const { MockFirmware } = require('./mock-firmware')

const { manager, auth } = makeManager({
  auth: { mode: 'dev-shared-token', devToken: 'test-token' },
  network: { domain: 'local', hostnamePrefix: 'espdisp', namingPolicy: 'device-id' }
})
const dev = new MockFirmware(manager, {
  deviceId: 'espdisp-merge-1', auth,
  display: { width: 480, height: 480, shape: 'square', rotation: 0, colorDepth: 16 }
})
dev.register()

const idx = require('../index.js')
const dashboard = manager.dashboard()
const html = idx.__renderHomePage(dashboard, dashboard.devices, { query: {} }, manager)

assert.ok(/class="grid"/.test(html), 'merged page has the overview stat grid')
assert.ok(/Clear all/.test(html), 'merged page has the Clear all action')
assert.ok(/Registered \(/.test(html), 'merged page has the registered devices table')
assert.ok(/espdisp-merge-1/.test(html), 'merged page lists the registered device')
console.log('ui-restructure.test: home merge OK')

const navHtml = idx.__nav('devices')
assert.ok(/>Devices</.test(navHtml), 'nav has Devices')
assert.ok(/>Firmware</.test(navHtml), 'nav has Firmware')
assert.ok(!/>Presets</.test(navHtml), 'nav no longer has Presets')
assert.ok(!/>Layout editor</.test(navHtml), 'nav no longer has Layout editor')
assert.ok(!/>Overview</.test(navHtml), 'nav no longer has Overview (merged into Devices)')
console.log('ui-restructure.test: nav trim OK')
