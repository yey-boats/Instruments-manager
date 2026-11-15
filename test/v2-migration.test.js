'use strict'
// The one-time v2 -> MIDL profile migration (lib/v2-migration.js): every
// document it emits must pass midl's validator (the device runs the same
// checks and answers 422 otherwise).
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')
const { v2ToMidl, isV2PresetScreen, migrateV2Config, splitV2Config } = require('../lib/v2-migration')

const midlBuilt = fs.existsSync(path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs'))
// The screens the removed lib/screen-presets.js seeded, all display classes
// (the first 11 are sunton-480's).
const PRESET_SCREENS = require('./fixtures/v2-preset-screens.json')

function cellsOf (doc) { return doc.screens.flatMap((s) => s.layout.cells) }

function assertWellFormed (doc, cls = 'square-480') {
  for (const cell of cellsOf(doc)) {
    assert.ok(!('element' in cell) || (typeof cell.element === 'string' && cell.element.length > 0),
      `no empty element cells: ${JSON.stringify(cell)}`)
  }
  for (const s of doc.screens) {
    const placed = s.layout.cells.filter((c) => c.element).map((c) => c.element)
    assert.deepStrictEqual(placed.slice().sort(), Object.keys(s.elements).sort(), `screen ${s.id}: every element placed exactly once`)
    for (const [id, el] of Object.entries(s.elements)) {
      if (el.type !== 'button') {
        assert.ok(el.bindings && el.bindings.value && el.bindings.value.path, `element ${id} (${el.type}) has a value binding`)
      }
    }
  }
  if (!midlBuilt) return
  const r = require('../lib/midl').validateMidl(JSON.stringify(doc), cls)
  assert.strictEqual(r.ok, true, JSON.stringify(r.issues))
}

const items = {
  sog: { type: 'numeric', title: 'SOG', path: 'navigation.speedOverGround', unit: 'kn' },
  stw: { type: 'numeric', title: 'STW', path: 'navigation.speedThroughWater', unit: 'kn' },
  dep: { type: 'numeric', title: 'DEPTH', path: 'environment.depth.belowTransducer', unit: 'm' },
  hdg: { type: 'compass', title: 'HDG', paths: { value: 'navigation.headingTrue' }, path: 'navigation.headingTrue' },
  wind: { type: 'windCircle', title: 'WIND', paths: { value: 'environment.wind.speedApparent', dir: 'environment.wind.angleApparent' }, path: 'environment.wind.speedApparent' },
  empty: { type: 'numeric', title: 'NOTHING' },
  blank: { type: 'gauge', title: 'BLANK', path: '   ' },
  btn: { type: 'button', title: 'MOB' }
}
const dash = (tiles) => ({ widgets: { items }, layout: { screens: [{ id: 'dash', type: 'grid', tiles }] } })

test('a numeric field becomes a single-value element with a signalk binding in a 1x1 grid', () => {
  const m = v2ToMidl(dash([{ widget: 'sog', area: { col: 0, row: 0 } }]))
  assert.match(m.midl, /^\d+\.\d+\.\d+$/)
  const s = m.screens[0]
  assert.deepStrictEqual(s.elements.sog, { type: 'single-value', name: 'SOG', bindings: { value: { kind: 'signalk', path: 'navigation.speedOverGround' } }, format: { unit: 'kn' } })
  assert.deepStrictEqual(s.layout, { rows: 1, cols: 1, cells: [{ element: 'sog' }] })
  assertWellFormed(m)
})

test('an odd tile count pads with {} spacer cells; unbound fields are dropped, a button needs no binding', () => {
  const odd = v2ToMidl(dash([{ widget: 'sog', area: { col: 0, row: 0 } }, { widget: 'stw', area: { col: 1, row: 0 } }, { widget: 'dep', area: { col: 0, row: 1 } }]))
  assert.deepStrictEqual(odd.screens[0].layout.cells, [{ element: 'sog' }, { element: 'stw' }, { element: 'dep' }, {}])
  assertWellFormed(odd)
  const dropped = v2ToMidl(dash([{ widget: 'sog' }, { widget: 'empty' }, { widget: 'blank' }, { widget: 'btn' }]))
  assert.deepStrictEqual(Object.keys(dropped.screens[0].elements).sort(), ['btn', 'sog'])
  assertWellFormed(dropped)
})

test('colliding or out-of-range areas, duplicates and dangling refs still yield a valid doc', () => {
  const doc = v2ToMidl(dash([
    { widget: 'sog', area: { col: 0, row: 0 } },
    { widget: 'stw', area: { col: 0, row: 0 } },
    { widget: 'sog', area: { col: 1, row: 0 } },
    { widget: 'ghost', area: { col: 1, row: 1 } },
    { widget: 'dep', area: { col: 3000, row: 3000 } }
  ]))
  assert.deepStrictEqual(Object.keys(doc.screens[0].elements).sort(), ['dep', 'sog', 'stw'])
  const l = doc.screens[0].layout
  assert.ok(l.rows * l.cols <= 4, `grid ${l.rows}x${l.cols}`)
  assertWellFormed(doc)
  const ids = v2ToMidl({ widgets: { items }, layout: { screens: [{ id: 's', tiles: [{ widget: 'sog' }] }, null, { id: 's', tiles: [] }] } }).screens.map((s) => s.id)
  assert.strictEqual(new Set(ids).size, ids.length, ids.join())
})

test('windCircle binds value and dir; 1..9 tile screens of every field type validate', () => {
  const el = v2ToMidl(dash([{ widget: 'wind' }])).screens[0].elements.wind
  assert.strictEqual(el.type, 'windrose')
  assert.deepStrictEqual(el.bindings.dir, { kind: 'signalk', path: 'environment.wind.angleApparent' })
  const kinds = ['sog', 'stw', 'dep', 'hdg', 'wind', 'btn', 'empty']
  for (let n = 1; n <= 9; n++) {
    const tiles = Array.from({ length: n }, (_, i) => ({ widget: kinds[i % kinds.length] }))
    assertWellFormed(v2ToMidl(dash(tiles)))
    assertWellFormed(v2ToMidl(dash(tiles.map((t, i) => Object.assign({}, t, { area: { col: i % 3, row: Math.floor(i / 3) } })))))
  }
})

test('range, size, colour and checked markers travel; hostile markers do not', () => {
  const XSS = '#fff"/><img src=x onerror=alert(1)>'
  const doc = v2ToMidl({
    widgets: {
      items: {
        g: { type: 'gauge', path: 'a.b', range: { min: 0, max: 10 }, size: 20, color: { value: '#aabbcc' } },
        c: { type: 'compass', path: 'navigation.headingTrue', markers: [{ path: 'navigation.courseOverGroundTrue', glyph: 'triangle', color: 'accent' }, { path: 'x.y', glyph: 'triangle', color: XSS }, { path: 'x.y', glyph: 'skull' }] }
      }
    },
    layout: { screens: [{ id: 's', tiles: [{ widget: 'g' }, { widget: 'c' }] }] }
  })
  assert.deepStrictEqual(doc.screens[0].elements.g.style, { range: [0, 10], size: 20, color: '#aabbcc' })
  assert.deepStrictEqual(doc.screens[0].elements.c.markers, [{ glyph: 'triangle', color: 'accent', dir: { kind: 'signalk', path: 'navigation.courseOverGroundTrue' } }])
  assert.ok(!JSON.stringify(doc).includes('onerror'))
})

test('every seeded preset tile becomes a bound element; a preset windRose binds speed as value', () => {
  for (const screen of PRESET_SCREENS) {
    const doc = v2ToMidl({ widgets: { items: {} }, layout: { screens: [screen] } })
    assert.strictEqual(Object.keys(doc.screens[0].elements).length, screen.tiles.length, `${screen.id}: one element per tile`)
    assertWellFormed(doc)
  }
  const el = Object.values(v2ToMidl({ layout: { screens: [PRESET_SCREENS[0]] } }).screens[0].elements)[0]
  assert.strictEqual(el.type, 'windrose')
  assert.strictEqual(el.bindings.value.path, 'environment.wind.speedApparent')
  assert.strictEqual(el.bindings.dir.path, 'environment.wind.angleApparent')
  assert.ok(el.markers.length > 0, 'preset markers carried')
  for (const w of ['constructor', 'toString', '__proto__']) {
    assert.deepStrictEqual(v2ToMidl({ layout: { screens: [{ id: 's', tiles: [{ widget: w, primary: 'a.b' }] }] } }).screens[0].elements, {})
  }
})

test('seeded preset screens are recognised and dropped; edited screens become one record each', () => {
  for (const s of PRESET_SCREENS) assert.ok(isV2PresetScreen(s), s.id)
  const edited = Object.assign({}, PRESET_SCREENS[1], { title: 'My wind' })
  assert.strictEqual(isV2PresetScreen(edited), false)
  const out = migrateV2Config({
    settings: { defaultScreen: 'speed' },
    widgets: { items },
    layout: { screens: PRESET_SCREENS.slice(0, 11).concat([{ id: 'speed', title: 'Speed', tiles: [{ widget: 'sog' }, { widget: 'hdg' }] }]) }
  })
  assert.strictEqual(out.dropped, 11)
  assert.deepStrictEqual(out.records.map((r) => [r.id, r.source]), [['speed', 'migrated']])
  assert.strictEqual(out.index.defaultScreen, 'speed')
  const split = splitV2Config({ settings: { theme: 'night' }, layout: { screens: [] }, widgets: {} }, null)
  assert.deepStrictEqual(split.config, { settings: { theme: 'night' } })
  assert.deepStrictEqual(split.midl.records, [])
  assert.deepStrictEqual(splitV2Config({ settings: {} }, null), { config: { settings: {} }, midl: null })
})
