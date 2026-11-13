'use strict'
// Validator on push: before the manager pushes a layout to a display it
// translates the dashboard the display would be sent to MIDL and runs midl's
// validator for the display's class; a layout the device would reject is a
// 422 `layout_invalid` with the issues, and nothing changes.
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

// A profile with one screen of `n` numeric tiles.
function tilesProfile (id, n) {
  const items = {}
  const tiles = []
  for (let i = 0; i < n; i++) {
    items[`w${i}`] = { type: 'numeric', path: `environment.test.v${i}` }
    tiles.push({ widget: `w${i}` })
  }
  return { id, name: id, config: { layout: { version: 1, screens: [{ id: 'dash', type: 'grid', tiles }] }, widgets: { version: 1, items } } }
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
  assert.match(r.json.error.message, /round-360/)
  assert.strictEqual(manager.getDevice(round).assignedProfile, before, 'assignment unchanged')
  assert.strictEqual(reloads(manager, round), 0, 'no config.reload queued')
})

test('a valid layout is assigned and pushed, with its validation', needsBuild, async () => {
  const { manager, square } = bench()
  const r = await call(routes(manager)('POST', '/devices/:id/profile'), { id: square }, { profileId: 'six', sendReload: true })
  assert.strictEqual(r.status, 200, JSON.stringify(r.json))
  assert.strictEqual(r.json.layoutValidation.ok, true)
  assert.strictEqual(r.json.layoutValidation.className, 'square-480')
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

test('an explicit config.reload (device or group) refuses an invalid stored layout', needsBuild, async () => {
  const { manager, square, round } = bench()
  // Stored without validation (e.g. an older manager), then pushed.
  manager.getDevice(round).assignedProfile = 'six'
  const get = routes(manager)
  const r = await call(get('POST', '/devices/:id/command'), { id: round }, { type: 'config.reload' })
  assert.strictEqual(r.status, 422, JSON.stringify(r.json))
  assert.strictEqual(reloads(manager, round), 0)
  const g = await call(get('POST', '/groups/:groupId/command'), { groupId: 'helm' }, { type: 'config.reload' })
  assert.strictEqual(g.status, 422, JSON.stringify(g.json))
  assert.strictEqual(reloads(manager, square), 0, 'no display in the group was sent a reload')
  // Other commands are not affected.
  const s = await call(get('POST', '/devices/:id/command'), { id: round }, { type: 'screen.set', payload: { screen: 'dash' } })
  assert.strictEqual(s.status, 200, JSON.stringify(s.json))
  const ok = await call(get('POST', '/devices/:id/command'), { id: square }, { type: 'config.reload' })
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json))
})

test('an empty layout is not checked (the display shows its built-in dashboard)', () => {
  const { manager, square } = bench()
  const r = manager.checkDeviceLayout(square, { profileId: 'default' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.skipped, 'no screens')
})

test('only issues a change introduces are refused when the replaced layout is already invalid', needsBuild, () => {
  const { manager, round } = bench()
  const before = manager.checkDeviceLayout(round, { profileId: 'six' })
  assert.strictEqual(before.ok, false)
  // Same issues as before: allowed (an invalid layout can be edited towards valid).
  assert.doesNotThrow(() => manager.requireValidDeviceLayout(round, { profileId: 'six' }, before))
  // A new issue: refused, and only the new issue is reported.
  assert.throws(() => manager.requireValidDeviceLayout(round, { profileId: 'broken' }, before),
    (e) => e.status === 422 && e.payload.error.details.issues.every((i) => !before.issues.some((b) => b.path === i.path && b.message === i.message)))
})

test('without the validator built in, a push proceeds flagged unavailable', async () => {
  const real = midlLib.validateMidl
  midlLib.validateMidl = () => {
    const e = new Error(`Cannot find module '${path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs')}'`)
    e.code = 'MODULE_NOT_FOUND'
    throw e
  }
  try {
    const { manager, round } = bench()
    const r = await call(routes(manager)('POST', '/devices/:id/profile'), { id: round }, { profileId: 'six' })
    assert.strictEqual(r.status, 200, JSON.stringify(r.json))
    assert.strictEqual(r.json.layoutValidation.unavailable, true)
    // Structural checks do not need the validator.
    const b = await call(routes(manager)('POST', '/devices/:id/profile'), { id: round }, { profileId: 'broken' })
    assert.strictEqual(b.status, 422)
  } finally {
    midlLib.validateMidl = real
  }
})
