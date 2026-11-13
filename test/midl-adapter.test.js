'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')
const { v2ToMidl, midlToV2 } = require('../lib/midl-adapter')

// The manifest-validation test needs the built MIDL bundle. It is built by the
// `pretest` hook; if that could not run (submodule absent), skip that one test
// rather than crash the suite (MGR-1).
const midlBuilt = fs.existsSync(
  path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs'))

const v2 = {
  settings: { defaultScreen: 'dashboard' },
  widgets: { items: { sog: { type: 'numeric', path: 'navigation.speedOverGround', unit: 'kn' } } },
  layout: { screens: [{ id: 'dashboard', type: 'grid', tiles: [{ widget: 'sog', area: { col: 0, row: 0 } }] }] },
}

test('v2ToMidl maps a numeric widget to a single-value element with a signalk binding', () => {
  const m = v2ToMidl(v2)
  assert.strictEqual(m.midl.match(/^\d+\.\d+\.\d+$/) != null, true)
  const screen = m.screens[0]
  assert.strictEqual(screen.id, 'dashboard')
  const el = screen.elements.sog
  assert.strictEqual(el.type, 'single-value')
  assert.deepStrictEqual(el.bindings.value, { kind: 'signalk', path: 'navigation.speedOverGround' })
  assert.strictEqual(el.format.unit, 'kn')
})

test('a 1x1 grid maps to a single-cell grid node referencing the element', () => {
  const m = v2ToMidl(v2)
  const layout = m.screens[0].layout
  assert.strictEqual(layout.rows, 1)
  assert.strictEqual(layout.cols, 1)
  assert.deepStrictEqual(layout.cells, [{ element: 'sog' }])
})

test('midlToV2 round-trips the element type and path', () => {
  const back = midlToV2(v2ToMidl(v2))
  assert.strictEqual(back.widgets.items.sog.type, 'numeric')
  assert.strictEqual(back.widgets.items.sog.path, 'navigation.speedOverGround')
})

test('a translated v2 dashboard validates against the square-480 manifest', {
  skip: midlBuilt ? false : 'MIDL bundle not built (midl/ts/dist/index.cjs missing)'
}, () => {
  const { validateMidl } = require('../lib/midl')
  const doc = JSON.stringify(v2ToMidl(v2))
  const r = validateMidl(doc, 'square-480')
  assert.strictEqual(r.ok, true, JSON.stringify(r.issues))
})

// ---------------------------------------------------------------------------
// #33: every document v2ToMidl emits must pass midl's validator — the device
// runs the same checks (instruments#37) and answers 422 otherwise. Padding is
// the schema's spacer cell {}, never { element: '' }; an element that needs a
// binding and has none is dropped; every element is placed exactly once.

const needsBuild = { skip: midlBuilt ? false : 'MIDL bundle not built (midl/ts/dist/index.cjs missing)' }

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
  // The structural checks above run everywhere; the validator only when built.
  if (!midlBuilt) return
  const { validateMidl } = require('../lib/midl')
  const r = validateMidl(JSON.stringify(doc), cls)
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

test('#33: an odd tile count pads the grid with {} spacer cells, never { element: "" }', () => {
  const doc = v2ToMidl(dash([
    { widget: 'sog', area: { col: 0, row: 0 } },
    { widget: 'stw', area: { col: 1, row: 0 } },
    { widget: 'dep', area: { col: 0, row: 1 } }
  ]))
  assert.deepStrictEqual(doc.screens[0].layout.cells, [{ element: 'sog' }, { element: 'stw' }, { element: 'dep' }, {}])
  assertWellFormed(doc)
})

test('#33: a widget with no binding is dropped (element and cell); a button needs none', () => {
  const doc = v2ToMidl(dash([
    { widget: 'sog', area: { col: 0, row: 0 } },
    { widget: 'empty', area: { col: 1, row: 0 } },
    { widget: 'blank', area: { col: 0, row: 1 } },
    { widget: 'btn', area: { col: 1, row: 1 } }
  ]))
  const s = doc.screens[0]
  assert.deepStrictEqual(Object.keys(s.elements).sort(), ['btn', 'sog'])
  assert.strictEqual(s.elements.btn.bindings, undefined)
  assertWellFormed(doc)
})

test('#33: editor-authored tiles (no area) all get a cell', () => {
  const doc = v2ToMidl(dash([{ widget: 'sog' }, { widget: 'stw' }, { widget: 'dep' }]))
  assert.strictEqual(cellsOf(doc).filter((c) => c.element).length, 3)
  assertWellFormed(doc)
})

test('#33: colliding areas, duplicate widgets and dangling widget refs still yield a valid doc', () => {
  const doc = v2ToMidl(dash([
    { widget: 'sog', area: { col: 0, row: 0 } },
    { widget: 'stw', area: { col: 0, row: 0 } },
    { widget: 'sog', area: { col: 1, row: 0 } },
    { widget: 'ghost', area: { col: 1, row: 1 } },
    { widget: 'dep', area: { col: -1, row: 'x' } }
  ]))
  assert.deepStrictEqual(Object.keys(doc.screens[0].elements).sort(), ['dep', 'sog', 'stw'])
  assertWellFormed(doc)
})

test('#33: windCircle binds value and dir from the field paths', () => {
  const doc = v2ToMidl(dash([{ widget: 'wind' }, { widget: 'hdg' }]))
  const el = doc.screens[0].elements.wind
  assert.strictEqual(el.type, 'windrose')
  assert.deepStrictEqual(el.bindings.value, { kind: 'signalk', path: 'environment.wind.speedApparent' })
  assert.deepStrictEqual(el.bindings.dir, { kind: 'signalk', path: 'environment.wind.angleApparent' })
  assertWellFormed(doc)
})

test('#33: 1..9 tile screens of every v2 widget type validate', () => {
  const kinds = ['sog', 'stw', 'dep', 'hdg', 'wind', 'btn', 'empty']
  for (let n = 1; n <= 9; n++) {
    const tiles = Array.from({ length: n }, (_, i) => ({ widget: kinds[i % kinds.length] }))
    const withAreas = tiles.map((t, i) => Object.assign({}, t, { area: { col: i % 3, row: Math.floor(i / 3) } }))
    for (const t of [tiles, withAreas]) {
      const doc = v2ToMidl(dash(t))
      assertWellFormed(doc)
    }
  }
})

test('#33: the editor round trip (midlToV2 -> v2ToMidl) stays valid', () => {
  const once = v2ToMidl(dash([{ widget: 'sog' }, { widget: 'hdg' }, { widget: 'dep' }]))
  const twice = v2ToMidl(midlToV2(once))
  assertWellFormed(twice)
})

test('#33: midlDocumentFor validates the outgoing doc; requireValidMidl refuses an invalid one with 422', needsBuild, () => {
  const { midlDocumentFor, requireValidMidl } = require('../lib/midl')
  const good = midlDocumentFor(dash([{ widget: 'sog' }]), 'square-480')
  assert.strictEqual(good.ok, true, JSON.stringify(good.issues))
  assert.strictEqual(good.doc.screens[0].elements.sog.type, 'single-value')
  assert.strictEqual(requireValidMidl(dash([{ widget: 'sog' }]), 'square-480').midl, '1.0.0')

  const none = midlDocumentFor({ widgets: { items: {} }, layout: { screens: [] } }, 'square-480')
  assert.strictEqual(none.ok, false)
  assert.throws(() => requireValidMidl({ widgets: { items: {} }, layout: { screens: [] } }, 'square-480'),
    (err) => err.status === 422 && err.payload.error.code === 'midl_invalid' && Array.isArray(err.payload.error.details.issues))
})

// --- routes: GET/POST /devices/:id/editor/midl ----------------------------
const { makeManager } = require('./test-utils')

function routes (manager) {
  const list = []
  const add = (method) => (p, ...h) => list.push({ method, p, h: h[h.length - 1] })
  const router = { use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }
  require('../index')._test.registerRoutes(router, () => manager)
  return (method, p) => list.find((r) => r.method === method && r.p === p)
}

function call (route, params, body) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      setHeader () {},
      status (c) { this.statusCode = c; return this },
      json (b) { resolve({ status: this.statusCode, json: b }) },
      end (b) { resolve({ status: this.statusCode, body: b }) }
    }
    Promise.resolve(route.h({ method: body ? 'POST' : 'GET', params, query: {}, headers: {}, body: body || {}, get: () => '' }, res)).catch(reject)
  })
}

function benchManager () {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-eeeeeeeeeeee'
  manager.registerDevice({ device: { id, name: 'Bench', role: 'display', board: 'sunton_4848s040', display: { width: 480, height: 480, shape: 'square' } } }, auth)
  manager.upsertProfile({ id: 'bench', name: 'Bench', config: { layout: { version: 1, screens: [] }, widgets: { version: 1, items: {} } } })
  manager.assignProfile(id, { profileId: 'bench' })
  const sid = manager.addScreen(id, { title: 'Dash' }).screens[0].id
  manager.addField(id, sid, { type: 'numeric', paths: { value: 'navigation.speedOverGround' }, unit: 'kn' })
  manager.addField(id, sid, { type: 'numeric', paths: { value: 'environment.depth.belowTransducer' }, unit: 'm' })
  manager.addField(id, sid, { type: 'compass', paths: { value: 'navigation.headingTrue' } })
  return { manager, id }
}

test('#33: GET /editor/midl serves a doc the device validator accepts, with its validation', needsBuild, async () => {
  const { manager, id } = benchManager()
  const r = await call(routes(manager)('GET', '/devices/:id/editor/midl'), { id })
  assert.strictEqual(r.status, 200)
  const doc = JSON.parse(r.json.doc)
  assertWellFormed(doc)
  assert.deepStrictEqual(r.json.validation, { ok: true, className: 'square-480', issues: [] })
})

test('#33: POST /editor/midl refuses a doc the device would reject (422) and stores nothing', needsBuild, async () => {
  const { manager, id } = benchManager()
  const get = routes(manager)
  const before = JSON.stringify(manager.editorLayout(id))
  const bad = {
    midl: '1.0.0',
    screens: [{ id: 'dash', elements: { sog: { type: 'single-value' } }, layout: { rows: 1, cols: 2, cells: [{ element: 'sog' }, { element: '' }] } }]
  }
  const r = await call(get('POST', '/devices/:id/editor/midl'), { id }, { doc: bad })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.code, 'midl_invalid')
  assert.strictEqual(JSON.stringify(manager.editorLayout(id)), before)

  const ok = JSON.parse((await call(get('GET', '/devices/:id/editor/midl'), { id })).json.doc)
  const r2 = await call(get('POST', '/devices/:id/editor/midl'), { id }, { doc: ok })
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.json))
})

test('#33: out-of-range areas flow instead of sizing the grid', () => {
  const doc = v2ToMidl(dash([{ widget: 'sog', area: { col: 3000, row: 3000 } }, { widget: 'stw', area: { col: 0, row: 0 } }]))
  const l = doc.screens[0].layout
  assert.ok(l.rows * l.cols <= 4, `grid ${l.rows}x${l.cols}`)
  assertWellFormed(doc)
})

test('#33: screen ids are made unique; a null screen does not throw', () => {
  const doc = v2ToMidl({ widgets: { items }, layout: { screens: [{ id: 'screen-2', tiles: [{ widget: 'sog' }] }, null, { id: 'screen-2', tiles: [] }] } })
  const ids = doc.screens.map((s) => s.id)
  assert.strictEqual(new Set(ids).size, ids.length, ids.join())
})

test('#33: midlToV2 keeps the value path and a dir binding as paths', () => {
  const back = midlToV2(v2ToMidl(dash([{ widget: 'wind' }, { widget: 'sog' }])))
  assert.deepStrictEqual(back.widgets.items.wind.paths, { value: 'environment.wind.speedApparent', dir: 'environment.wind.angleApparent' })
  assert.deepStrictEqual(back.widgets.items.sog.paths, { value: 'navigation.speedOverGround' })
})

test('#33: more tiles than the class allows is reported, not hidden', needsBuild, () => {
  const { midlDocumentFor } = require('../lib/midl')
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`w${i}`, { type: 'numeric', path: `p.v${i}` }]))
  const r = midlDocumentFor({ widgets: { items: many }, layout: { screens: [{ id: 's', tiles: Object.keys(many).map((widget) => ({ widget })) }] } }, 'square-480')
  assert.strictEqual(r.ok, false)
  assert.ok(r.issues.some((i) => /tile/i.test(i.message)), JSON.stringify(r.issues))
})

test('#33: roundTripLoss flags what the v2 dashboard model would drop', () => {
  const { roundTripLoss } = require('../lib/midl')
  const sv = (path) => ({ type: 'single-value', bindings: { value: { kind: 'signalk', path } } })
  const grid = (cells) => ({ rows: 1, cols: cells.length, cells })
  const doc = (screens) => ({ midl: '1.0.0', screens })
  assert.deepStrictEqual(roundTripLoss(doc([{ id: 's', elements: { a: sv('x.y') }, layout: grid([{ element: 'a' }, {}]) }])), [])
  const cases = {
    'root element layout': doc([{ id: 's', elements: { a: sv('x.y') }, layout: { element: 'a' } }]),
    'nested grid': doc([{ id: 's', elements: { a: sv('x.y') }, layout: grid([{ rows: 1, cols: 1, cells: [{ element: 'a' }] }]) }]),
    'local binding': doc([{ id: 's', elements: { a: { type: 'single-value', bindings: { value: { kind: 'local', id: 'baro' } } } }, layout: grid([{ element: 'a' }]) }]),
    'same id on two screens': doc([
      { id: 's1', elements: { a: sv('x.y') }, layout: grid([{ element: 'a' }]) },
      { id: 's2', elements: { a: sv('z.w') }, layout: grid([{ element: 'a' }]) }
    ]),
    'spanning cell': doc([{ id: 's', elements: { a: sv('x.y') }, layout: grid([{ element: 'a', colSpan: 2 }, {}]) }])
  }
  for (const [name, d] of Object.entries(cases)) {
    assert.ok(roundTripLoss(d).length > 0, name)
  }
})

test('#33: POST refuses a valid doc the dashboard model would mangle (422 midl_unsupported)', needsBuild, async () => {
  const { manager, id } = benchManager()
  const before = JSON.stringify(manager.editorLayout(id))
  const doc = {
    midl: '1.0.0',
    screens: [{ id: 'dash', elements: { a: { type: 'single-value', bindings: { value: { kind: 'signalk', path: 'navigation.speedOverGround' } } } }, layout: { element: 'a' } }]
  }
  const r = await call(routes(manager)('POST', '/devices/:id/editor/midl'), { id }, { doc })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.code, 'midl_unsupported')
  assert.strictEqual(JSON.stringify(manager.editorLayout(id)), before)
})

test('#33: a stale revision is a 409 before any validation', async () => {
  const { manager, id } = benchManager()
  const r = await call(routes(manager)('POST', '/devices/:id/editor/midl'), { id }, { doc: { midl: '1.0.0', screens: [] }, expectedRevision: 'stale' })
  assert.strictEqual(r.status, 409)
})

test('#33: without the validator, a push fails closed (503) and an editor save goes through flagged', async () => {
  const midlLib = require('../lib/midl')
  const real = midlLib.validateMidl
  midlLib.validateMidl = () => {
    const e = new Error(`Cannot find module '${require('path').join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs')}'`)
    e.code = 'MODULE_NOT_FOUND'
    throw e
  }
  try {
    assert.throws(() => midlLib.requireValidMidl(dash([{ widget: 'sog' }]), 'square-480'), (err) => err.status === 503)
    const { manager, id } = benchManager()
    const get = routes(manager)
    const g = await call(get('GET', '/devices/:id/editor/midl'), { id })
    assert.strictEqual(g.json.validation.ok, null)
    assert.strictEqual(g.json.validation.unavailable, true)
    const p = await call(get('POST', '/devices/:id/editor/midl'), { id }, { doc: JSON.parse(g.json.doc) })
    assert.strictEqual(p.status, 200, JSON.stringify(p.json))
    assert.strictEqual(p.json.validation.unavailable, true)
    // Any other validator failure is an error, not "unavailable".
    midlLib.validateMidl = () => { throw new TypeError('boom') }
    assert.throws(() => midlLib.checkMidlDoc({ midl: '1.0.0', screens: [] }, 'square-480'), /boom/)
  } finally {
    midlLib.validateMidl = real
  }
})

test('#33 (review 2): grid shape, dir bindings, variants, double placement, malformed docs', () => {
  const { roundTripLoss } = require('../lib/midl')
  const sv = (path) => ({ type: 'single-value', bindings: { value: { kind: 'signalk', path } } })
  const one = (elements, layout, extra) => ({ midl: '1.0.0', screens: [Object.assign({ id: 's', elements, layout }, extra || {})] })
  // A half-filled grid keeps its shape through the round trip.
  const half = one({ a: sv('x.a'), b: sv('x.b') }, { rows: 2, cols: 2, cells: [{ element: 'a' }, { element: 'b' }, {}, {}] })
  assert.deepStrictEqual(roundTripLoss(half), [])
  assert.deepStrictEqual(v2ToMidl(midlToV2(half)).screens[0].layout, half.screens[0].layout)
  const sparse = one({ a: sv('x.a') }, { rows: 1, cols: 3, cells: [{}, {}, { element: 'a' }] })
  assert.deepStrictEqual(roundTripLoss(sparse), [])
  // Lossy: a far column, a local dir, variants, one element in two cells.
  const wide = one({ a: sv('x.a'), b: sv('x.b') }, { rows: 1, cols: 13, cells: [{ element: 'a' }, ...Array(11).fill({}), { element: 'b' }] })
  assert.ok(roundTripLoss(wide).length, 'wide grid')
  const dir = one({ a: { type: 'compass', bindings: { value: { kind: 'signalk', path: 'h' }, dir: { kind: 'const', value: 0 } } } }, { rows: 1, cols: 1, cells: [{ element: 'a' }] })
  assert.ok(roundTripLoss(dir).some((i) => /dir/.test(i.path)), 'non-signalk dir')
  const variants = one({ a: sv('x.a') }, { rows: 1, cols: 1, cells: [{ element: 'a' }] }, { variants: [{ class: 'square-480', layout: { element: 'a' } }] })
  assert.ok(roundTripLoss(variants).length, 'variants')
  const twice = one({ a: sv('x.a') }, { rows: 1, cols: 2, cells: [{ element: 'a' }, { element: 'a' }] })
  assert.ok(roundTripLoss(twice).length, 'double placement')
  // Same element on two screens, identical: lossless, accepted.
  const shared = { midl: '1.0.0', screens: [
    { id: 's1', elements: { a: sv('x.a') }, layout: { rows: 1, cols: 1, cells: [{ element: 'a' }] } },
    { id: 's2', elements: { a: sv('x.a') }, layout: { rows: 1, cols: 1, cells: [{ element: 'a' }] } }] }
  assert.deepStrictEqual(roundTripLoss(shared), [])
  // A padded path is not mistaken for a non-signalk binding.
  assert.deepStrictEqual(roundTripLoss(one({ a: sv(' x.a ') }, { rows: 1, cols: 1, cells: [{ element: 'a' }] })), [])
  // Malformed docs are issues, not exceptions.
  for (const bad of [{ screens: 'abc' }, { screens: [null] }, { screens: [{ id: 's', layout: {} }] }]) {
    assert.ok(roundTripLoss(bad).length > 0, JSON.stringify(bad))
  }
  // __proto__ as an element id never becomes a prototype.
  const v2 = midlToV2(one({ ['__proto__']: sv('x.a') }, { rows: 1, cols: 1, cells: [{ element: '__proto__' }] }))
  assert.strictEqual(Object.getPrototypeOf(v2.widgets.items), Object.prototype)
})
