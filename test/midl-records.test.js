'use strict'
// MIDL-only screens (contract 2026-11-15): DM stores MIDL records per
// profile and delivers them by push (device HTTP) with pull as the fallback.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const plugin = require('..')
const { YeyBoatsDisplayManager } = require('../lib/manager')
const midlRecords = require('../lib/midl-records')
const { makeManager, makeSecureManager, mergeTestOptions } = require('./test-utils')
const { MockFirmware } = require('./mock-firmware')

const needsBuild = { skip: !fs.existsSync(path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs')) && 'midl not built' }

function routes (manager) {
  const list = []
  const add = (method) => (p, ...h) => list.push({ method, p, h: h[h.length - 1] })
  const router = { use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }
  plugin._test.registerRoutes(router, () => manager)
  return (method, p) => {
    const r = list.find((x) => x.method === method && x.p === p)
    assert.ok(r, `${method} ${p} registered`)
    return r
  }
}

function call (route, { method = 'GET', params = {}, query = {}, headers = {}, body = {} } = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader (k, v) { this.headers[k.toLowerCase()] = v },
      status (c) { this.statusCode = c; return this },
      json (b) { resolve({ status: this.statusCode, json: b, headers: this.headers }) },
      end (b) { resolve({ status: this.statusCode, body: b, headers: this.headers }) }
    }
    const req = { method, params, query, headers: lower, body, socket: { remoteAddress: '127.0.0.1' }, get: (k) => lower[String(k).toLowerCase()] || '' }
    Promise.resolve(route.h(req, res)).catch(reject)
  })
}

// A doc the v2 model could never hold: a spanning cell, a windrose with
// sectors and markers, a nested layout, format.decimals.
const SPAN_DOC_TEXT = JSON.stringify({
  midl: '1.0.0',
  meta: { title: 'Passage' },
  screens: [{
    id: 'passage',
    title: 'Passage',
    elements: {
      rose: {
        type: 'windrose',
        name: 'AWS',
        bindings: { value: { kind: 'signalk', path: 'environment.wind.speedApparent' }, dir: { kind: 'signalk', path: 'environment.wind.angleApparent' } },
        format: { unit: 'kn', decimals: 1 },
        style: { sectors: [{ from: -30, to: 0, color: 'port' }, { from: 0, to: 30, color: 'starboard' }] },
        markers: [{ id: 'TWA', glyph: 'diamond', color: 'accent', dir: { kind: 'signalk', path: 'environment.wind.angleTrueWater' } }]
      },
      sog: { type: 'single-value', name: 'SOG', bindings: { value: { kind: 'signalk', path: 'navigation.speedOverGround' } }, format: { unit: 'kn', decimals: 1 } },
      depth: { type: 'single-value', name: 'DEPTH', bindings: { value: { kind: 'signalk', path: 'environment.depth.belowTransducer' } } }
    },
    layout: { rows: 2, cols: 2, cells: [{ element: 'rose', colSpan: 2 }, { element: 'sog' }, { element: 'depth' }] }
  }]
})

const sha = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`

test('built-in records come from midl/library/builtin, one screen each, for both class families', () => {
  const b = midlRecords.loadBuiltins()
  for (const id of midlRecords.ALL_BUILTINS) {
    assert.ok(b.has(id), `built-in ${id}`)
    assert.deepStrictEqual(b.get(id).doc.screens.map((s) => s.id), [id])
  }
  assert.deepStrictEqual(midlRecords.screenList(null, 'square-480').map((s) => s.id), midlRecords.RECT_BUILTINS)
  assert.deepStrictEqual(midlRecords.screenList(null, 'round-360').map((s) => s.id), midlRecords.ROUND_BUILTINS)
})

test('migration: stored v2 profiles become MIDL records at load, with a backup', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-midl-migrate-'))
  // The screens the removed v2 presets seeded for sunton-480.
  const seeded = require('./fixtures/v2-preset-screens.json').slice(0, 11)
  const v2 = {
    profiles: {
      default: { id: 'default', name: 'Default', version: 3, config: { settings: { defaultScreen: 'dashboard' }, layout: { version: 1, screens: seeded } } },
      helm: {
        id: 'helm',
        name: 'Helm',
        version: 2,
        config: {
          settings: { defaultScreen: 'speed', theme: 'night' },
          widgets: { items: { sog: { type: 'numeric', title: 'SOG', path: 'navigation.speedOverGround' }, hdg: { type: 'compass', title: 'HDG', path: 'navigation.headingTrue' } } },
          layout: { screens: [{ id: 'speed', title: 'Speed', tiles: [{ widget: 'sog' }, { widget: 'hdg' }] }, seeded[1]] }
        }
      }
    }
  }
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(v2))
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify({ devices: { 'yey-d-1': { id: 'yey-d-1', assignedProfile: 'helm', overrides: { layout: { screens: [] }, settings: { brightness: 0.5 } } } } }))
  const app = { getDataDirPath: () => dataDir, debug: () => {} }
  const opts = mergeTestOptions({ auth: { mode: 'dev-shared-token', devAuth: true }, discoveryUdp: { enabled: false }, deviceDiscoveryUdp: { enabled: false }, firmware: { github: { enabled: false } }, network: { mdns: { browser: false, advertiseManager: false } }, midl: { push: false } }, {})
  const manager = new YeyBoatsDisplayManager(app, opts)
  try {
    const def = manager.store.profiles.profiles.default
    assert.strictEqual(def.config.layout, undefined)
    assert.deepStrictEqual(def.midl.records, [], 'the seeded presets are the built-ins: nothing migrated')
    assert.strictEqual(def.config.settings.defaultScreen, 'dashboard', 'non-screen settings kept')
    const helm = manager.store.profiles.profiles.helm
    assert.strictEqual(helm.config.widgets, undefined)
    assert.deepStrictEqual(helm.midl.records.map((r) => r.id), ['speed'])
    assert.strictEqual(helm.midl.records[0].source, 'migrated')
    const doc = helm.midl.records[0].doc
    assert.deepStrictEqual(Object.values(doc.screens[0].elements).map((e) => e.type), ['single-value', 'compass'])
    assert.strictEqual(helm.midl.index.defaultScreen, 'speed')
    assert.ok(midlRecords.screenList(helm.midl, 'square-480').some((s) => s.id === 'wind'), 'built-ins stay in the carousel')
    assert.ok(require('../lib/midl').checkMidlDoc(doc, 'square-480').ok, 'migrated doc validates')
    // Device overrides lose their v2 keys only.
    const dev = manager.store.registry.devices['yey-d-1']
    assert.deepStrictEqual(dev.overrides, { settings: { brightness: 0.5 } })
    // Backups of the files as they were.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.v2-backup.json'), 'utf8')), v2)
    assert.ok(fs.existsSync(path.join(dataDir, 'registry.v2-backup.json')))
    // Generated config: the midl block, no v2 keys.
    const cfg = manager.generateConfig('yey-d-1')
    assert.strictEqual(cfg.layout, undefined)
    assert.strictEqual(cfg.widgets, undefined)
    assert.deepStrictEqual(cfg.midl.records.map((r) => r.id), ['speed'])
    assert.strictEqual(cfg.midl.index.defaultScreen, 'speed')
  } finally {
    manager.close()
  }
  // A second load changes nothing and keeps the first backup.
  const backup = fs.readFileSync(path.join(dataDir, 'profiles.v2-backup.json'), 'utf8')
  const before = fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8')
  const again = new YeyBoatsDisplayManager(app, opts)
  try {
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'), before)
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'profiles.v2-backup.json'), 'utf8'), backup)
  } finally {
    again.close()
  }
})

test('import keeps the MIDL doc unchanged (spans, windrose) and delivers it byte-identical', needsBuild, async () => {
  const { manager, auth } = makeManager()
  try {
    const r = routes(manager)
    manager.registerDevice({ device: { id: 'yey-d-sq', display: { width: 480, height: 480 } } }, auth)
    const res = await call(r('POST', '/profiles/import-dashboard'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { raw: SPAN_DOC_TEXT } })
    assert.strictEqual(res.status, 200, JSON.stringify(res.json))
    assert.strictEqual(res.json.id, 'passage')
    assert.strictEqual(res.json.midlValidation.ok, true)
    assert.strictEqual(res.json.record.id, 'passage')
    assert.strictEqual(res.json.record.hash, sha(SPAN_DOC_TEXT))
    const profile = manager.store.profiles.profiles.passage
    assert.strictEqual(JSON.stringify(profile.midl.records[0].doc), SPAN_DOC_TEXT, 'stored unchanged')
    assert.ok(profile.config.settings, 'a new preset takes the default non-screen settings')
    manager.assignProfile('yey-d-sq', { profileId: 'passage' })
    const cfg = manager.generateConfig('yey-d-sq')
    assert.deepStrictEqual(cfg.midl.records, [{ id: 'passage', title: 'Passage', hash: sha(SPAN_DOC_TEXT), url: '/devices/yey-d-sq/midl/records/passage' }])
    assert.strictEqual(cfg.midl.index.order[0], 'passage')
    assert.strictEqual(cfg.midl.index.defaultScreen, 'passage')
    const rec = await call(r('GET', '/devices/:id/midl/records/:rid'), { params: { id: 'yey-d-sq', rid: 'passage' }, headers: { authorization: 'Bearer yeyboats-dev' } })
    assert.strictEqual(rec.status, 200)
    assert.strictEqual(JSON.stringify(rec.json.doc), SPAN_DOC_TEXT, 'served byte-identical')
    assert.strictEqual(rec.json.hash, sha(SPAN_DOC_TEXT))
    assert.strictEqual(rec.json.source, 'manager')
    // A pull-only display ends up with exactly those bytes.
    const fw = new MockFirmware(manager, { deviceId: 'yey-d-sq', auth })
    fw.fetchConfig()
    assert.strictEqual(fw.records.get('passage').docText, SPAN_DOC_TEXT)
    assert.strictEqual(fw.records.get('passage').hash, sha(SPAN_DOC_TEXT))
    // The config hash covers the midl block.
    const h1 = cfg.hash
    const edited = JSON.parse(SPAN_DOC_TEXT)
    edited.screens[0].title = 'Passage 2'
    await call(r('POST', '/profiles/import-dashboard'), { method: 'POST', body: Object.assign(edited, {}) })
    assert.notStrictEqual(manager.generateConfig('yey-d-sq').hash, h1)
    // An invalid doc is refused with the validator's issues.
    const bad = JSON.parse(SPAN_DOC_TEXT)
    bad.screens[0].elements.rose.type = 'no-such-element'
    const refused = await call(r('POST', '/profiles/import-dashboard'), { method: 'POST', body: bad })
    assert.strictEqual(refused.status, 422)
    assert.strictEqual(refused.json.error.code, 'midl_invalid')
  } finally {
    manager.close()
  }
})

test('an imported screen id that collides with a built-in is refused (409) unless it is a one-screen override', needsBuild, async () => {
  const { manager } = makeManager()
  try {
    const r = routes(manager)
    const doc = JSON.parse(SPAN_DOC_TEXT)
    doc.meta.title = 'Two'
    doc.screens.push(Object.assign({}, doc.screens[0], { id: 'wind', title: 'Wind' }))
    const res = await call(r('POST', '/profiles/import-dashboard'), { method: 'POST', body: doc })
    assert.strictEqual(res.status, 409)
    assert.strictEqual(res.json.error.code, 'screen_id_conflict')
    const one = JSON.parse(SPAN_DOC_TEXT)
    one.meta.title = 'My wind'
    one.screens[0].id = 'wind'
    const ok = await call(r('POST', '/profiles/import-dashboard'), { method: 'POST', body: one })
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json))
    assert.strictEqual(ok.json.record.id, 'wind', 'same id = override of the embedded record')
  } finally {
    manager.close()
  }
})

// Bench bug: a profile holding exactly one record (windhist) took an import
// of a different doc (screen windspan) INTO that record, keeping its id.
// The record id follows the document.
const oneScreenDoc = (screenId, title) => {
  const d = JSON.parse(SPAN_DOC_TEXT)
  delete d.meta
  d.screens[0].id = screenId
  d.screens[0].title = title || screenId
  return d
}

test('import: the record id follows the doc, not the single record a profile holds', needsBuild, () => {
  const { manager } = makeManager()
  try {
    const { importDashboardDocument } = plugin._test
    importDashboardDocument(manager, oneScreenDoc('windhist', 'Wind history'), { presetId: 'helm' })
    assert.deepStrictEqual(manager.store.profiles.profiles.helm.midl.records.map((r) => r.id), ['windhist'])
    const out = importDashboardDocument(manager, oneScreenDoc('windspan', 'Wind span'), { presetId: 'helm' })
    assert.strictEqual(out.record.id, 'windspan', 'a one-screen doc is stored under its screen id')
    const recs = manager.store.profiles.profiles.helm.midl.records
    assert.deepStrictEqual(recs.map((r) => r.id).sort(), ['windhist', 'windspan'], 'windhist is kept, not replaced')
    assert.deepStrictEqual(recs.find((r) => r.id === 'windspan').doc.screens.map((sc) => sc.id), ['windspan'])
    assert.deepStrictEqual(recs.find((r) => r.id === 'windhist').doc.screens.map((sc) => sc.id), ['windhist'])
    // The same screens again replace that record (edited content, same id).
    const again = importDashboardDocument(manager, oneScreenDoc('windspan', 'Wind span v2'), { presetId: 'helm' })
    assert.strictEqual(again.record.id, 'windspan')
    const after = manager.store.profiles.profiles.helm.midl.records
    assert.strictEqual(after.length, 2)
    assert.strictEqual(after.find((r) => r.id === 'windspan').doc.screens[0].title, 'Wind span v2')
  } finally {
    manager.close()
  }
})

test('import: a multi-screen doc takes its meta title (else the preset id); matching screens replace the record', needsBuild, () => {
  const { manager } = makeManager()
  try {
    const { importDashboardDocument } = plugin._test
    const two = (title, a, b) => {
      const d = JSON.parse(SPAN_DOC_TEXT)
      if (title) d.meta.title = title
      else delete d.meta
      d.screens = [Object.assign({}, d.screens[0], { id: a }), Object.assign({}, d.screens[0], { id: b })]
      return d
    }
    const first = importDashboardDocument(manager, two('Coastal set', 'coast1', 'coast2'), { presetId: 'trip' })
    assert.strictEqual(first.record.id, 'coastal-set')
    const untitled = importDashboardDocument(manager, two(null, 'off1', 'off2'), { presetId: 'trip' })
    assert.strictEqual(untitled.record.id, 'trip', 'no meta title: the preset id')
    // Same screens under a new title: replaces coastal-set, keeps its id.
    const renamed = importDashboardDocument(manager, two('Coast renamed', 'coast2', 'coast1'), { presetId: 'trip' })
    assert.strictEqual(renamed.record.id, 'coastal-set')
    assert.deepStrictEqual(manager.store.profiles.profiles.trip.midl.records.map((r) => r.id).sort(), ['coastal-set', 'trip'])
    // A derived id already used by a record with other screens is not overwritten.
    const clash = importDashboardDocument(manager, two('Trip', 'x1', 'x2'), { presetId: 'trip' })
    assert.strictEqual(clash.record.id, 'trip-2')
    assert.strictEqual(manager.store.profiles.profiles.trip.midl.records.length, 3)
  } finally {
    manager.close()
  }
})

test('import: the same yey.boats sourceId lands in the same record even when its screens change', needsBuild, () => {
  const { manager } = makeManager()
  try {
    const { importDashboardDocument } = plugin._test
    const extra = { source: 'yey.boats', sourceId: 'cloud-42' }
    const a = importDashboardDocument(manager, oneScreenDoc('ocean'), { presetId: 'yey-ocean', extra })
    importDashboardDocument(manager, oneScreenDoc('other'), { presetId: 'yey-ocean' })
    const b = importDashboardDocument(manager, oneScreenDoc('ocean2'), { presetId: 'yey-ocean', extra })
    assert.strictEqual(a.record.id, 'ocean')
    assert.strictEqual(b.record.id, 'ocean', 'same source, same record')
    const recs = manager.store.profiles.profiles['yey-ocean'].midl.records
    assert.deepStrictEqual(recs.map((r) => r.id).sort(), ['ocean', 'other'])
    assert.deepStrictEqual(recs.find((r) => r.id === 'ocean').doc.screens.map((sc) => sc.id), ['ocean2'])
  } finally {
    manager.close()
  }
})

test('the record route needs the device token (secure mode); records hold no secrets', async () => {
  const { manager } = makeSecureManager()
  try {
    const api = manager.apiToken.pendingReveal()
    const reg = manager.registerDevice({ device: { id: 'yey-d-s' } }, { bearer: api })
    manager.upsertProfile({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'one', doc: JSON.parse(SPAN_DOC_TEXT) }] } })
    manager.assignProfile('yey-d-s', { profileId: 'p' })
    assert.throws(() => manager.deviceRecordFor('yey-d-s', 'one', {}), (e) => e.status === 401)
    assert.throws(() => manager.deviceRecordFor('yey-d-s', 'one', { bearer: 'nope' }), (e) => e.status === 401)
    assert.strictEqual(manager.deviceRecordFor('yey-d-s', 'one', { bearer: reg.deviceToken }).id, 'one')
    assert.strictEqual(manager.deviceRecordFor('yey-d-s', 'one', { bearer: api }).id, 'one', 'operator tools may read')
    assert.throws(() => manager.deviceRecordFor('yey-d-s', 'dashboard', { bearer: reg.deviceToken }), (e) => e.status === 404)
  } finally {
    manager.close()
  }
})

// A display on the network: online, with an address, its push API answered
// by the mock firmware.
function pushRig () {
  const { manager } = makeSecureManager({ midl: { push: true } })
  const api = manager.apiToken.pendingReveal()
  const reg = manager.registerDevice({ device: { id: 'yey-d-push', display: { width: 480, height: 480 } } }, { bearer: api })
  const auth = { bearer: reg.deviceToken }
  const fw = new MockFirmware(manager, { deviceId: 'yey-d-push', auth, managerToken: reg.deviceToken })
  manager._deviceHttpRequest = (url, method, text, a) => fw.http(url, method, text, a)
  // The heartbeat makes it online with an address; DM sees its token.
  manager.updateStatus('yey-d-push', { network: { ip: '10.9.8.7' }, midl: { version: '1.0.0', class: 'square-480', records: [] } }, auth)
  return { manager, fw, auth, token: reg.deviceToken, api }
}

test('push: an assigned profile\'s records + index go to the display with its device token', needsBuild, async () => {
  const { manager, fw, auth, token } = pushRig()
  try {
    const doc = JSON.parse(SPAN_DOC_TEXT)
    manager.upsertProfile({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }], index: { order: ['passage'] } } })
    const cmdsBefore = manager.pendingCommands('yey-d-push').length
    manager.assignProfile('yey-d-push', { profileId: 'p' })
    const [result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'pushed', JSON.stringify(result))
    assert.deepStrictEqual(fw.httpLog.map((l) => `${l.method} ${l.path}`), ['PUT /api/midl/records/passage', 'PUT /api/midl/index'])
    assert.strictEqual(fw.httpLog[0].auth.bearer, token, 'X-YeyBoats-Authorization: Bearer <device token>')
    assert.deepStrictEqual(JSON.parse(fw.httpLog[0].body), { title: 'Passage', doc, hash: sha(SPAN_DOC_TEXT) })
    const stored = fw.records.get('passage')
    assert.strictEqual(stored.source, 'manager')
    assert.strictEqual(stored.docText, SPAN_DOC_TEXT)
    assert.strictEqual(stored.hash, manager.generateConfig('yey-d-push').midl.records[0].hash, 'push and pull agree on the hash')
    assert.strictEqual(fw.index.defaultScreen, 'passage')
    assert.strictEqual(manager.pendingCommands('yey-d-push').length, cmdsBefore, 'nothing queued when the push worked')
    // The display reports it; a later pull fetches nothing.
    manager.updateStatus('yey-d-push', { network: { ip: '10.9.8.7' }, midl: { class: 'square-480', records: [{ id: 'passage', hash: stored.hash, source: 'manager' }] } }, auth)
    fw.pulled = []
    fw.fetchConfig()
    assert.deepStrictEqual(fw.pulled, [])
    // Nothing changed: the next delivery only sends the index.
    fw.httpLog = []
    await manager.deliverMidl('yey-d-push')
    assert.deepStrictEqual(fw.httpLog.map((l) => `${l.method} ${l.path}`), ['PUT /api/midl/index'])
    // A record the profile drops is deleted from the display.
    manager.saveProfileChecked({ id: 'p', name: 'P', config: {}, midl: { records: [], index: {} } })
    await manager._lastMidlDelivery
    assert.ok(fw.httpLog.some((l) => l.method === 'DELETE' && l.path === '/api/midl/records/passage'))
    assert.ok(!fw.records.has('passage'))
  } finally {
    manager.close()
  }
})

// Bench: the display accepted the push but stored it as a local write (the
// Bearer token DM holds is stale; its web Basic credentials were valid). DM
// must stop pushing to it, pull instead, and say so on the device page.
test('stale device token: a push stored as "local" stops the pushes, falls back to pull and shows on the device page', needsBuild, async () => {
  const { manager, fw, auth } = pushRig()
  try {
    const web = manager.deviceWebAuth(manager.getDevice('yey-d-push'))
    assert.ok(web && web.password, 'DM has the display web password')
    fw.webPassword = web.password
    fw.managerToken = 'a-token-the-display-holds-but-dm-does-not'
    const doc = JSON.parse(SPAN_DOC_TEXT)
    manager.upsertProfile({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }], index: { order: ['passage'] } } })
    manager.assignProfile('yey-d-push', { profileId: 'p' })
    let [result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'token_mismatch', JSON.stringify(result))
    assert.strictEqual(result.via, 'pull')
    assert.strictEqual(fw.records.get('passage').source, 'local', 'the display took it as a local write')
    assert.deepStrictEqual(fw.httpLog.map((l) => `${l.method} ${l.path}`), ['PUT /api/midl/records/passage'], 'stopped after the first local write')
    assert.strictEqual(manager.getDevice('yey-d-push').midlDelivery.state, 'token_mismatch')
    assert.strictEqual(manager.pendingCommands('yey-d-push').filter((c) => c.type === 'config.reload').length, 1, 'config.reload queued (pull)')
    // Heartbeats report the record as local: no push, no extra reloads.
    for (let i = 0; i < 3; i++) fw.heartbeat()
    fw.httpLog = []
    doc.screens[0].title = 'Changed'
    manager.saveProfileChecked({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }], index: { order: ['passage'] } } })
    ;[result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'token_mismatch')
    assert.deepStrictEqual(fw.httpLog, [], 'nothing is pushed to the display any more')
    assert.strictEqual(manager.pendingCommands('yey-d-push').filter((c) => c.type === 'config.reload').length, 1, 'the pending reload is reused')
    // The display pulls its screens with its own (valid) device token.
    fw.pollAndExecute()
    assert.strictEqual(fw.records.get('passage').doc.screens[0].title, 'Changed')
    // The device page tells the owner to re-pair.
    const html = plugin.__renderDevicePage(manager, 'yey-d-push')
    assert.match(html, /midl-token-mismatch/)
    assert.match(html, /Re-pair the display/)
    const api = await call(routes(manager)('GET', '/devices/:id/midl'), { params: { id: 'yey-d-push' } })
    assert.strictEqual(api.json.delivery.state, 'token_mismatch')
    // Re-paired: DM holds the token the display accepts -> pushes resume.
    const fresh = 'the-re-paired-token'
    manager.secrets.noteDeviceToken('yey-d-push', fresh)
    fw.managerToken = fresh
    doc.screens[0].title = 'Changed again'
    manager.saveProfileChecked({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }], index: { order: ['passage'] } } })
    ;[result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'pushed', JSON.stringify(result))
    assert.strictEqual(fw.records.get('passage').source, 'manager')
    assert.doesNotMatch(plugin.__renderDevicePage(manager, 'yey-d-push'), /midl-token-mismatch/)
    assert.ok(auth)
  } finally {
    manager.close()
  }
})

test('stale device token seen in the heartbeat (a push answer without source) marks token_mismatch once', needsBuild, async () => {
  const { manager, fw } = pushRig()
  try {
    fw.webPassword = manager.deviceWebAuth(manager.getDevice('yey-d-push')).password
    fw.managerToken = 'stale'
    const orig = fw.http.bind(fw)
    fw.http = (url, method, text, a) => orig(url, method, text, a).then((r) => {
      if (r && r.json) delete r.json.source
      return r
    })
    const doc = JSON.parse(SPAN_DOC_TEXT)
    manager.upsertProfile({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }] } })
    manager.assignProfile('yey-d-push', { profileId: 'p' })
    const [result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'pushed')
    fw.heartbeat()
    const d = manager.getDevice('yey-d-push').midlDelivery
    assert.strictEqual(d.state, 'token_mismatch')
    assert.deepStrictEqual(d.records, ['passage'])
    const reloads = () => manager.pendingCommands('yey-d-push').filter((c) => c.type === 'config.reload').length
    assert.strictEqual(reloads(), 1)
    fw.heartbeat()
    fw.heartbeat()
    assert.strictEqual(reloads(), 1, 'flagged once, not on every heartbeat')
    fw.httpLog = []
    await manager.deliverMidl('yey-d-push')
    assert.deepStrictEqual(fw.httpLog, [], 'no re-push')
  } finally {
    manager.close()
  }
})

test('push falls back to pull: unreachable or refused credentials queue config.reload; the display pulls', needsBuild, async () => {
  const { manager, fw, auth } = pushRig()
  try {
    fw.reachable = false
    const doc = JSON.parse(SPAN_DOC_TEXT)
    manager.upsertProfile({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }] } })
    manager.assignProfile('yey-d-push', { profileId: 'p' })
    let [result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'push-failed')
    assert.strictEqual(result.via, 'pull')
    const reload = manager.pendingCommands('yey-d-push').filter((c) => c.type === 'config.reload')
    assert.strictEqual(reload.length, 1)
    fw.pollAndExecute()
    assert.deepStrictEqual(fw.pulled, ['passage'])
    assert.strictEqual(fw.records.get('passage').docText, SPAN_DOC_TEXT)

    // Reachable, but it holds another token and DM has no web password
    // that works: auth refused -> pull.
    fw.reachable = true
    fw.managerToken = 'something-else'
    doc.screens[0].title = 'Changed'
    manager.saveProfileChecked({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }] } })
    ;[result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'auth-refused')
    assert.ok(fw.httpLog.some((l) => l.auth && l.auth.bearer), 'the token was tried first')
    assert.strictEqual(manager.pendingCommands('yey-d-push').filter((c) => c.type === 'config.reload').length, 1)

    // A record the display's validator refuses is reported, not retried by pull.
    fw.managerToken = manager.secrets.deviceToken('yey-d-push')
    const orig = fw.http.bind(fw)
    fw.http = (url, method, text, a) => method === 'PUT' && url.includes('/records/')
      ? Promise.reject(Object.assign(new Error('422'), { status: 422, payload: { error: { details: { body: { error: 'invalid', message: '/screens/0 bad' } } } } }))
      : orig(url, method, text, a)
    doc.screens[0].title = 'Changed again'
    const pending = manager.pendingCommands('yey-d-push').length
    manager.saveProfileChecked({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc }] } })
    ;[result] = await manager._lastMidlDelivery
    assert.strictEqual(result.state, 'refused')
    assert.strictEqual(result.refusedRecord, 'passage')
    assert.match(result.error, /bad/)
    assert.strictEqual(manager.pendingCommands('yey-d-push').length, pending)
    assert.ok(auth)
  } finally {
    manager.close()
  }
})

test('the MIDL editor saves a record and shows it on the display (activate)', needsBuild, async () => {
  const { manager, fw, api } = pushRig()
  try {
    const r = routes(manager)
    const doc = JSON.parse(SPAN_DOC_TEXT)
    const op = { authorization: `Bearer ${api}` }
    const res = await call(r('POST', '/devices/:id/editor/midl'), { method: 'POST', params: { id: 'yey-d-push' }, headers: op, body: { doc, show: true } })
    assert.strictEqual(res.status, 200, JSON.stringify(res.json))
    assert.strictEqual(res.json.record, 'passage')
    assert.strictEqual(res.json.delivery.state, 'pushed')
    assert.ok(fw.httpLog.some((l) => l.path === '/api/midl/records/passage?activate=1&screen=passage'), 'activate on PUT')
    assert.strictEqual(fw.screen, 'passage')
    const def = manager.store.profiles.profiles.default
    assert.strictEqual(JSON.stringify(def.midl.records[0].doc), SPAN_DOC_TEXT)
    const got = await call(r('GET', '/devices/:id/editor/midl'), { params: { id: 'yey-d-push' }, headers: op })
    assert.strictEqual(got.json.doc, SPAN_DOC_TEXT)
    assert.strictEqual(got.json.record, 'passage')
    assert.ok(got.json.records.some((x) => x.id === 'wind' && x.source === 'embedded'))
  } finally {
    manager.close()
  }
})

test('screen ids: bare MIDL ids from the records; switch-screen drops a legacy mgr_ prefix', async () => {
  const { manager, auth } = makeManager()
  try {
    manager.registerDevice({ device: { id: 'yey-d-v', display: { width: 480, height: 480 } } }, auth)
    manager.upsertProfile({ id: 'p', name: 'P', config: {}, midl: { records: [{ id: 'passage', doc: JSON.parse(SPAN_DOC_TEXT) }], index: { order: ['passage'], hidden: ['trip'] } } })
    manager.assignProfile('yey-d-v', { profileId: 'p' })
    const views = manager.deviceViews('yey-d-v').views
    assert.strictEqual(views[0].id, 'passage')
    assert.strictEqual(views[0].record, 'passage')
    assert.ok(views.some((v) => v.id === 'status'))
    assert.ok(!views.some((v) => v.id === 'trip'), 'hidden records are not in the carousel')
    assert.ok(!views.some((v) => v.id.startsWith('mgr_')))
    const res = await call(routes(manager)('POST', '/ui/devices/:id/switch-screen'), { method: 'POST', params: { id: 'yey-d-v' }, body: { screenId: 'mgr_passage' } })
    assert.strictEqual(res.status, 303)
    const cmd = manager.pendingCommands('yey-d-v').find((c) => c.type === 'screen.set')
    assert.strictEqual(cmd.payload.screen, 'passage')
    // The heartbeat's ui.screens win when present.
    manager.updateStatus('yey-d-v', { ui: { screen: 'nav', screens: [{ id: 'nav', title: 'Nav', record: 'nav' }] } }, auth)
    assert.deepStrictEqual(manager.deviceViews('yey-d-v').views.map((v) => v.id), ['nav'])
  } finally {
    manager.close()
  }
})

test('store-time gate: a record the display class would refuse blocks the assignment (422)', needsBuild, () => {
  const { manager, auth } = makeManager()
  try {
    manager.registerDevice({ device: { id: 'yey-d-g', display: { width: 480, height: 480 } } }, auth)
    const bad = JSON.parse(SPAN_DOC_TEXT)
    bad.screens[0].elements.rose.type = 'no-such-element'
    manager.upsertProfile({ id: 'bad', name: 'Bad', config: {}, midl: { records: [{ id: 'bad', doc: bad }] } })
    assert.throws(() => manager.assignProfile('yey-d-g', { profileId: 'bad' }), (e) => e.status === 422 && e.payload.error.code === 'layout_invalid')
    assert.strictEqual(manager.getDevice('yey-d-g').assignedProfile || 'default', 'default')
    // A screen id two records use is refused too.
    const a = JSON.parse(SPAN_DOC_TEXT)
    manager.upsertProfile({ id: 'dup', name: 'Dup', config: {}, midl: { records: [{ id: 'a', doc: a }, { id: 'b', doc: a }] } })
    assert.throws(() => manager.assignProfile('yey-d-g', { profileId: 'dup' }), (e) => e.status === 422 && /screen id "passage"/.test(e.message))
  } finally {
    manager.close()
  }
})

test('v2 editors are gone: no v2 editor route, save-screen only switches screens', async () => {
  const { manager, auth } = makeManager()
  try {
    manager.registerDevice({ device: { id: 'yey-d-r' } }, auth)
    assert.strictEqual(typeof manager.editorLayout, 'undefined')
    assert.strictEqual(typeof manager.addScreen, 'undefined')
    const list = []
    const add = (method) => (p) => list.push(`${method} ${p}`)
    plugin._test.registerRoutes({ use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }, () => manager)
    assert.deepStrictEqual(list.filter((r) => /editor\/(layout|screens)|presets\/|\/capabilities$/.test(r) && !/^GET \/capabilities$/.test(r)), [])
    const save = routes(manager)('POST', '/ui/devices/:id/save-screen')
    const refused = await call(save, { method: 'POST', params: { id: 'yey-d-r' }, body: { mode: 'update', edits: '[]' } })
    assert.strictEqual(refused.status, 400)
    const ok = await call(save, { method: 'POST', params: { id: 'yey-d-r' }, body: { mode: 'switch', screenId: 'wind', ajax: '1' } })
    assert.deepStrictEqual(ok.json, { status: 'switched', screenId: 'wind' })
  } finally {
    manager.close()
  }
})
