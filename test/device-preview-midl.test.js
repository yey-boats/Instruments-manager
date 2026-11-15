'use strict'

// instruments-manager#14 (roadmap S7, single renderer): the device page's live
// preview renders through the shared MIDL device bundle
// (public/midl-device.global.js, global `MidlWeb`) — the same renderer the
// firmware serves — instead of the hand-written public/live-preview.js.
// MIDL-only screens: every screen is drawn from its stored record doc (the
// profile's record or the embedded built-in), nothing flattened.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const indexPlugin = require('../index')
const { makeManager } = require('./test-utils')
const midlRecords = require('../lib/midl-records')

const PUBLIC = path.join(__dirname, '..', 'public')

function devicePage () {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  manager.registerDevice({ device: { id: 'yey-d-prev', board: 'esp32-4848s040' } }, auth)
  try {
    return indexPlugin.__renderDevicePage(manager, 'yey-d-prev')
  } finally {
    if (manager.close) manager.close()
  }
}

function previewPayload (html) {
  const m = html.match(/window\.__yeyboatsPreview=(\{.*?\});window\.__yeyboatsDeviceId=/s)
  assert.ok(m, 'preview payload on the page')
  return JSON.parse(m[1])
}

test('live-preview.js is gone', () => {
  assert.ok(!fs.existsSync(path.join(PUBLIC, 'live-preview.js')), 'public/live-preview.js deleted')
})

test('the device page mounts the shared MIDL device bundle, not live-preview.js', () => {
  const html = devicePage()
  assert.ok(!html.includes('live-preview.js'), 'no live-preview.js script')
  const bundle = html.indexOf('<script src="/yey-boats-display-manager/midl-device.global.js"></script>')
  const glue = html.indexOf('<script src="/yey-boats-display-manager/device-preview.js"></script>')
  assert.ok(bundle >= 0, 'shared bundle mounted')
  assert.ok(glue > bundle, 'device-preview glue loads after the bundle')
  const hist = html.indexOf('<script src="/yey-boats-display-manager/signalk-history.js"></script>')
  assert.ok(hist > bundle && hist < glue, 'trend backfill helper loads before the glue')
  assert.ok(fs.existsSync(path.join(PUBLIC, 'midl-device.global.js')), 'bundle is served from public/')
})

test('the preview payload carries the MIDL class manifest', () => {
  const cfg = previewPayload(devicePage())
  assert.ok(cfg.midl, 'midl block')
  assert.strictEqual(cfg.midl.className, 'square-480')
  assert.strictEqual(cfg.midl.manifest.classes[0].id, 'square-480')
  assert.deepStrictEqual(cfg.midl.viewport, { x: 0, y: 0, w: 480, h: 480 })
})

function loadGlue (cfg) {
  const ctx = { console, TextEncoder, TextDecoder, window: { __yeyboatsPreview: cfg } }
  ctx.window.window = ctx.window
  ctx.document = { getElementById: () => null }
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'midl-device.global.js'), 'utf8') + '\nwindow.MidlWeb = MidlWeb;', ctx)
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'device-preview.js'), 'utf8'), ctx)
  return { DP: ctx.window.YeyDevicePreview, W: ctx.window.MidlWeb }
}

test('every built-in screen is previewed from its embedded record doc, one screen each', () => {
  const cfg = previewPayload(devicePage())
  const builtins = midlRecords.loadBuiltins()
  const ids = cfg.screens.map((s) => s.id)
  assert.deepStrictEqual(ids, midlRecords.RECT_BUILTINS)
  const { DP, W } = loadGlue({})
  for (const scr of cfg.screens) {
    assert.strictEqual(scr.record, scr.id)
    assert.strictEqual(scr.doc.screens.length, 1)
    assert.deepStrictEqual(scr.doc.screens[0], builtins.get(scr.id).doc.screens[0], `${scr.id}: stored screen, unchanged`)
    const r = W.renderDashboardSvg(JSON.stringify(scr.doc), cfg.midl.manifest, cfg.midl.className, cfg.midl.viewport,
      DP.makeProvider({ 'navigation.speedOverGround': 3.1 }, {}, cfg.telemetry))
    assert.ok(r.ok, `${scr.id} renders: ${JSON.stringify(r.issues)}`)
    assert.ok(r.svg.startsWith('<svg'))
  }
})

test('a profile record (spans, windrose) is previewed as stored, not flattened', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  try {
    manager.registerDevice({ device: { id: 'yey-d-prev2', board: 'esp32-4848s040' } }, auth)
    const doc = {
      midl: '1.0.0',
      screens: [{
        id: 'passage',
        title: 'Passage',
        elements: {
          rose: { type: 'windrose', name: 'AWA', bindings: { value: { kind: 'signalk', path: 'environment.wind.speedApparent' }, dir: { kind: 'signalk', path: 'environment.wind.angleApparent' } } },
          sog: { type: 'single-value', name: 'SOG', bindings: { value: { kind: 'signalk', path: 'navigation.speedOverGround' } }, format: { unit: 'kn', decimals: 1 } }
        },
        layout: { rows: 2, cols: 2, cells: [{ element: 'rose', colSpan: 2 }, { element: 'sog', colSpan: 2 }] }
      }]
    }
    manager.upsertProfile({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }], index: { order: ['passage'] } } })
    manager.assignProfile('yey-d-prev2', { profileId: 'p' })
    const cfg = previewPayload(indexPlugin.__renderDevicePage(manager, 'yey-d-prev2'))
    assert.strictEqual(cfg.screens[0].id, 'passage')
    assert.strictEqual(JSON.stringify(cfg.screens[0].doc), JSON.stringify(doc))
    const { DP, W } = loadGlue({})
    const r = W.renderDashboardSvg(JSON.stringify(cfg.screens[0].doc), cfg.midl.manifest, cfg.midl.className, cfg.midl.viewport,
      DP.makeProvider({ 'navigation.speedOverGround': 3.1 }, {}))
    assert.ok(r.ok, JSON.stringify(r.issues))
    assert.ok(r.svg.includes('>6.0<'), 'SOG converted to knots')
  } finally {
    if (manager.close) manager.close()
  }
})

test('local bindings read the display telemetry; unknown ones stay empty', () => {
  const { DP } = loadGlue({})
  const p = DP.makeProvider({}, {}, { 'net.ip': '192.168.1.5' })
  assert.strictEqual(p.getValue({ kind: 'local', id: 'net.ip' }).value, '192.168.1.5')
  assert.strictEqual(p.getValue({ kind: 'local', id: 'sys.heap' }).present, false)
  assert.strictEqual(DP.liveValueFor({ 'navigation.speedOverGround': 3.1 }, 'navigation.speedOverGround'), '6.0 kn')
})

// The preview subscribed to every vessel and ignored the delta's context, so an
// AIS target's speedOverGround/position replaced the boat's own (seen on the
// bench, 2026-11-14: preview 17.1 kn while the display showed 3 kn).
test('the live preview keeps only this boat\'s deltas', () => {
  const { DP } = loadGlue({})
  const self = 'vessels.urn:mrn:signalk:uuid:self-1'
  assert.strictEqual(DP.isSelfDelta({ updates: [] }, self), true)
  assert.strictEqual(DP.isSelfDelta({ context: 'vessels.self', updates: [] }, self), true)
  assert.strictEqual(DP.isSelfDelta({ context: self, updates: [] }, self), true)
  assert.strictEqual(DP.isSelfDelta({ context: 'vessels.urn:mrn:imo:mmsi:244123456', updates: [] }, self), false)
  assert.strictEqual(DP.isSelfDelta({ context: 'vessels.urn:mrn:imo:mmsi:244123456', updates: [] }, null), false)
  const src = fs.readFileSync(path.join(PUBLIC, 'device-preview.js'), 'utf8')
  assert.ok(!src.includes('subscribe=all'), 'the stream is not subscribed to every vessel')
})

// Bench 2026-11-14 (display on red-night): the preview drew the default
// theme. It now uses the theme the display is drawing (supersedes #76).
test('the preview uses the theme the display reports, else day/night, else its own', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  try {
    const id = 'yey-d-prevtheme'
    manager.registerDevice({ device: { id, board: 'esp32-4848s040', display: { width: 480, height: 480, shape: 'square' } } }, auth)
    manager.assignProfile(id, { profileId: 'default', overrides: { settings: { theme: 'classic' } } })
    assert.deepStrictEqual(manager.deviceTheme(id), { theme: 'classic', source: 'settings' })
    manager.updateDayNight({ mode: 'schedule' })
    manager.setDayNightOverride('night')
    const dn = manager.deviceTheme(id)
    assert.strictEqual(dn.source, 'day-night')
    assert.strictEqual(dn.theme, manager.dayNightCurrent().theme)
    manager.updateStatus(id, { time: new Date().toISOString(), ui: { screen: 'nav', theme: 'red-night' } }, auth)
    assert.deepStrictEqual(manager.deviceTheme(id), { theme: 'red-night', source: 'device' })
    assert.strictEqual(manager.deviceViews(id).theme, 'red-night', 'the views poll carries the theme')
    assert.strictEqual(previewPayload(indexPlugin.__renderDevicePage(manager, id)).theme, 'red-night')
    manager.updateStatus(id, { time: new Date().toISOString(), ui: { screen: 'nav', theme: 'bogus' } }, auth)
    assert.notStrictEqual(manager.deviceTheme(id).source, 'device', 'an unknown reported theme is ignored')
  } finally {
    if (manager.close) manager.close()
  }
  const src = fs.readFileSync(path.join(PUBLIC, 'device-preview.js'), 'utf8')
  assert.match(src, /\{ trends, theme: themeName \}/, 'the theme goes to renderDashboardSvg')
  assert.match(src, /d\.theme !== themeName/, 'the views poll updates it without a reload')
})

test('the bundle draws the theme it is given, and prints positions in the firmware DDM format', () => {
  const { DP, W } = loadGlue({})
  const cfg = previewPayload(devicePage())
  const nav = cfg.screens.find((s) => s.id === 'nav')
  const draw = (theme) => W.renderDashboardSvg(JSON.stringify(nav.doc), cfg.midl.manifest, cfg.midl.className, cfg.midl.viewport,
    DP.makeProvider({ 'navigation.position': { latitude: 43.354683, longitude: 15.792867 } }, {}), { theme }).svg
  assert.notStrictEqual(draw('red-night'), draw('day'))
  assert.ok(draw('day').includes('43°21.281&#39;N'), 'DDM latitude, 3-decimal minutes')
  assert.ok(draw('day').includes('015°47.572&#39;E'), 'zero-padded longitude degrees')
})
