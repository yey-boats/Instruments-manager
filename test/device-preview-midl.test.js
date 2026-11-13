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
  assert.ok(r.svg.includes('>34 °<'), 'wind rose shows the apparent angle')
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
  // The midl bundle draws angle/temperature unit tokens as symbols
  // ("deg" -> "°", "degC" -> "°C"; midl web/src/format.ts unitLabel).
  const cases = [
    ['navigation.courseRhumbline.nextPoint.distance', 3704, '2.0 nm'],
    ['navigation.courseGreatCircle.nextPoint.distance', 3704, '2.0 nm'],
    ['navigation.courseRhumbline.velocityMadeGood', 5.144, '10.0 kn'],
    ['navigation.courseGreatCircle.nextPoint.velocityMadeGood', 5.144, '10.0 kn'],
    ['navigation.courseGreatCircle.crossTrackError', 25, '25.0 m'],
    ['navigation.courseRhumbline.nextPoint.bearingTrue', Math.PI / 2, '90 °'],
    ['navigation.speedThroughWater', 5.144, '10.0 kn'],
    ['environment.current.drift', 5.144, '10.0 kn'],
    ['environment.water.temperature', 293.15, '20.0 °C'],
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

// PR #31 review: a marker colour starting with '#' went into the SVG raw and
// the page inserts that SVG with innerHTML, so a saved layout was stored XSS.
// The glue now passes only theme tokens or #rgb/#rrggbb/#rrggbbaa literals.
test('hostile colours and glyphs never reach the SVG', () => {
  const cfg = previewPayload(devicePage())
  const { DP, W } = loadGlue(cfg)
  const hostile = [
    '#fff"/><img src=x onerror=alert(1)>',
    '#fff" onmouseover="alert(1)',
    '#fff;fill:url(javascript:alert(1))',
    'red" onmouseover="alert(1)',
    'javascript:alert(1)',
    '#ggg', 'constructor', '__proto__', 'toString'
  ]
  const inert = (svg, what) => {
    const low = svg.toLowerCase()
    assert.ok(!/<[^>]*\son[a-z]+\s*=/.test(low), `${what}: no event-handler attribute`)
    assert.ok(!low.includes('<img') && !low.includes('<script'), `${what}: no injected tags`)
    for (const m of svg.matchAll(/\s(fill|stroke)="([^"]*)"/g)) {
      assert.match(m[2], /^(none|rgba\(87,199,216,0\.06\)|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/, `${what}: ${m[1]}=${m[2]}`)
    }
  }
  for (const c of hostile) {
    for (const widget of ['compass', 'windRose']) {
      const scr = {
        id: 's',
        tiles: [
          { widget, title: 'D', path: 'navigation.headingTrue', color: { value: c, needle: c },
            markers: [{ path: 'navigation.courseOverGroundTrue', glyph: c, color: c }] },
          { widget: 'numeric', title: 'N', path: 'navigation.speedOverGround', color: { value: c } }
        ]
      }
      const doc = DP.midlDocFor(scr, cfg.midl)
      const json = JSON.stringify(doc)
      if (c.length > 9) assert.ok(!json.includes(c), `${widget} ${JSON.stringify(c)}: hostile value not in the doc`)
      const mk = doc.screens[0].elements.t0.markers[0]
      assert.strictEqual(mk.color, 'accent', `${widget} ${JSON.stringify(c)}: marker colour falls back to accent`)
      assert.strictEqual(mk.glyph, 'triangle', `${widget} ${JSON.stringify(c)}: unknown glyph falls back to triangle`)
      const r = draw(DP, W, cfg, scr, { 'navigation.headingTrue': 1, 'navigation.courseOverGroundTrue': 2, 'navigation.speedOverGround': 3 })
      assert.ok(r.ok, `${widget} ${JSON.stringify(c)}: doc valid: ${JSON.stringify(r.issues)}`)
      inert(r.svg, `${widget} ${JSON.stringify(c)}`)
    }
  }
  // legitimate values still pass
  const ok = DP.midlDocFor({ id: 's', tiles: [{ widget: 'compass', title: 'D', path: 'a.b', markers: [
    { path: 'c', glyph: 'diamond', color: '#AbC' }, { path: 'c', color: '#36d39980' }, { path: 'c', color: 'warn' }, { path: 'c', color: 'alarm' }] }] }, cfg.midl)
  assert.deepStrictEqual(ok.screens[0].elements.t0.markers.map((m) => [m.glyph, m.color]),
    [['diamond', '#AbC'], ['triangle', '#36d39980'], ['triangle', 'warn'], ['triangle', 'danger']])
})

// PR #31 review: the glue set `el.color`, but the renderer reads
// `style.color`, so a tile colour override never showed in the preview
// (live-preview.js did show it). The allowlist above still applies.
test('a tile colour override is drawn; a hostile one still is not', () => {
  const cfg = previewPayload(devicePage())
  const { DP, W } = loadGlue(cfg)
  const values = { 'navigation.speedOverGround': 3.1, 'navigation.headingTrue': 1 }
  const tiles = (c) => [
    { widget: 'numeric', title: 'SOG', path: 'navigation.speedOverGround', color: { value: c } },
    { widget: 'compass', title: 'HDG', path: 'navigation.headingTrue', color: { needle: c } }
  ]
  const base = draw(DP, W, cfg, { id: 's', tiles: tiles(undefined) }, values)
  assert.ok(base.ok, JSON.stringify(base.issues))
  assert.ok(!base.svg.includes('#123456'), 'no override colour without an override')
  const r = draw(DP, W, cfg, { id: 's', tiles: tiles('#123456') }, values)
  assert.ok(r.ok, JSON.stringify(r.issues))
  const numeric = W.renderDashboardSvg(JSON.stringify(DP.midlDocFor({ id: 's', tiles: tiles('#123456').slice(0, 1) }, cfg.midl)),
    cfg.midl.manifest, cfg.midl.className, cfg.midl.viewport, DP.makeProvider(values, {}))
  assert.ok(numeric.svg.includes('fill="#123456"'), 'numeric tile value drawn in the override colour')
  const warn = draw(DP, W, cfg, { id: 's', tiles: tiles('warn').slice(0, 1) }, values)
  assert.ok(warn.svg.includes('#ffb84d'), 'theme-token override resolves to the palette colour')
  const evil = '#fff"/><img src=x onerror=alert(1)>'
  const h = draw(DP, W, cfg, { id: 's', tiles: tiles(evil) }, values)
  assert.ok(h.ok, JSON.stringify(h.issues))
  assert.ok(!h.svg.toLowerCase().includes('<img') && !/\son[a-z]+\s*=/i.test(h.svg), 'hostile override inert')
  assert.strictEqual(h.svg, base.svg, 'hostile override is dropped, same as no override')
})

// #39: a managed (editor-authored) tile on a screen whose id matches a preset
// must not borrow the preset tile's title/unit/precision/markers by index.
test('#39: managed tiles are labelled from their own widget item, not the preset at the same index', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  try {
    const id = 'yey-d-prev'
    manager.registerDevice({ device: { id, board: 'esp32-4848s040', display: { width: 480, height: 480, shape: 'square' } } }, auth)
    // The preset this screen id falls back to (screen-presets "nav").
    const preset = require('../lib/screen-presets').getPresetsForClass('sunton-480').find((s) => s.id === 'nav')
    assert.ok(preset && preset.tiles.length >= 2, 'nav preset exists')
    manager.upsertProfile({
      id: 'ed',
      name: 'Ed',
      config: {
        widgets: {
          version: 1,
          items: {
            sog: { type: 'numeric', path: 'navigation.speedOverGround', paths: { value: 'navigation.speedOverGround' }, unit: 'kn', title: 'SOG' },
            hdg: { type: 'compass', path: 'navigation.headingTrue', paths: { value: 'navigation.headingTrue' } }
          }
        },
        layout: { version: 1, screens: [{ id: 'nav', type: 'grid', tiles: [{ widget: 'sog', area: { col: 0, row: 0 } }, { widget: 'hdg', area: { col: 1, row: 0 } }] }] }
      }
    })
    manager.assignProfile(id, { profileId: 'ed' })
    const nav = previewPayload(indexPlugin.__renderDevicePage(manager, id)).screens.find((s) => s.id === 'nav')
    assert.ok(nav, 'nav screen previewed')
    assert.strictEqual(nav.tiles[0].title, 'SOG')
    assert.strictEqual(nav.tiles[1].path, 'navigation.headingTrue')
    assert.strictEqual(nav.tiles[1].title, 'hdg', `untitled compass shows its widget id (as on the device), not "${preset.tiles[1].title}"`)
    assert.strictEqual(nav.tiles[1].unit, '')
    assert.strictEqual(nav.tiles[1].precision, null)
    assert.ok(nav.tiles[1].markers == null || nav.tiles[1].markers.length === 0, 'no preset markers borrowed')
  } finally {
    if (manager.close) manager.close()
  }
})
