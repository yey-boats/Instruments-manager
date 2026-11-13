'use strict'

// #32 — compass/wind-rose `markers` are validated server-side (colour + glyph +
// path + count), so an unchecked value can never reach the firmware config
// push. midl#28 made the MIDL schema and SVG renderer strict about colours; the
// manager mirrors that allowlist for the v2 widget markers it stores and serves
// to devices.

const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')

const schema = require('../lib/field-schema')
const { DEFAULT_MANIFEST, validateField, coerceField, sanitizeMarkers, isMarkerColor } = schema
const { makeManager } = require('./test-utils')

const XSS = '#fff"/><img src=x onerror=alert(1)>'
const compass = (markers) => ({ type: 'compass', paths: { value: 'navigation.headingTrue' }, markers })
const marker = (over) => Object.assign({ path: 'navigation.courseOverGroundTrue', glyph: 'triangle', filled: true, color: 'accent' }, over)

test('marker colours: hex literals and theme tokens pass, everything else is rejected', () => {
  for (const ok of ['#abc', '#aabbcc', '#AABBCCDD', 'accent', 'good', 'warn', 'alarm', 'bad', 'danger', 'fg']) {
    assert.strictEqual(isMarkerColor(ok), true, ok)
  }
  for (const bad of [XSS, '#ff', '#gggggg', 'red', 'accent\n', ' accent', 'url(#x)', 'constructor', '__proto__', '', null, 3]) {
    assert.strictEqual(isMarkerColor(bad), false, JSON.stringify(bad))
  }
})

test('marker colour allowlist matches the MIDL schema $defs/color', {
  skip: fs.existsSync(path.join(__dirname, '..', 'midl', 'schemas', 'yb-midl-config.schema.json'))
    ? false : 'midl submodule not checked out'
}, () => {
  const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'midl', 'schemas', 'yb-midl-config.schema.json'), 'utf8'))
  const pattern = s.$defs.color.pattern
  const tokens = pattern.match(/\|([a-z0-9|]+)\)\$/)[1].split('|')
  assert.deepStrictEqual(tokens.slice().sort(), schema.MARKER_COLOR_TOKENS.slice().sort(), 'same token set as the schema')
  const re = new RegExp(pattern.replace('(?![\\s\\S])', ''))
  for (const c of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'accent', 'nope', XSS]) {
    assert.strictEqual(isMarkerColor(c), re.test(c), c)
  }
})

test('validateField rejects a hostile marker colour', () => {
  const r = validateField(compass([marker({ color: XSS })]), DEFAULT_MANIFEST)
  assert.strictEqual(r.ok, false)
  assert.ok(r.errors.some((e) => e.field === 'markers[0].color' && e.code === 'marker_color_invalid'), JSON.stringify(r.errors))
})

test('validateField rejects an unknown glyph, a bad path, a non-boolean filled', () => {
  const r = validateField(compass([
    marker({ glyph: 'skull' }),
    marker({ path: 'a b<script>' }),
    marker({ path: 42 }),
    marker({ filled: 'yes' })
  ]), DEFAULT_MANIFEST)
  assert.strictEqual(r.ok, false)
  const codes = r.errors.map((e) => `${e.field}:${e.code}`)
  assert.ok(codes.includes('markers[0].glyph:marker_glyph_invalid'), codes.join())
  assert.ok(codes.includes('markers[1].path:marker_path_invalid'), codes.join())
  assert.ok(codes.includes('markers[2].path:marker_path_invalid'), codes.join())
  assert.ok(codes.includes('markers[3].filled:marker_filled_invalid'), codes.join())
})

test('validateField enforces the glyph list the device manifest reports', () => {
  const m = Object.assign({}, DEFAULT_MANIFEST, { glyphs: ['circle'] })
  assert.strictEqual(validateField(compass([marker({ glyph: 'circle' })]), m).ok, true)
  assert.strictEqual(validateField(compass([marker({ glyph: 'triangle' })]), m).ok, false)
})

test('validateField rejects markers that are not an array of objects, and too many markers', () => {
  assert.ok(validateField(compass('nope'), DEFAULT_MANIFEST).errors.some((e) => e.code === 'markers_invalid'))
  assert.ok(validateField(compass(['x']), DEFAULT_MANIFEST).errors.some((e) => e.code === 'marker_invalid'))
  const many = Array.from({ length: DEFAULT_MANIFEST.maxMarkersPerDial + 1 }, () => marker())
  assert.ok(validateField(compass(many), DEFAULT_MANIFEST).errors.some((e) => e.code === 'markers_too_many'))
  assert.strictEqual(validateField(compass(many.slice(1)), DEFAULT_MANIFEST).ok, true)
})

test('the preset marker rings validate', () => {
  const presets = require('../lib/screen-presets')
  for (const ring of [presets.steerMarkers(), presets.courseMarkers(true), presets.windMarkers()]) {
    const r = validateField(compass(ring), DEFAULT_MANIFEST)
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors))
  }
})

test('coerceField keeps only the known marker keys', () => {
  const c = coerceField(compass([marker({ id: 'cog', kind: 'rim', onclick: 'x', style: 'y' })]), DEFAULT_MANIFEST)
  assert.deepStrictEqual(c.markers, [{ id: 'cog', path: 'navigation.courseOverGroundTrue', glyph: 'triangle', filled: true, color: 'accent', kind: 'rim' }])
})

test('sanitizeMarkers drops invalid markers and caps the count', () => {
  const out = sanitizeMarkers([marker(), marker({ color: XSS }), marker({ glyph: 'skull' }), 'x', marker({ color: 'good' })], DEFAULT_MANIFEST)
  assert.deepStrictEqual(out.map((m) => m.color), ['accent', 'good'])
  const many = Array.from({ length: 20 }, () => marker())
  assert.strictEqual(sanitizeMarkers(many, DEFAULT_MANIFEST).length, DEFAULT_MANIFEST.maxMarkersPerDial)
  assert.deepStrictEqual(sanitizeMarkers('nope', DEFAULT_MANIFEST), [])
})

function freshManager () {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-dddddddddddd'
  manager.registerDevice({
    device: { id, name: 'Bench', role: 'display', board: 'sunton_4848s040', display: { width: 480, height: 480, shape: 'square' } }
  }, auth)
  return { manager, auth, id }
}

test('addField refuses a hostile marker with 422 and stores nothing', () => {
  const { manager, id } = freshManager()
  manager.upsertProfile({ id: 'bench', name: 'Bench', config: { layout: { version: 1, screens: [] }, widgets: { version: 1, items: {} } } })
  manager.assignProfile(id, { profileId: 'bench' })
  const sid = manager.addScreen(id, { title: 'Dash' }).screens[0].id
  assert.throws(() => manager.addField(id, sid, compass([marker({ color: XSS })])),
    (err) => err.status === 422 || err.statusCode === 422 || /field_invalid/.test(String(err.code || err.message)))
  assert.deepStrictEqual(manager.editorLayout(id).items, {}, 'nothing stored')
  assert.ok(!JSON.stringify(manager.store.profiles.profiles.bench).includes('onerror'), 'hostile colour must not be stored')
})

test('updateField refuses a new hostile marker, but cleans an unchanged stored one', () => {
  const { manager, id } = freshManager()
  manager.upsertProfile({ id: 'bench', name: 'Bench', config: { layout: { version: 1, screens: [] }, widgets: { version: 1, items: {} } } })
  manager.assignProfile(id, { profileId: 'bench' })
  const sid = manager.addScreen(id, { title: 'Dash' }).screens[0].id
  const wid = manager.addField(id, sid, compass([marker()])).screens[0].tiles[0].widget
  assert.throws(() => manager.updateField(id, sid, wid, compass([marker({ color: XSS })])), (err) => err.status === 422)
  // A ring stored before #32 (bypassing validation) and echoed back unchanged
  // by the field editor is cleaned, not refused.
  const legacy = [marker(), marker({ color: XSS })]
  manager.store.profiles.profiles.bench.config.widgets.items[wid].markers = legacy
  const layout = manager.updateField(id, sid, wid, Object.assign(compass(legacy), { title: 'HDG' }))
  assert.deepStrictEqual(layout.items[wid].markers, [marker()])
  assert.strictEqual(layout.items[wid].title, 'HDG')
})

test('device-reported glyph lists can narrow the known glyphs, never widen them', () => {
  const hostile = Object.assign({}, DEFAULT_MANIFEST, { glyphs: ['<svg onload=x>'] })
  assert.strictEqual(validateField(compass([marker({ glyph: '<svg onload=x>' })]), hostile).ok, false)
  assert.deepStrictEqual(sanitizeMarkers([marker({ glyph: '<svg onload=x>' })], hostile), [])
  const noGlyphs = Object.assign({}, DEFAULT_MANIFEST)
  delete noGlyphs.glyphs
  assert.strictEqual(validateField(compass([marker()]), noGlyphs).ok, true)
  const nullCap = Object.assign({}, DEFAULT_MANIFEST, { maxMarkersPerDial: null })
  assert.strictEqual(sanitizeMarkers([marker()], nullCap).length, 1, 'a null cap falls back to the default, not 0')
  const hugeCap = Object.assign({}, DEFAULT_MANIFEST, { maxMarkersPerDial: 100000 })
  assert.strictEqual(sanitizeMarkers(Array.from({ length: 50 }, () => marker()), hugeCap).length, DEFAULT_MANIFEST.maxMarkersPerDial, 'a device cannot widen the cap')
  let deep = { markers: [marker({ color: XSS })] }
  for (let i = 0; i < 40; i++) deep = { n: deep }
  assert.ok(!JSON.stringify(schema.sanitizeMarkersDeep(deep, DEFAULT_MANIFEST) || {}).includes('onerror'), 'depth guard fails closed')
  assert.strictEqual(isMarkerColor('accent'), true)
  assert.ok(validateField(compass([marker({ path: 'a..b' })]), DEFAULT_MANIFEST).errors.some((e) => e.code === 'marker_path_invalid'))
})

test('generateConfig never serves an unchecked marker, whatever route stored it', () => {
  const { manager, id } = freshManager()
  // A profile import / raw profile upsert bypasses the field editor entirely.
  manager.upsertProfile({
    id: 'imported',
    name: 'Imported',
    config: {
      layout: { version: 1, screens: [{ id: 'nav', type: 'grid', tiles: [
        { widget: 'hdg', area: { col: 0, row: 0 }, markers: [marker({ color: XSS })] }
      ] }] },
      widgets: { version: 1, items: {
        hdg: { type: 'compass', path: 'navigation.headingTrue', markers: [marker(), marker({ color: XSS }), marker({ glyph: '<svg onload=x>' })] }
      } }
    }
  })
  manager.assignProfile(id, { profileId: 'imported' })
  const cfg = manager.generateConfig(id)
  const text = JSON.stringify(cfg)
  assert.ok(!text.includes('onerror') && !text.includes('onload'), text)
  assert.deepStrictEqual(cfg.widgets.items.hdg.markers, [marker()])
  assert.deepStrictEqual(cfg.layout.screens[0].tiles[0].markers, [])
})

test('generateConfig checks markers at any depth: variants, defaults, nested keys', () => {
  const { manager, id } = freshManager()
  const bad = [marker({ color: XSS })]
  manager.upsertProfile({
    id: 'deep',
    name: 'Deep',
    config: {
      extra: { dial: { markers: bad } },
      layout: { version: 1, screens: [], variants: [{ id: 'sq', match: { display: { width: 480, height: 480 } }, screens: [
        { id: 'nav', type: 'grid', markers: bad, tiles: [{ widget: 'hdg', markers: bad, items: [{ markers: bad }] }] }
      ] }] },
      widgets: { version: 1, defaults: { markers: bad }, items: { hdg: { type: 'compass', path: 'navigation.headingTrue', dial: { markers: bad } } } }
    }
  })
  manager.assignProfile(id, { profileId: 'deep' })
  const text = JSON.stringify(manager.generateConfig(id))
  assert.ok(!text.includes('onerror'), text)
  assert.ok(JSON.stringify(manager.store.profiles.profiles.deep).includes('onerror'), 'the stored profile is not mutated')
})

test('the device page preview only carries checked markers', () => {
  const { manager, id } = freshManager()
  manager.upsertProfile({
    id: 'imported',
    name: 'Imported',
    config: {
      layout: { version: 1, screens: [{ id: 'nav', type: 'grid', tiles: [{ widget: 'hdg', area: { col: 0, row: 0 } }] }] },
      widgets: { version: 1, items: { hdg: { type: 'compass', path: 'navigation.headingTrue', markers: [marker(), marker({ color: XSS })] } } }
    }
  })
  manager.assignProfile(id, { profileId: 'imported' })
  const html = require('../index')._test.renderUi(manager, 'device', { params: { id }, query: {} })
  assert.ok(!html.includes('onerror'), 'hostile marker colour not in the page')
  assert.ok(html.includes('navigation.courseOverGroundTrue'), 'the valid marker is')
})
