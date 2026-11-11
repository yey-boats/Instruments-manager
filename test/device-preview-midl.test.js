'use strict'

// instruments-manager#14 (roadmap S7, single renderer): the device page's live
// preview renders through the shared MIDL device bundle
// (public/midl-device.global.js, global `MidlWeb`) — the same renderer the
// firmware serves — instead of the hand-written public/live-preview.js.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const indexPlugin = require('../index')
const { makeManager } = require('./test-utils')

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
  assert.ok(fs.existsSync(path.join(PUBLIC, 'midl-device.global.js')), 'bundle is served from public/')
})

test('the preview payload carries the MIDL class manifest', () => {
  const cfg = previewPayload(devicePage())
  assert.ok(cfg.midl, 'midl block')
  assert.strictEqual(cfg.midl.className, 'square-480')
  assert.strictEqual(cfg.midl.manifest.classes[0].id, 'square-480')
  assert.deepStrictEqual(cfg.midl.viewport, { x: 0, y: 0, w: 480, h: 480 })
  assert.strictEqual(cfg.midl.types.windRose, 'windrose')
})

test('device-preview builds a MIDL doc per screen that the shared bundle renders with live values', () => {
  const cfg = previewPayload(devicePage())
  const ctx = { console, window: { __yeyboatsPreview: cfg } }
  ctx.window.window = ctx.window
  ctx.document = { getElementById: () => null }
  vm.createContext(ctx)
  // The bundle is a plain `var MidlWeb = ...` IIFE.
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'midl-device.global.js'), 'utf8') + '\nwindow.MidlWeb = MidlWeb;', ctx)
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'device-preview.js'), 'utf8'), ctx)
  const DP = ctx.window.YeyDevicePreview
  assert.ok(DP && typeof DP.midlDocFor === 'function', 'glue exposes its doc builder')

  const scr = {
    id: 'dash',
    tiles: [
      { widget: 'numeric', title: 'SOG', path: 'navigation.speedOverGround', unit: '', precision: null },
      { widget: 'compass', title: 'HDG', path: 'navigation.headingTrue', unit: '', precision: null,
        markers: [{ path: 'navigation.courseOverGroundTrue', glyph: 'triangle', filled: true, color: 'alarm' }] },
      { widget: 'windRose', title: 'AWA', path: 'environment.wind.angleApparent', unit: '', precision: null },
      { widget: 'bar', title: 'SOC', path: 'electrical.batteries.house.capacity.stateOfCharge', unit: '', precision: null, color: { value: '#36d399' } }
    ]
  }
  const doc = DP.midlDocFor(scr, cfg.midl)
  const values = {
    'navigation.speedOverGround': 3.1,
    'navigation.headingTrue': 1.57,
    'navigation.courseOverGroundTrue': 2.0,
    'environment.wind.angleApparent': 0.6,
    'electrical.batteries.house.capacity.stateOfCharge': 0.78
  }
  const provider = DP.makeProvider(values, {})
  const r = ctx.window.MidlWeb.renderDashboardSvg(JSON.stringify(doc), cfg.midl.manifest, cfg.midl.className, cfg.midl.viewport, provider)
  assert.ok(r.ok, `doc valid: ${JSON.stringify(r.issues)}`)
  assert.ok(r.svg.startsWith('<svg'), 'svg rendered')
  for (const t of ['SOG', 'SOC']) assert.ok(r.svg.includes(`>${t}<`), `${t} title drawn`)
  assert.ok(r.svg.includes('>6.0<') && r.svg.includes('>kn<'), 'SOG converted to knots')
  assert.ok(r.svg.includes('>90°<'), 'compass dial shows the heading in degrees')
  assert.ok(r.svg.includes('>34 deg<'), 'wind rose shows the apparent angle')
  assert.ok(r.svg.includes('>78.0 %<'), 'bar shows the ratio as percent')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(doc.screens[0].elements.t1.markers)),
    [{ glyph: 'triangle', color: 'danger', dir: { kind: 'signalk', path: 'navigation.courseOverGroundTrue' } }], 'compass marker mapped')
  const bare = JSON.parse(JSON.stringify(doc))
  delete bare.screens[0].elements.t1.markers
  const r0 = ctx.window.MidlWeb.renderDashboardSvg(JSON.stringify(bare), cfg.midl.manifest, cfg.midl.className, cfg.midl.viewport, provider)
  assert.notStrictEqual(r.svg, r0.svg, 'the marker is drawn on the dial')
  assert.ok(r.svg.includes('#36d399'), 'tile colour override drawn')

  // The path picker's live readout goes through the same formatter.
  assert.strictEqual(DP.liveValueFor(values, 'navigation.speedOverGround'), '6.0 kn')
  assert.strictEqual(DP.liveValueFor(values, 'nope'), '—')
})

function loadGlue (cfg) {
  const ctx = { console, window: { __yeyboatsPreview: cfg } }
  ctx.window.window = ctx.window
  ctx.document = { getElementById: () => null }
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'midl-device.global.js'), 'utf8') + '\nwindow.MidlWeb = MidlWeb;', ctx)
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'device-preview.js'), 'utf8'), ctx)
  return { DP: ctx.window.YeyDevicePreview, W: ctx.window.MidlWeb }
}

function draw (DP, W, cfg, scr, values) {
  return W.renderDashboardSvg(JSON.stringify(DP.midlDocFor(scr, cfg.midl)), cfg.midl.manifest, cfg.midl.className,
    cfg.midl.viewport, DP.makeProvider(values, {}))
}

// PR #31 review: odd tile counts padded the grid with { element: '' }, which
// the schema rejects, so 3/5/7/8-tile screens drew an error SVG.
test('screens with 1 to 9 tiles all render every tile', () => {
  const cfg = previewPayload(devicePage())
  const { DP, W } = loadGlue(cfg)
  for (let n = 1; n <= 9; n++) {
    const scr = { id: 's' + n, tiles: Array.from({ length: n }, (_, i) => ({ widget: 'numeric', title: 'T' + i, path: 'p.v' + i })) }
    const r = draw(DP, W, cfg, scr, {})
    assert.ok(r.ok, `${n} tiles: doc valid: ${JSON.stringify(r.issues)}`)
    const drawn = (r.svg.match(/>T\d<\/text>|>T\d</g) || []).length
    assert.strictEqual(drawn, n, `${n} tiles: all ${n} titles drawn`)
  }
})

// PR #31 review: the Route screen's SI values were shown unconverted
// (3704 m as "3704.0 nm", 5.144 m/s as "5.1 kn"), because the bundle's own
// path inference reads every navigation.course* path as an angle.
test('SignalK SI values convert to the display unit, as the old preview did', () => {
  const cfg = previewPayload(devicePage())
  const { DP, W } = loadGlue(cfg)
  const one = (p, v, extra) => {
    const tile = Object.assign({ widget: 'numeric', title: 'X', path: p }, extra || {})
    const r = draw(DP, W, cfg, { id: 'u', tiles: [tile] }, { [p]: v })
    assert.ok(r.ok, JSON.stringify(r.issues))
    return (r.svg.match(/>([^<>]+)</g) || []).map((s) => s.slice(1, -1)).join('|')
  }
  const cases = [
    ['navigation.courseRhumbline.nextPoint.distance', 3704, '2.0 nm'],
    ['navigation.courseGreatCircle.nextPoint.distance', 3704, '2.0 nm'],
    ['navigation.courseRhumbline.velocityMadeGood', 5.144, '10.0 kn'],
    ['navigation.courseGreatCircle.nextPoint.velocityMadeGood', 5.144, '10.0 kn'],
    ['navigation.courseGreatCircle.crossTrackError', 25, '25.0 m'],
    ['navigation.courseRhumbline.nextPoint.bearingTrue', Math.PI / 2, '90 deg'],
    ['navigation.speedThroughWater', 5.144, '10.0 kn'],
    ['environment.current.drift', 5.144, '10.0 kn'],
    ['environment.water.temperature', 293.15, '20.0 degC'],
    ['environment.depth.belowTransducer', 12.34, '12.3 m'],
    ['electrical.batteries.house.capacity.stateOfCharge', 0.78, '78.0 %']
  ]
  for (const [p, v, want] of cases) {
    const got = one(p, v)
    // Value and unit may be drawn as one text or as two.
    const [num, unit] = want.split(' ')
    assert.ok(got.includes(want) || (got.includes(num) && got.split('|').includes(unit)), `${p}=${v}: want ${want}, got ${got}`)
    assert.strictEqual(DP.liveValueFor({ [p]: v }, p), want, `${p} live readout`)
  }
  // An explicit tile unit is honoured with the right conversion.
  assert.ok(one('navigation.courseRhumbline.nextPoint.distance', 3704, { unit: 'nm' }).includes('2.0'), 'explicit nm')
  assert.ok(one('environment.water.temperature', 293.15, { unit: '°C' }).includes('20.0'), 'explicit °C')

  // The built-in Route screen, end to end.
  const route = cfg.screens.find((s) => s.id === 'route')
  assert.ok(route && route.tiles.length, 'route screen present')
  const values = {}
  for (const t of route.tiles) {
    if (/distance/i.test(t.path)) values[t.path] = 3704
    else if (/velocityMadeGood/i.test(t.path)) values[t.path] = 5.144
    else if (/crossTrackError/i.test(t.path)) values[t.path] = 25
    else values[t.path] = Math.PI / 2
  }
  const r = draw(DP, W, cfg, route, values)
  assert.ok(r.ok, JSON.stringify(r.issues))
  const text = (r.svg.match(/>([^<>]+)</g) || []).join('')
  assert.ok(!/3704/.test(text), `no unconverted metres on the Route screen: ${text}`)
  assert.ok(!/>5\.1</.test(text), `no unconverted m/s on the Route screen: ${text}`)
})
