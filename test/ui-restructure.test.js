const assert = require('assert')
const { makeManager } = require('./test-utils')
const { MockFirmware } = require('./mock-firmware')

const { manager, auth } = makeManager({
  auth: { mode: 'dev-shared-token', devToken: 'test-token' },
  network: { domain: 'local', hostnamePrefix: 'yey-d', namingPolicy: 'device-id' }
})
const dev = new MockFirmware(manager, {
  deviceId: 'yey-d-merge-1', auth,
  display: { width: 480, height: 480, shape: 'square', rotation: 0, colorDepth: 16 }
})
dev.register()

const idx = require('../index.js')
const dashboard = manager.dashboard()
const html = idx.__renderHomePage(dashboard, dashboard.devices, { query: {} }, manager)

assert.ok(/class="grid"/.test(html), 'merged page has the overview stat grid')
assert.ok(/Clear all/.test(html), 'merged page has the Clear all action')
assert.ok(/class="dev-list"/.test(html), 'merged page renders the unified device list')
assert.ok(/class="dev-row"/.test(html), 'unified list uses expandable device rows')
assert.ok(/yey-d-merge-1/.test(html), 'merged page lists the registered device')
// Refresh / Flash are real buttons now, not anchors.
assert.ok(/onclick="location.reload\(\)"/.test(html), 'Refresh is a real button')
assert.ok(/flash\.html/.test(html), 'Flash new device control is present')
console.log('ui-restructure.test: home merge OK')

const navHtml = idx.__nav('devices')
assert.ok(/>Devices</.test(navHtml), 'nav has Devices')
assert.ok(/>Firmware</.test(navHtml), 'nav has Firmware')
assert.ok(!/>Presets</.test(navHtml), 'nav no longer has Presets')
assert.ok(!/>Layout editor</.test(navHtml), 'nav no longer has Layout editor')
assert.ok(!/>Overview</.test(navHtml), 'nav no longer has Overview (merged into Devices)')
assert.ok(/class="active"[^>]*>Devices</.test(navHtml), 'Devices nav link is active for the devices page')
console.log('ui-restructure.test: nav trim OK')

// #42: every inline <script> in the UI shell must compile (a template-literal
// escape once turned a regex into a syntax error that silently disabled the
// form-submit interceptor), and the interceptor sends urlencoded bodies in the
// bubble phase so a form's own confirm() can cancel it.
{
  const shell = idx._test.renderUi(manager, 'devices', { params: {}, query: {} })
  const scripts = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.ok(scripts.length > 0, 'the UI shell has inline scripts')
  // eslint-disable-next-line no-new-func
  for (const src of scripts) assert.doesNotThrow(() => new Function(src), 'inline UI script compiles')
  const intercept = scripts.find((s) => s.includes("addEventListener('submit'"))
  assert.ok(intercept, 'submit interceptor present')
  assert.ok(intercept.includes('new URLSearchParams(data)'), 'interceptor posts urlencoded')
  assert.ok(intercept.includes('e.defaultPrevented'), 'interceptor honours a cancelled onsubmit')
  assert.ok(!intercept.includes('}, true)'), 'interceptor is not a capture-phase listener')
  assert.ok(intercept.includes("form.getAttribute('action')"), 'a control named action cannot shadow the post URL')
}
