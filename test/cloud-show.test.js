'use strict'
// Display Manager's in-process API for the yey connector (provisioning
// contract v1 section 2, lib/cloud-show.js): listDisplays() and
// showDashboard() under globalThis[Symbol.for('yey-boats.display-manager')],
// and the yey.boats import that never piles up -N copies of one dashboard (#85).
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')
const makePlugin = require('..')
const plugin = makePlugin
const cloudShow = require('../lib/cloud-show')
const { makeManager, makeSecureManager } = require('./test-utils')
const { MockFirmware } = require('./mock-firmware')

const needsBuild = { skip: !fs.existsSync(path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs')) && 'midl not built' }
const KEY = Symbol.for('yey-boats.display-manager')

function midlDoc (title, n, screenIds) {
  const elements = {}
  const cells = []
  for (let i = 0; i < n; i++) {
    elements[`e${i}`] = { type: 'single-value', name: `V${i}`, bindings: { value: { kind: 'signalk', path: 'navigation.speedOverGround' } } }
    cells.push({ element: `e${i}` })
  }
  return {
    midl: '1.0.0',
    meta: { title },
    screens: (screenIds || ['dash']).map((id) => ({ id, title: `${title} ${id}`, elements, layout: { rows: 1, cols: n, cells } }))
  }
}

function api (manager) {
  return cloudShow.createApi(() => manager, plugin._test.displayApiDeps())
}

// A pushable square display (online, reachable, holds its device token) as in
// test/midl-records.test.js, plus optional more displays.
function rig () {
  const { manager } = makeSecureManager({ midl: { push: true } })
  const token = manager.apiToken.pendingReveal()
  const reg = manager.registerDevice({ device: { id: 'yey-d-helm', name: 'Helm display', display: { width: 480, height: 480 } } }, { bearer: token })
  const auth = { bearer: reg.deviceToken }
  const fw = new MockFirmware(manager, { deviceId: 'yey-d-helm', auth, managerToken: reg.deviceToken })
  manager._deviceHttpRequest = (url, method, text, a) => fw.http(url, method, text, a)
  manager.updateStatus('yey-d-helm', { network: { ip: '10.9.8.7' }, ui: { screen: 'wind' }, midl: { version: '1.0.0', class: 'square-480', records: [] } }, auth)
  const add = (id, display, online) => {
    const r = manager.registerDevice({ device: { id, display } }, { bearer: token })
    if (online) manager.updateStatus(id, { network: { ip: '10.9.8.8' }, midl: { version: '1.0.0', records: [] } }, { bearer: r.deviceToken })
    else manager.store.registry.devices[id].lastSeen = '2026-01-01T00:00:00.000Z' // last heard long ago
    return r
  }
  return { manager, fw, auth, add }
}

test('the API is published process-wide on start and removed on stop', () => {
  const { manager } = makeManager()
  const dataDir = manager.store.dataDir
  manager.close()
  delete globalThis[KEY]
  const p = makePlugin({ getDataDirPath: () => dataDir, debug: () => {}, handleMessage: () => {} })
  p.start({ discoveryUdp: { enabled: false }, deviceDiscoveryUdp: { enabled: false }, firmware: { github: { enabled: false } }, network: { mdns: { browser: false, advertiseManager: false } } })
  try {
    const a = globalThis[KEY]
    assert.ok(a, 'registered on start')
    assert.strictEqual(a.version, 1)
    assert.strictEqual(typeof a.listDisplays, 'function')
    assert.strictEqual(typeof a.showDashboard, 'function')
    assert.ok(Object.isFrozen(a))
  } finally {
    p.stop()
  }
  assert.strictEqual(globalThis[KEY], undefined, 'removed on stop')
  // A stop does not remove an API a newer instance registered.
  const other = { version: 1 }
  globalThis[KEY] = other
  p.stop()
  assert.strictEqual(globalThis[KEY], other)
  delete globalThis[KEY]
})

test('a stopped plugin answers unavailable', async () => {
  const a = cloudShow.createApi(() => undefined, plugin._test.displayApiDeps())
  await assert.rejects(a.listDisplays(), (e) => e.code === 'unavailable')
  await assert.rejects(a.showDashboard({ sourceId: 'x', displayIds: ['y'], doc: midlDoc('X', 1) }), (e) => e.code === 'unavailable')
})

test('listDisplays: id, name, class, online, current screen, preset', needsBuild, async () => {
  const { manager, add } = rig()
  try {
    add('yey-d-round', { width: 360, height: 360, shape: 'round' }, false)
    const list = await api(manager).listDisplays()
    assert.deepStrictEqual(list.map((d) => d.id), ['yey-d-helm', 'yey-d-round'])
    const helm = list[0]
    assert.deepStrictEqual(Object.keys(helm).sort(), ['class', 'id', 'name', 'online', 'preset', 'screen'])
    assert.strictEqual(helm.name, 'Helm display')
    assert.strictEqual(helm.class, 'square-480')
    assert.strictEqual(helm.online, true)
    assert.strictEqual(helm.screen.id, 'wind')
    assert.strictEqual(typeof helm.screen.title, 'string')
    assert.ok('record' in helm.screen)
    assert.strictEqual(helm.preset.id, 'default')
    const round = list[1]
    assert.ok(typeof round.name === 'string' && round.name)
    assert.strictEqual(round.class, 'round-360')
    assert.strictEqual(round.online, false)
    assert.strictEqual(round.screen, null)
  } finally {
    manager.close()
  }
})

test('showDashboard: imports the preset, assigns it and shows the screen on the display', needsBuild, async () => {
  const { manager, fw } = rig()
  try {
    const doc = midlDoc('Wind history', 2, ['dash', 'more'])
    const r = await api(manager).showDashboard({
      sourceId: 'cloud-1', title: 'Wind history', updatedAt: '2026-11-16T10:00:00Z', doc, screen: 'more', displayIds: ['yey-d-helm'], requestedBy: 'the boat\'s owner (Google account)'
    })
    assert.deepStrictEqual(r, {
      preset: { id: 'yey-wind-history', name: 'Wind history', created: true },
      results: [{ display_id: 'yey-d-helm', state: 'shown', screen: 'more' }]
    })
    const p = manager.store.profiles.profiles['yey-wind-history']
    assert.strictEqual(p.source, 'yey.boats')
    assert.strictEqual(p.sourceId, 'cloud-1')
    assert.strictEqual(p.sourceUpdatedAt, '2026-11-16T10:00:00Z')
    assert.strictEqual(p.shownBy, 'the boat\'s owner (Google account)')
    assert.ok(p.shownAt)
    assert.strictEqual(manager.getDevice('yey-d-helm').assignedProfile, 'yey-wind-history')
    // Pushed and activated on the display, on the requested screen.
    const rec = p.midl.records[0]
    assert.ok(fw.httpLog.some((l) => l.method === 'PUT' && l.path === `/api/midl/records/${rec.id}?activate=1&screen=more`), JSON.stringify(fw.httpLog.map((l) => l.path)))
    assert.strictEqual(fw.screen, 'more')
    assert.strictEqual(JSON.stringify(fw.records.get(rec.id).doc), JSON.stringify(doc))
    // The preset and device pages say where it came from.
    const page = plugin._test.renderUi(manager, 'preset', { params: { id: 'yey-wind-history' }, query: {}, headers: {} })
    assert.match(page, /from yey\.boats, shown by the boat&#39;s owner|from yey\.boats, shown by the boat's owner/)
    // No screen given: the doc's first screen.
    fw.httpLog.length = 0
    const again = await api(manager).showDashboard({ sourceId: 'cloud-1', doc, displayIds: 'all', requestedBy: 'owner' })
    assert.deepStrictEqual(again.results, [{ display_id: 'yey-d-helm', state: 'shown', screen: 'dash' }])
    assert.strictEqual(fw.screen, 'dash')
  } finally {
    manager.close()
  }
})

test('showDashboard is audited as cloud.dashboard.shown', needsBuild, async () => {
  const { manager } = rig()
  try {
    const seen = []
    const orig = manager.store.audit.bind(manager.store)
    manager.store.audit = (type, subject, data) => { seen.push({ type, subject, data }); return orig(type, subject, data) }
    await api(manager).showDashboard({ sourceId: 'cloud-a', title: 'A', doc: midlDoc('A', 1), displayIds: ['yey-d-helm', 'nope'], requestedBy: 'owner' })
    const e = seen.find((x) => x.type === 'cloud.dashboard.shown')
    assert.ok(e)
    assert.deepStrictEqual(e.data, {
      sourceId: 'cloud-a', presetId: 'yey-a', requestedBy: 'owner',
      displays: [{ id: 'yey-d-helm', state: 'shown' }, { id: 'nope', state: 'unknown_display' }]
    })
  } finally {
    manager.close()
  }
})

test('the same sourceId twice updates the same preset, never a -2 copy', needsBuild, async () => {
  const { manager } = rig()
  try {
    const a = api(manager)
    const one = await a.showDashboard({ sourceId: 'cloud-1', title: 'Wind history', doc: midlDoc('Wind history', 1), displayIds: ['yey-d-helm'] })
    const before = Object.keys(manager.store.profiles.profiles).length
    const two = await a.showDashboard({ sourceId: 'cloud-1', title: 'Wind history', doc: midlDoc('Wind history', 3), displayIds: ['yey-d-helm'] })
    assert.strictEqual(two.preset.id, one.preset.id)
    assert.strictEqual(two.preset.created, false)
    assert.strictEqual(Object.keys(manager.store.profiles.profiles).length, before)
    const p = manager.store.profiles.profiles[one.preset.id]
    assert.strictEqual(p.midl.records.length, 1)
    assert.strictEqual(Object.keys(p.midl.records[0].doc.screens[0].elements).length, 3)
    assert.strictEqual(p.version, 2)
  } finally {
    manager.close()
  }
})

// #85, the bench's yey-wind-history -2 ... -5: a save that rebuilds the
// preset (device page "save as preset", the MIDL editor, POST /profiles)
// dropped its yey.boats origin, so the next import did not find it.
test('#85: a preset saved without its origin is still found by the next import', needsBuild, async () => {
  const { manager } = rig()
  try {
    const a = api(manager)
    const first = await a.showDashboard({ sourceId: 'cloud-1', title: 'Wind history', doc: midlDoc('Wind history', 1), displayIds: ['yey-d-helm'] })
    const id = first.preset.id
    // What the device page's "save as preset" and POST /profiles store.
    const p = manager.store.profiles.profiles[id]
    manager.upsertProfile({ id, name: p.name, version: p.version + 1, config: p.config, midl: p.midl })
    assert.strictEqual(manager.store.profiles.profiles[id].sourceId, 'cloud-1', 'the origin is kept')
    // The MIDL editor rewrites the record (source: editor): it keeps its sourceId.
    const midlRecords = require('../lib/midl-records')
    const rec = p.midl.records[0]
    const midl = midlRecords.upsertRecord(manager.store.profiles.profiles[id].midl, { id: rec.id, title: rec.title, doc: rec.doc, source: 'editor' })
    assert.strictEqual(midl.records[0].sourceId, 'cloud-1')

    // Re-import (the UI's Import and showDashboard share the path).
    const again = plugin._test.importCloudDoc(manager, { id: 'cloud-1', title: 'Wind history', doc: midlDoc('Wind history', 2) })
    assert.strictEqual(again.id, id)
    assert.strictEqual(again.updated, true)

    // A preset stored by an older version (origin already dropped) is found
    // by the record it holds, and gets its origin back.
    const stripped = Object.assign({}, manager.store.profiles.profiles[id])
    for (const k of ['source', 'sourceId', 'sourceUpdatedAt', 'sourceTargetClass', 'importedAt', 'shownBy', 'shownAt']) delete stripped[k]
    manager.store.profiles.profiles[id] = stripped
    const before = Object.keys(manager.store.profiles.profiles).length
    const third = await a.showDashboard({ sourceId: 'cloud-1', title: 'Wind history', doc: midlDoc('Wind history', 1), displayIds: ['yey-d-helm'] })
    assert.strictEqual(third.preset.id, id)
    assert.strictEqual(third.preset.created, false)
    assert.strictEqual(Object.keys(manager.store.profiles.profiles).length, before)
    assert.strictEqual(manager.store.profiles.profiles[id].sourceId, 'cloud-1')
  } finally {
    manager.close()
  }
})

test('the device page "save as preset" keeps the yey.boats origin (#85)', needsBuild, async () => {
  const { manager } = rig()
  try {
    const first = await api(manager).showDashboard({ sourceId: 'cloud-1', title: 'Wind history', doc: midlDoc('Wind history', 1), displayIds: ['yey-d-helm'] })
    const route = []
    const add = (method) => (p, ...h) => route.push({ method, p, h: h[h.length - 1] })
    plugin._test.registerRoutes({ use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }, () => manager)
    // POST /profiles with the preset rebuilt by a client that knows nothing of its origin.
    const r = route.find((x) => x.method === 'POST' && x.p === '/profiles')
    const p = manager.store.profiles.profiles[first.preset.id]
    await new Promise((resolve, reject) => {
      const res = { statusCode: 200, setHeader () {}, status (c) { this.statusCode = c; return this }, json: resolve, end: resolve }
      Promise.resolve(r.h({ method: 'POST', params: {}, query: {}, headers: {}, body: { id: p.id, name: p.name, config: p.config, midl: p.midl }, socket: { remoteAddress: '127.0.0.1' }, get: () => '' }, res)).catch(reject)
    })
    assert.strictEqual(manager.store.profiles.profiles[p.id].source, 'yey.boats')
    const again = await api(manager).showDashboard({ sourceId: 'cloud-1', title: 'Wind history', doc: midlDoc('Wind history', 2), displayIds: ['yey-d-helm'] })
    assert.strictEqual(again.preset.id, first.preset.id)
  } finally {
    manager.close()
  }
})

test('an invalid doc is invalid_dashboard and nothing is stored or assigned', needsBuild, async () => {
  const { manager } = rig()
  try {
    const a = api(manager)
    const before = Object.keys(manager.store.profiles.profiles).length
    await assert.rejects(a.showDashboard({ sourceId: 'x', doc: { hello: 'world' }, displayIds: ['yey-d-helm'] }), (e) => e.code === 'invalid_dashboard')
    await assert.rejects(a.showDashboard({ sourceId: 'x', doc: '{not json', displayIds: ['yey-d-helm'] }), (e) => e.code === 'invalid_dashboard')
    const bad = midlDoc('Bad', 1)
    bad.screens[0].elements.e0.type = 'nonsense'
    await assert.rejects(a.showDashboard({ sourceId: 'x', doc: bad, displayIds: ['yey-d-helm'] }),
      (e) => e.code === 'invalid_dashboard' && /nonsense/.test(e.message))
    await assert.rejects(a.showDashboard({ sourceId: 'x', doc: midlDoc('Ok', 1), screen: 'missing', displayIds: ['yey-d-helm'] }),
      (e) => e.code === 'invalid_dashboard' && /missing/.test(e.message))
    await assert.rejects(a.showDashboard({ doc: midlDoc('Ok', 1), displayIds: ['yey-d-helm'] }), (e) => e.code === 'bad_request')
    await assert.rejects(a.showDashboard({ sourceId: 'x', doc: midlDoc('Ok', 1), displayIds: [] }), (e) => e.code === 'bad_request')
    assert.strictEqual(Object.keys(manager.store.profiles.profiles).length, before)
    assert.strictEqual(manager.getDevice('yey-d-helm').assignedProfile || 'default', 'default')
  } finally {
    manager.close()
  }
})

test('a display whose class refuses the doc is refused (nothing assigned); the others get it', needsBuild, async () => {
  const { manager, add } = rig()
  try {
    add('yey-d-round', { width: 360, height: 360, shape: 'round' }, true)
    // Six tiles: fine on square-480, too many for round-360.
    const r = await api(manager).showDashboard({ sourceId: 'six', title: 'Six', doc: midlDoc('Six', 6), displayIds: ['yey-d-round', 'yey-d-helm'] })
    assert.strictEqual(r.results[0].display_id, 'yey-d-round')
    assert.strictEqual(r.results[0].state, 'refused')
    assert.match(r.results[0].error, /round-360.*too many tiles/)
    assert.deepStrictEqual(r.results[1], { display_id: 'yey-d-helm', state: 'shown', screen: 'dash' })
    assert.strictEqual(manager.getDevice('yey-d-round').assignedProfile || 'default', 'default')
    assert.strictEqual(manager.getDevice('yey-d-helm').assignedProfile, r.preset.id)
    // Refused by every target, but valid for its own class: the preset is
    // still stored, nothing assigned.
    const only = await api(manager).showDashboard({ sourceId: 'six', doc: midlDoc('Six', 6), displayIds: ['yey-d-round'] })
    assert.strictEqual(only.results[0].state, 'refused')
  } finally {
    manager.close()
  }
})

test('an offline display is queued (pull fallback), an unknown id is unknown_display', needsBuild, async () => {
  const { manager, add } = rig()
  try {
    add('yey-d-cabin', { width: 480, height: 480 }, false)
    const r = await api(manager).showDashboard({ sourceId: 'q', title: 'Q', doc: midlDoc('Q', 1), displayIds: ['yey-d-cabin', 'yey-d-ghost', 'yey-d-cabin'] })
    assert.deepStrictEqual(r.results, [
      { display_id: 'yey-d-cabin', state: 'queued', screen: 'dash' },
      { display_id: 'yey-d-ghost', state: 'unknown_display' }
    ])
    assert.strictEqual(manager.getDevice('yey-d-cabin').assignedProfile, r.preset.id)
    const cmds = manager.pendingCommands('yey-d-cabin').map((c) => c.type)
    assert.ok(cmds.includes('config.reload'), JSON.stringify(cmds))
    assert.ok(cmds.includes('screen.set'), 'it switches to the screen once it pulls')
  } finally {
    manager.close()
  }
})

test('a display that refuses the pushed record (422) is refused with its message', needsBuild, async () => {
  const { manager, fw } = rig()
  try {
    const orig = fw.http.bind(fw)
    fw.http = (url, method, text, a) => method === 'PUT' && url.includes('/records/')
      ? Promise.reject(Object.assign(new Error('422'), { status: 422, payload: { error: { details: { body: { error: 'invalid', message: '/screens/0 not on this display' } } } } }))
      : orig(url, method, text, a)
    const r = await api(manager).showDashboard({ sourceId: 'z', title: 'Z', doc: midlDoc('Z', 1), displayIds: ['yey-d-helm'] })
    assert.strictEqual(r.results[0].state, 'refused')
    assert.match(r.results[0].error, /not on this display/)
  } finally {
    manager.close()
  }
})
