'use strict'
// Validator on push: when a layout is stored (profile save, overrides,
// assignment, editor saves) the manager translates the dashboard every
// display that would receive it would be sent to MIDL and runs midl's
// validator for the display's class; a layout the device would reject is a
// 422 `layout_invalid` with the issues, and nothing changes. Only issues a
// change introduces count, so an already-invalid layout can be edited
// towards valid and resent.
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')
const { makeManager } = require('./test-utils')
const midlLib = require('../lib/midl')

const midlBuilt = fs.existsSync(path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs'))
const needsBuild = { skip: midlBuilt ? false : 'MIDL bundle not built (midl/ts/dist/index.cjs missing)' }

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
    Promise.resolve(route.h({ method: 'POST', params, query: {}, headers: {}, body: body || {}, get: () => '' }, res)).catch(reject)
  })
}

// A profile with one screen per entry of `counts`, each of that many numeric
// tiles (screen ids dash, second, third...).
const SCREEN_IDS = ['dash', 'second', 'third']
function tilesConfig (counts) {
  const items = {}
  const screens = [].concat(counts).map((n, si) => {
    const tiles = []
    for (let i = 0; i < n; i++) {
      const w = `s${si}w${i}`
      items[w] = { type: 'numeric', path: `environment.test.s${si}v${i}` }
      tiles.push({ widget: w })
    }
    return { id: SCREEN_IDS[si], type: 'grid', tiles }
  })
  return { layout: { version: 1, screens }, widgets: { version: 1, items } }
}
function tilesProfile (id, n) {
  return { id, name: id, config: tilesConfig(n) }
}
// Store a profile and assignment directly, skipping validation (what an
// older manager, or a hand-edited store, leaves behind).
function storeRaw (manager, deviceId, profileId, config) {
  manager.store.profiles.profiles[profileId] = { id: profileId, name: profileId, version: 1, config }
  if (deviceId) manager.getDevice(deviceId).assignedProfile = profileId
}

function bench () {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const reg = (id, display, extra) => manager.registerDevice({ device: Object.assign({ id, name: id, role: 'display', board: 'sunton_4848s040', display }, extra || {}) }, auth)
  const square = 'yey-d-aaaaaaaaaaaa'
  const round = 'yey-d-bbbbbbbbbbbb'
  reg(square, { width: 480, height: 480, shape: 'square' }, { location: 'helm' })
  reg(round, { width: 360, height: 360, shape: 'round' }, { location: 'helm' })
  manager.upsertProfile(tilesProfile('six', 6)) // fits square-480 (9), not round-360 (4)
  manager.upsertProfile(tilesProfile('twelve', 12)) // fits neither
  manager.upsertProfile(tilesProfile('three', 3))
  manager.upsertProfile({ id: 'broken', name: 'broken', config: { layout: { screens: 'dash' }, widgets: { items: { a: null } } } })
  return { manager, square, round }
}

const reloads = (manager, id) => manager.pendingCommands(id).filter((c) => c.type === 'config.reload').length

test('v2LayoutIssues names malformed dashboard shapes by path', () => {
  const v = midlLib.v2LayoutIssues
  assert.deepStrictEqual(v({}), [])
  assert.deepStrictEqual(v({ layout: { screens: [] }, widgets: { items: {} } }), [])
  assert.deepStrictEqual(v(null), [{ path: '', message: 'the dashboard config must be an object' }])
  const paths = (c) => v(c).map((i) => i.path)
  assert.deepStrictEqual(paths({ layout: [] }), ['/layout'])
  assert.deepStrictEqual(paths({ layout: { screens: 'x' } }), ['/layout/screens'])
  assert.deepStrictEqual(paths({ layout: { screens: [null, { tiles: 'x' }, { tiles: [null, { widget: 3 }, { widget: 'a' }] }] } }),
    ['/layout/screens/0', '/layout/screens/1/tiles', '/layout/screens/2/tiles/0', '/layout/screens/2/tiles/1/widget'])
  assert.deepStrictEqual(paths({ layout: { variants: [{ screens: [7] }, 'x'] } }), ['/layout/variants/0/screens/0', '/layout/variants/1'])
  assert.deepStrictEqual(paths({ widgets: { items: [] } }), ['/widgets/items'])
  assert.deepStrictEqual(paths({ widgets: { items: { a: null, b: {} } } }), ['/widgets/items/a'])
  // widgets.variants: not an array, or a null/array entry (selectVariant
  // would otherwise crash with a 500).
  assert.deepStrictEqual(paths({ widgets: { variants: 'x' } }), ['/widgets/variants'])
  assert.deepStrictEqual(paths({ widgets: { variants: [null, [], { match: {} }] } }), ['/widgets/variants/0', '/widgets/variants/1'])
  assert.deepStrictEqual(paths({ widgets: { variants: null, items: { a: null } } }), ['/widgets/items/a'])
})

test('garbage widgets.variants in overrides is a 422, not a 500', async () => {
  const { manager, square } = bench()
  for (const overrides of [{ widgets: { variants: 'x' } }, { widgets: { variants: [null] } }]) {
    const r = await call(routes(manager)('POST', '/devices/:id/profile'), { id: square }, { profileId: 'default', overrides })
    assert.strictEqual(r.status, 422, JSON.stringify(r.json))
    assert.strictEqual(r.json.error.code, 'layout_invalid')
  }
})

test('assigning a layout the display would reject is a 422 with the issues; nothing changes', needsBuild, async () => {
  const { manager, round } = bench()
  const before = manager.getDevice(round).assignedProfile
  const r = await call(routes(manager)('POST', '/devices/:id/profile'), { id: round }, { profileId: 'six', sendReload: true })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.code, 'layout_invalid')
  assert.strictEqual(r.json.error.details.deviceId, round)
  assert.strictEqual(r.json.error.details.className, 'round-360')
  assert.ok(r.json.error.details.issues.length > 0)
  assert.strictEqual(r.json.error.details.issues[0].screen, 'dash')
  assert.match(r.json.error.message, /round-360/)
  assert.strictEqual(manager.getDevice(round).assignedProfile, before, 'assignment unchanged')
  assert.strictEqual(reloads(manager, round), 0, 'no config.reload queued')
})

test('a valid layout is assigned and pushed, with its validation', needsBuild, async () => {
  const { manager, square } = bench()
  const r = await call(routes(manager)('POST', '/devices/:id/profile'), { id: square }, { profileId: 'six', sendReload: true })
  assert.strictEqual(r.status, 200, JSON.stringify(r.json))
  assert.strictEqual(r.json.layoutValidation.validation, 'ok')
  assert.strictEqual(r.json.layoutValidation.devices[0].className, 'square-480')
  assert.strictEqual(manager.getDevice(square).assignedProfile, 'six')
  assert.strictEqual(reloads(manager, square), 1)
})

test('a structurally malformed layout is a 422 naming the paths, not a 500', async () => {
  const { manager, square } = bench()
  const r = await call(routes(manager)('POST', '/devices/:id/profile'), { id: square }, { profileId: 'broken' })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.code, 'layout_invalid')
  assert.deepStrictEqual(r.json.error.details.issues.map((i) => i.path), ['/layout/screens', '/widgets/items/a'])
})

test('applying a profile checks every display first: one rejection changes none', needsBuild, async () => {
  const { manager, square, round } = bench()
  const r = await call(routes(manager)('POST', '/profiles/:id/apply'), { id: 'six' }, { deviceIds: [square, round], sendReload: true })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.details.deviceId, round)
  assert.notStrictEqual(manager.getDevice(square).assignedProfile, 'six', 'the valid display was not changed either')
  assert.strictEqual(reloads(manager, square), 0)
  // Both rejected: every display is listed.
  const both = await call(routes(manager)('POST', '/profiles/:id/apply'), { id: 'twelve' }, { deviceIds: [square, round] })
  assert.strictEqual(both.status, 422)
  assert.deepStrictEqual(both.json.error.details.devices.map((d) => d.deviceId), [square, round])
  // A profile that fits both applies to both.
  const ok = await call(routes(manager)('POST', '/profiles/:id/apply'), { id: 'three' }, { deviceIds: [square, round], sendReload: true })
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json))
  assert.strictEqual(manager.getDevice(round).assignedProfile, 'three')
})

test('UI apply form: one rejection changes no display', needsBuild, async () => {
  const { manager, square, round } = bench()
  const get = routes(manager)
  const r = await call(get('POST', '/ui/profiles/:id/apply'), { id: 'six' }, { deviceIds: [square, round], sendReload: 'on' })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.notStrictEqual(manager.getDevice(square).assignedProfile, 'six')
  assert.strictEqual(reloads(manager, square), 0)
  const ok = await call(get('POST', '/ui/profiles/:id/apply'), { id: 'three' }, { deviceIds: [square, round], sendReload: 'on' })
  assert.strictEqual(ok.status, 303)
  assert.strictEqual(manager.getDevice(round).assignedProfile, 'three')
})

test('an explicit config.reload of an already-stored invalid layout goes through with a warning', needsBuild, async () => {
  const { manager, square, round } = bench()
  // Stored without validation (e.g. an older manager), then pushed.
  manager.getDevice(round).assignedProfile = 'six'
  const get = routes(manager)
  const r = await call(get('POST', '/devices/:id/command'), { id: round }, { type: 'config.reload' })
  assert.strictEqual(r.status, 200, JSON.stringify(r.json))
  assert.strictEqual(r.json.type, 'config.reload')
  assert.strictEqual(r.json.layoutValidation.validation, 'issues')
  assert.match(r.json.layoutValidation.warning, /round-360/)
  assert.strictEqual(reloads(manager, round), 1)
  // The stored command is not decorated.
  assert.strictEqual(manager.pendingCommands(round)[0].layoutValidation, undefined)
  const g = await call(get('POST', '/groups/:groupId/command'), { groupId: 'helm' }, { type: 'config.reload' })
  assert.strictEqual(g.status, 200, JSON.stringify(g.json))
  assert.strictEqual(g.json.count, 2)
  assert.strictEqual(g.json.layoutValidation.validation, 'issues')
  assert.strictEqual(reloads(manager, square), 1)
  // Other commands carry no validation.
  const s = await call(get('POST', '/devices/:id/command'), { id: round }, { type: 'screen.set', payload: { screen: 'dash' } })
  assert.strictEqual(s.status, 200, JSON.stringify(s.json))
  assert.strictEqual(s.json.layoutValidation, undefined)
})

test('re-assigning what a display already has only warns', needsBuild, async () => {
  const { manager, round } = bench()
  manager.getDevice(round).assignedProfile = 'six'
  const r = await call(routes(manager)('POST', '/devices/:id/profile'), { id: round }, { profileId: 'six', sendReload: true })
  assert.strictEqual(r.status, 200, JSON.stringify(r.json))
  assert.strictEqual(r.json.layoutValidation.validation, 'issues')
})

test('an empty layout is not checked (the display shows its built-in dashboard)', () => {
  const { manager, square } = bench()
  const r = manager.checkDeviceLayout(square, { profileId: 'default' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.skipped, 'no screens')
})

test('issues compare by screen id and kind: an overfull layout can be edited towards valid', needsBuild, () => {
  const { manager, square } = bench()
  // 12 tiles on square-480 (9), stored without validation.
  storeRaw(manager, square, 'big', tilesConfig(12))
  const allowed = (cfg) => manager.requireValidDeviceLayout(square, { profileConfig: cfg }, true)
  // 12 -> 11: the same issue ("too many tiles" on dash) with a smaller count.
  assert.strictEqual(allowed(tilesConfig(11)).validation, 'issues')
  // 12 -> 13: the count grows.
  assert.throws(() => allowed(tilesConfig(13)), (e) => e.status === 422 && /13 > 9/.test(e.message))
  // Two overfull screens; deleting the first leaves the second (now at
  // index 0) overfull: allowed.
  storeRaw(manager, square, 'two', tilesConfig([12, 11]))
  const one = tilesConfig([12, 11])
  one.layout.screens.shift()
  assert.strictEqual(allowed(one).validation, 'issues')
  // Adding a tile to an overfull screen: refused, naming that screen.
  assert.throws(() => allowed(tilesConfig([12, 12])), (e) => e.status === 422 &&
    e.payload.error.details.issues.length === 1 && e.payload.error.details.issues[0].screen === 'second')
  // A new overfull screen: refused.
  assert.throws(() => allowed(tilesConfig([12, 11, 10])), (e) => e.status === 422 &&
    e.payload.error.details.issues[0].screen === 'third')
  // Without compare, every issue counts.
  assert.throws(() => manager.requireValidDeviceLayout(square, { profileConfig: tilesConfig(11) }), (e) => e.status === 422)
})

test('POST /profiles checks every display using the profile', needsBuild, async () => {
  const { manager, square, round } = bench()
  const get = routes(manager)
  manager.assignProfile(square, { profileId: 'three' })
  manager.assignProfile(round, { profileId: 'three' })
  // 6 tiles fit square-480 but not round-360, which shares the profile.
  const r = await call(get('POST', '/profiles'), {}, tilesProfile('three', 6))
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.details.deviceId, round)
  assert.strictEqual(manager.store.profiles.profiles.three.config.layout.screens[0].tiles.length, 3, 'nothing stored')
  // A profile nobody uses is stored.
  const free = await call(get('POST', '/profiles'), {}, tilesProfile('spare', 12))
  assert.strictEqual(free.status, 200, JSON.stringify(free.json))
  assert.deepStrictEqual(free.json.layoutValidation, { validation: 'ok', devices: [] })
  // Shrinking an overfull shared profile is allowed.
  storeRaw(manager, null, 'three', tilesConfig(12))
  const shrink = await call(get('POST', '/profiles'), {}, tilesProfile('three', 11))
  assert.strictEqual(shrink.status, 200, JSON.stringify(shrink.json))
  assert.strictEqual(shrink.json.layoutValidation.validation, 'issues')
})

test('dashboard import checks the displays using the preset it replaces', needsBuild, async () => {
  const { manager, round } = bench()
  manager.assignProfile(round, { profileId: 'three' })
  const r = await call(routes(manager)('POST', '/profiles/import-dashboard'), {}, { presetId: 'three', dashboard: tilesConfig(6) })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
})

test('PATCH /devices/:id checks new overrides or a new profile before storing', needsBuild, async () => {
  const { manager, round } = bench()
  const get = routes(manager)
  manager.assignProfile(round, { profileId: 'three' })
  const overrides = JSON.stringify(manager.getDevice(round).overrides)
  const r = await call(get('PATCH', '/devices/:id'), { id: round }, { overrides: tilesConfig(6) })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(JSON.stringify(manager.getDevice(round).overrides), overrides)
  const p = await call(get('PATCH', '/devices/:id'), { id: round }, { assignedProfile: 'six' })
  assert.strictEqual(p.status, 422, JSON.stringify(p.json))
  assert.strictEqual(manager.getDevice(round).assignedProfile, 'three')
  // A rename is not a layout change.
  const n = await call(get('PATCH', '/devices/:id'), { id: round }, { name: 'Helm round' })
  assert.strictEqual(n.status, 200)
  assert.strictEqual(n.json.layoutValidation, undefined)
  const ok = await call(get('PATCH', '/devices/:id'), { id: round }, { assignedProfile: 'default' })
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json))
  assert.strictEqual(ok.json.layoutValidation.validation, 'ok')
})

test('editor saves (mutateEditorLayout) check every display sharing the profile', needsBuild, () => {
  const { manager, square, round } = bench()
  manager.assignProfile(square, { profileId: 'three' })
  manager.assignProfile(round, { profileId: 'three' })
  const addTiles = (n) => (cfg) => {
    for (let i = 0; i < n; i++) {
      cfg.widgets.items[`x${i}`] = { type: 'numeric', path: `environment.extra.v${i}` }
      cfg.layout.screens[0].tiles.push({ widget: `x${i}` })
    }
  }
  // Through the square display (9 per screen): fine for it, not for round.
  assert.throws(() => manager.mutateEditorLayout(square, addTiles(3)),
    (e) => e.status === 422 && e.payload.error.details.deviceId === round)
  assert.strictEqual(manager.store.profiles.profiles.three.config.layout.screens[0].tiles.length, 3)
  const ok = manager.mutateEditorLayout(square, addTiles(1))
  assert.strictEqual(ok.layoutValidation.validation, 'ok')
  assert.deepStrictEqual(ok.layoutValidation.devices.map((d) => d.deviceId).sort(), [square, round].sort())
})

test('MIDL editor save reports layoutValidation for the displays on the profile', needsBuild, async () => {
  const { manager, square, round } = bench()
  manager.assignProfile(square, { profileId: 'three' })
  manager.assignProfile(round, { profileId: 'three' })
  const get = routes(manager)
  const doc = JSON.parse((await call(get('GET', '/devices/:id/editor/midl'), { id: square })).json.doc)
  const ok = await call(get('POST', '/devices/:id/editor/midl'), { id: square }, { doc })
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json))
  assert.strictEqual(ok.json.layoutValidation.validation, 'ok')
})

test('save-screen (Show on device) checks every display on the profile', needsBuild, async () => {
  const { manager, square, round } = bench()
  manager.upsertProfile(tilesProfile('four', 4))
  manager.assignProfile(square, { profileId: 'four' })
  manager.assignProfile(round, { profileId: 'four' })
  const get = routes(manager)
  const edit = (tileIndex) => JSON.stringify([{ screenId: 'dash', tileIndex, widget: 'numeric', path: 'environment.extra.v' }])
  // Rebinding tile 0 changes nothing structural.
  const ok = await call(get('POST', '/ui/devices/:id/save-screen'), { id: square }, { mode: 'update', ajax: '1', edits: edit(0) })
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json))
  assert.strictEqual(ok.json.status, 'updated')
  assert.strictEqual(ok.json.layoutValidation.validation, 'ok')
  // A fifth tile fits square-480 but not round-360.
  const r = await call(get('POST', '/ui/devices/:id/save-screen'), { id: square }, { mode: 'update', ajax: '1', edits: edit(4) })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.details.deviceId, round)
  assert.strictEqual(manager.store.profiles.profiles.four.config.layout.screens[0].tiles.length, 4)
})

// The config form posts parallel arrays: screenId[], tileWidget[],
// widgetId[], widgetPath[] ...
function configForm (n, extra) {
  const widgetId = []
  const widgetPath = []
  for (let i = 0; i < n; i++) { widgetId.push(`f${i}`); widgetPath.push(`environment.form.v${i}`) }
  return Object.assign({ screenId: ['dash'], screenType: ['grid'], widgetId, widgetPath, widgetType: widgetId.map(() => 'numeric'), tileWidget: widgetId.slice(), tileScreen: widgetId.map(() => 'dash') }, extra || {})
}

test('config form: plain save, save-send and save-send-preset are checked before storing', needsBuild, async () => {
  const { manager, round } = bench()
  const get = routes(manager)
  const post = (body) => call(get('POST', '/ui/devices/:id/config'), { id: round }, body)
  const overrides = JSON.stringify(manager.getDevice(round).overrides)
  for (const action of ['save', 'save-send']) {
    const r = await post(configForm(6, { action }))
    assert.strictEqual(r.status, 422, `${action}: ${JSON.stringify(r.json)}`)
    assert.strictEqual(JSON.stringify(manager.getDevice(round).overrides), overrides, `${action}: nothing stored`)
  }
  assert.strictEqual(reloads(manager, round), 0)
  const p = await post(configForm(6, { action: 'save-send-preset', presetName: 'six-form' }))
  assert.strictEqual(p.status, 422, JSON.stringify(p.json))
  assert.strictEqual(manager.store.profiles.profiles['six-form'], undefined, 'no preset stored')
  // Within the round display's 4 tiles: stored and sent.
  const ok = await post(configForm(3, { action: 'save-send' }))
  assert.strictEqual(ok.status, 303, JSON.stringify(ok.json))
  assert.strictEqual(reloads(manager, round), 1)
})

test('config form: saving as a preset checks the other displays on that preset', needsBuild, async () => {
  const { manager, square, round } = bench()
  manager.assignProfile(round, { profileId: 'three' })
  const r = await call(routes(manager)('POST', '/ui/devices/:id/config'), { id: square }, configForm(6, { action: 'save-preset', presetId: 'three' }))
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(r.json.error.details.deviceId, round)
})

test('config form: re-sending an unchanged, already-invalid layout goes through with a warning', needsBuild, async () => {
  const { manager, round } = bench()
  const get = routes(manager)
  // Stored without validation.
  manager.getDevice(round).overrides = require('../index')._test.configOverridesFromForm(configForm(6))
  const r = await call(get('POST', '/ui/devices/:id/config'), { id: round }, configForm(6, { action: 'save-send' }))
  assert.strictEqual(r.status, 303, JSON.stringify(r.json))
  assert.strictEqual(reloads(manager, round), 1)
})

test('without the validator built in, a tile-count fallback still runs and every response says unavailable', async () => {
  const real = midlLib.validateMidl
  const realWarn = console.warn
  const warnings = []
  midlLib.validateMidl = () => {
    const e = new Error(`Cannot find module '${path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs')}'`)
    e.code = 'MODULE_NOT_FOUND'
    throw e
  }
  console.warn = (m) => warnings.push(m)
  try {
    const { manager, square, round } = bench()
    const get = routes(manager)
    // Over capacity on round-360 (4): caught by the fallback.
    const r = await call(get('POST', '/devices/:id/profile'), { id: round }, { profileId: 'six' })
    assert.strictEqual(r.status, 422, JSON.stringify(r.json))
    assert.deepStrictEqual(r.json.error.details.issues.map((i) => i.message), ['too many tiles: 6 > 4'])
    // Within capacity: allowed, flagged.
    const ok = await call(get('POST', '/devices/:id/profile'), { id: round }, { profileId: 'three' })
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json))
    assert.strictEqual(ok.json.layoutValidation.validation, 'unavailable')
    assert.strictEqual(ok.json.layoutValidation.devices[0].unavailable, true)
    const prof = await call(get('POST', '/profiles'), {}, tilesProfile('three', 4))
    assert.strictEqual(prof.json.layoutValidation.validation, 'unavailable')
    const patch = await call(get('PATCH', '/devices/:id'), { id: square }, { assignedProfile: 'six' })
    assert.strictEqual(patch.json.layoutValidation.validation, 'unavailable')
    const cmd = await call(get('POST', '/devices/:id/command'), { id: round }, { type: 'config.reload' })
    assert.strictEqual(cmd.json.layoutValidation.validation, 'unavailable')
    // Structural checks do not need the validator.
    const b = await call(get('POST', '/devices/:id/profile'), { id: round }, { profileId: 'broken' })
    assert.strictEqual(b.status, 422)
    // The missing validator is logged once per process, not per check.
    assert.ok(warnings.filter((m) => /midl validator/.test(m)).length <= 1, JSON.stringify(warnings))
  } finally {
    midlLib.validateMidl = real
    console.warn = realWarn
  }
})

// Form routes carry a non-ok validation in the redirect (&validation=...) and
// the device page shows it as a warning banner.
function callForm (route, params, body, query) {
  return new Promise((resolve, reject) => {
    const headers = {}
    const res = {
      statusCode: 200,
      setHeader (k, v) { headers[k.toLowerCase()] = v },
      status (c) { this.statusCode = c; return this },
      redirect (c, l) { this.statusCode = c; headers.location = l; resolve({ status: c, headers }) },
      json (b) { resolve({ status: this.statusCode, json: b, headers }) },
      end (b) { resolve({ status: this.statusCode, body: b, headers }) }
    }
    Promise.resolve(route.h({ method: 'POST', params, query: query || {}, headers: {}, body: body || {}, get: () => '' }, res)).catch(reject)
  })
}

test('switch-view carries the validation in its redirect and the device page shows a banner', needsBuild, async () => {
  const { manager, round } = bench()
  manager.getDevice(round).assignedProfile = 'six' // over capacity on round-360, stored raw
  const get = routes(manager)
  const r = await callForm(get('POST', '/ui/devices/:id/switch-view'), { id: round }, { profileId: 'six' })
  assert.strictEqual(r.status, 303, JSON.stringify(r))
  assert.match(r.headers.location, /\?status=[^&]+&validation=issues$/)
  // A clean switch adds nothing.
  const clean = await callForm(get('POST', '/ui/devices/:id/switch-view'), { id: round }, { profileId: 'three' })
  assert.doesNotMatch(clean.headers.location, /validation=/)

  const page = (query) => callForm(get('GET', '/ui/devices/:id'), { id: round }, {}, query).then((x) => x.body)
  assert.match(await page({ validation: 'issues' }), /class="panel validation-banner" role="alert"[^>]*><b>Layout warning\.<\/b> Saved, but this layout already fails MIDL validation/)
  assert.match(await page({ validation: 'unavailable' }), /validation-banner[\s\S]*MIDL validator is not available/)
  assert.doesNotMatch(await page({}), /validation-banner/)
  assert.doesNotMatch(await page({ validation: '<b>x</b>' }), /validation-banner|<b>x<\/b>/)
  for (const v of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.doesNotMatch(await page({ validation: v }), /validation-banner/, v)
  }
})

test('applyProfile returns the layout validation at the top level', needsBuild, () => {
  const { manager, round } = bench()
  manager.getDevice(round).assignedProfile = 'six'
  const out = manager.applyProfile('six', { deviceIds: [round] })
  assert.strictEqual(out.count, 1)
  assert.strictEqual(out.layoutValidation.validation, 'issues')
  assert.strictEqual(manager.applyProfile('three', { deviceIds: [round] }).layoutValidation.validation, 'ok')
})
