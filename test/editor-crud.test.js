'use strict'

// Slice 5 — manifest-gated layout-editor CRUD (manager methods backing the
// /editor/* routes). Exercises: manifest fallback vs device-reported,
// add/rename/reorder/delete screens (and the maxViews cap), add/update/remove
// fields (and the maxTilesPerScreen cap), manifest gating on field config,
// "save limits", orphan-item cleanup, and prototype-pollution guards.

const { test } = require('node:test')
const assert = require('node:assert')
const { makeManager } = require('./test-utils')

function freshManager () {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-cccccccccccc'
  manager.registerDevice({
    device: { id, name: 'Bench', role: 'display', board: 'sunton_4848s040', display: { width: 480, height: 480, shape: 'square' } }
  }, auth)
  // Give the device its own empty profile so we author from a clean slate.
  manager.upsertProfile({ id: 'bench', name: 'Bench', config: { layout: { version: 1, screens: [] }, widgets: { version: 1, items: {} } } })
  manager.assignProfile(id, { profileId: 'bench' })
  return { manager, auth, id }
}

// A small manifest a device might report; tighter caps than the default.
const REPORTED_MANIFEST = {
  viewTypes: {
    numeric: { paths: ['value'], attrs: ['title', 'format', 'size', 'unit', 'color'], zoom: ['auto'] },
    gauge: { paths: ['value'], attrs: ['title', 'size', 'unit', 'color', 'range', 'zones'], zoom: ['auto'] }
  },
  fontSizes: [16, 28, 48],
  units: { speed: ['kn', 'm/s'], depth: ['m', 'ft'] },
  maxViews: 2,
  maxTilesPerScreen: 2,
  paths: 'open',
  themes: ['day', 'night']
}

test('effectiveManifest falls back to default when device reports none', () => {
  const { manager, id } = freshManager()
  const m = manager.effectiveManifest(id)
  assert.ok(m.viewTypes.numeric, 'default manifest has numeric')
  assert.strictEqual(m.maxViews, 8)
})

test('effectiveManifest uses device-reported ui.capabilities', () => {
  const { manager, id, auth } = freshManager()
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { capabilities: REPORTED_MANIFEST } }, auth)
  const m = manager.effectiveManifest(id)
  assert.strictEqual(m.maxViews, 2)
  assert.ok(!m.viewTypes.compass, 'reported manifest omits compass')
})

test('add / rename / reorder / delete screens with maxViews cap', () => {
  const { manager, id, auth } = freshManager()
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { capabilities: REPORTED_MANIFEST } }, auth)

  let layout = manager.addScreen(id, { title: 'Dash' })
  assert.strictEqual(layout.screens.length, 1)
  const firstId = layout.screens[0].id
  assert.strictEqual(layout.screens[0].title, 'Dash')

  layout = manager.addScreen(id, { title: 'Nav' })
  assert.strictEqual(layout.screens.length, 2)

  // maxViews = 2 -> a third add is rejected.
  assert.throws(() => manager.addScreen(id, { title: 'Too many' }), /max.*view/i)

  // rename
  layout = manager.renameScreen(id, firstId, 'Dashboard')
  assert.strictEqual(layout.screens.find((s) => s.id === firstId).title, 'Dashboard')

  // reorder: put the second screen first
  const order = [layout.screens[1].id, layout.screens[0].id]
  layout = manager.reorderScreens(id, order)
  assert.deepStrictEqual(layout.screens.map((s) => s.id), order)

  // delete
  layout = manager.deleteScreen(id, order[0])
  assert.strictEqual(layout.screens.length, 1)
  assert.throws(() => manager.deleteScreen(id, 'nope'), /not_found|not found/i)
})

test('add / update / remove fields with maxTilesPerScreen cap + gating', () => {
  const { manager, id, auth } = freshManager()
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { capabilities: REPORTED_MANIFEST } }, auth)
  let layout = manager.addScreen(id, { title: 'Dash' })
  const sid = layout.screens[0].id

  layout = manager.addField(id, sid, { type: 'numeric', paths: { value: 'navigation.speedOverGround' }, size: 48, unit: 'kn' })
  let screen = layout.screens.find((s) => s.id === sid)
  assert.strictEqual(screen.tiles.length, 1)
  const widgetId = screen.tiles[0].widget
  assert.ok(layout.items[widgetId], 'widget item created')
  assert.strictEqual(layout.items[widgetId].paths.value, 'navigation.speedOverGround')

  layout = manager.addField(id, sid, { type: 'numeric', paths: { value: 'environment.depth.belowTransducer' }, unit: 'm' })
  assert.strictEqual(layout.screens.find((s) => s.id === sid).tiles.length, 2)

  // The per-screen cap is the MIDL display class's (square-480: 9), not the
  // device-reported legacy maxTilesPerScreen (#41): fill to 9, the 10th fails.
  const extra = []
  for (let n = 2; n < 9; n++) {
    const tiles = manager.addField(id, sid, { type: 'numeric', paths: { value: 'x' } }).screens.find((s) => s.id === sid).tiles
    extra.push(tiles[tiles.length - 1].widget)
  }
  assert.throws(() => manager.addField(id, sid, { type: 'numeric', paths: { value: 'x' } }), /max.*tile.*\(9\)/i)
  for (const w of extra) manager.removeField(id, sid, w)

  // update gating: an out-of-family unit (deg on a speed path) is COERCED away
  // — the editor normalizes rather than erroring, so the persisted field drops
  // the illegal unit.
  layout = manager.updateField(id, sid, widgetId, { type: 'numeric', paths: { value: 'navigation.speedOverGround' }, unit: 'deg' })
  assert.strictEqual(layout.items[widgetId].unit, undefined, 'deg unit stripped on a speed path')

  // update gating: a font size not in the manifest is SNAPPED to the nearest
  // legal size (33 -> 28, the nearest of [16,28,48]).
  layout = manager.updateField(id, sid, widgetId, { type: 'numeric', paths: { value: 'navigation.speedOverGround' }, size: 33 })
  assert.strictEqual(layout.items[widgetId].size, 28, 'size 33 snapped to 28')

  // a non-coercible problem (missing required path) IS rejected.
  assert.throws(() => manager.updateField(id, sid, widgetId, { type: 'numeric', paths: {} }), /manifest|field_invalid|invalid|required/i)

  // valid update applies.
  layout = manager.updateField(id, sid, widgetId, { type: 'numeric', paths: { value: 'navigation.speedOverGround' }, size: 28, unit: 'm/s' })
  assert.strictEqual(layout.items[widgetId].size, 28)
  assert.strictEqual(layout.items[widgetId].unit, 'm/s')

  // remove the first field; its widget item is garbage-collected.
  layout = manager.removeField(id, sid, widgetId)
  assert.strictEqual(layout.screens.find((s) => s.id === sid).tiles.length, 1)
  assert.ok(!layout.items[widgetId], 'orphan widget item removed')
})

test('range/zones only persist on gauge/bar; save limits writes them', () => {
  const { manager, id, auth } = freshManager()
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { capabilities: REPORTED_MANIFEST } }, auth)
  let layout = manager.addScreen(id, { title: 'Tanks' })
  const sid = layout.screens[0].id

  // numeric field: range is COERCED AWAY (not an error) — coerceField strips
  // range/zones on non-ranged types, so the persisted field has no range.
  layout = manager.addField(id, sid, { type: 'numeric', paths: { value: 'x' }, range: { min: 0, max: 1 } })
  const numWid = layout.screens.find((s) => s.id === sid).tiles[0].widget
  assert.strictEqual(layout.items[numWid].range, undefined, 'range stripped on numeric')
  // clear it so the gauge below is the screen's first tile.
  layout = manager.removeField(id, sid, numWid)

  // gauge field accepts range + zones.
  layout = manager.addField(id, sid, {
    type: 'gauge', paths: { value: 'environment.depth.belowTransducer' },
    range: { min: 0, max: 50 }, zones: [{ lower: 0, upper: 2, state: 'alarm', color: '#ff5252' }]
  })
  const wid = layout.screens.find((s) => s.id === sid).tiles[0].widget
  assert.deepStrictEqual(layout.items[wid].range, { min: 0, max: 50 })

  // save limits updates them.
  layout = manager.saveFieldLimits(id, sid, wid, { range: { min: 0, max: 80 }, zones: [{ lower: 0, upper: 5, state: 'alarm' }] })
  assert.deepStrictEqual(layout.items[wid].range, { min: 0, max: 80 })
  assert.strictEqual(layout.items[wid].zones.length, 1)
})

test('prototype-pollution guard on field id', () => {
  const { manager, id, auth } = freshManager()
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { capabilities: REPORTED_MANIFEST } }, auth)
  const layout = manager.addScreen(id, { title: 'Dash' })
  const sid = layout.screens[0].id
  assert.throws(() => manager.updateField(id, sid, '__proto__', { type: 'numeric', paths: { value: 'x' } }), /invalid|not_found|not found/i)
  // Object.prototype was not polluted.
  assert.strictEqual({}.type, undefined)
})

test('CRUD queues a config.reload so the device fetches the new layout', () => {
  const { manager, id } = freshManager()
  const before = manager.store.commands.commands.length
  manager.addScreen(id, { title: 'Dash' })
  const after = manager.store.commands.commands.filter((c) => c.deviceId === id && c.type === 'config.reload')
  assert.ok(after.length >= 1, 'a config.reload was queued')
  assert.ok(manager.store.commands.commands.length > before)
})

// #41: the tile cap comes from the device's MIDL display class.
test('#41: the tile cap follows the MIDL display class, which mirrors the generated manifests', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const midl = require('../lib/midl')
  for (const c of midl.MIDL_CLASSES) {
    const p = path.join(__dirname, '..', 'midl', 'schemas', 'gen', `yb-midl-capabilities.${c.id}.json`)
    if (!fs.existsSync(p)) continue // submodule absent: nothing to compare against
    const gen = JSON.parse(fs.readFileSync(p, 'utf8')).classes.find((k) => k.id === c.id)
    assert.strictEqual(c.maxTiles, gen.maxTiles, `${c.id} maxTiles mirrors the generated manifest`)
  }
  // The browser-side square-480 manifests carry the same cap.
  const square = midl.MIDL_CLASSES.find((c) => c.id === 'square-480').maxTiles
  for (const f of ['midl-editor.js', 'midl-preview.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')
    assert.ok(src.includes(`id: "square-480", width: 480, height: 480, maxTiles: ${square},`), `${f} square-480 maxTiles is ${square}`)
  }

  const { manager, id, auth } = freshManager()
  // A device reporting the legacy bound (4) still gets its class's cap.
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { capabilities: Object.assign({}, REPORTED_MANIFEST, { maxTilesPerScreen: 4, maxViews: 8 }) } }, auth)
  assert.strictEqual(manager.editorMaxTiles(id), 9)
  assert.strictEqual(manager.editorLayout(id).manifest.maxTilesPerScreen, 9)
  const sid = manager.addScreen(id, { title: 'Five' }).screens[0].id
  for (let n = 0; n < 5; n++) manager.addField(id, sid, { type: 'numeric', paths: { value: 'navigation.speedOverGround' } })
  assert.strictEqual(manager.editorLayout(id).screens.find((s) => s.id === sid).tiles.length, 5)

  // A wide (800x480) display is a landscape class: 6 tiles.
  const { manager: m2, auth: a2 } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const wide = 'yey-d-dddddddddddd'
  m2.registerDevice({ device: { id: wide, name: 'Wide', role: 'display', board: 'sunton_8048s050', display: { width: 800, height: 480, shape: 'wide' } } }, a2)
  assert.strictEqual(m2.editorMaxTiles(wide), 6)
})

test('#41: a valid 5-tile MIDL doc saves through POST /editor/midl (was 409)', async () => {
  const { manager, id } = freshManager()
  const list = []
  const add = (method) => (p, ...h) => list.push({ method, p, h: h[h.length - 1] })
  require('../index')._test.registerRoutes({ use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }, () => manager)
  const route = list.find((r) => r.method === 'POST' && r.p === '/devices/:id/editor/midl')
  const elements = {}
  const cells = []
  for (let i = 0; i < 5; i++) {
    elements['v' + i] = { type: 'single-value', bindings: { value: { kind: 'signalk', path: 'navigation.speedOverGround' } } }
    cells.push({ element: 'v' + i })
  }
  while (cells.length < 9) cells.push({})
  const doc = { midl: '1.0.0', screens: [{ id: 'five', elements, layout: { rows: 3, cols: 3, cells } }] }
  const r = await new Promise((resolve, reject) => {
    const res = { statusCode: 200, setHeader () {}, status (c) { this.statusCode = c; return this }, json (b) { resolve({ status: this.statusCode, json: b }) }, end (b) { resolve({ status: this.statusCode, body: b }) } }
    Promise.resolve(route.h({ method: 'POST', params: { id }, query: {}, headers: {}, body: { doc }, get: () => '' }, res)).catch(reject)
  })
  assert.strictEqual(r.status, 200, JSON.stringify(r.json))
  assert.strictEqual(manager.editorLayout(id).screens[0].tiles.length, 5)
})
