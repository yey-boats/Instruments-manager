'use strict'
// Dashboards from yey.boats: the yey connector serves them as the SignalK
// resource type `yey-dashboards`; the manager lists them and imports one as
// a profile through the same path as /profiles/import-dashboard.
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')
const { makeManager } = require('./test-utils')
const cloud = require('../lib/cloud-dashboards')
const plugin = require('../index')

const midlBuilt = fs.existsSync(path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs'))
const needsBuild = { skip: midlBuilt ? false : 'MIDL bundle not built (midl/ts/dist/index.cjs missing)' }

function routes (manager) {
  const list = []
  const add = (method) => (p, ...h) => list.push({ method, p, h: h[h.length - 1] })
  const router = { use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }
  plugin._test.registerRoutes(router, () => manager)
  return (method, p) => list.find((r) => r.method === method && r.p === p)
}

function call (route, { method = 'GET', params = {}, query = {}, headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader (k, v) { this.headers[k.toLowerCase()] = v },
      status (c) { this.statusCode = c; return this },
      json (b) { resolve({ status: this.statusCode, json: b, headers: this.headers }) },
      end (b) { resolve({ status: this.statusCode, body: b, headers: this.headers }) }
    }
    Promise.resolve(route.h({ method, params, query, headers, body, get: () => '' }, res)).catch(reject)
  })
}

function midlDoc (title, paths) {
  const elements = {}
  const cells = []
  paths.forEach((p, i) => {
    elements[`e${i}`] = { type: 'single-value', name: p.split('.').pop().toUpperCase(), bindings: { value: { kind: 'signalk', path: p } } }
    cells.push({ element: `e${i}` })
  })
  return { midl: '1.0.0', meta: { title }, screens: [{ id: 'main', title, elements, layout: { rows: 1, cols: paths.length, cells } }] }
}

const MIDL_YAML = `midl: 1.0.0
meta:
  title: Passage
screens:
  - id: main
    title: Passage
    elements:
      sog:
        type: single-value
        name: SOG
        format: { unit: kn }
        bindings:
          value: { kind: signalk, path: navigation.speedOverGround }
    layout:
      rows: 1
      cols: 1
      cells:
        - { element: sog }
`

// A fake yey connector behind app.resourcesApi.
function connector (manager, dashboards) {
  const store = dashboards
  manager.app.resourcesApi = {
    listResources: async (type, params) => {
      assert.strictEqual(type, 'yey-dashboards')
      assert.deepStrictEqual(params, {})
      const out = {}
      for (const [id, d] of Object.entries(store)) out[id] = { name: d.name, title: d.title, targetClass: d.targetClass, updatedAt: d.updatedAt }
      return out
    },
    getResource: async (type, id) => {
      assert.strictEqual(type, 'yey-dashboards')
      if (!store[id]) throw new Error(`dashboard ${id} not found`)
      return Object.assign({ id }, store[id])
    }
  }
  return store
}

test('listing maps the connector resources, newest first, with the import state', async () => {
  const { manager } = makeManager()
  connector(manager, {
    a1: { name: 'day', title: 'Day sailing', targetClass: 'square-480', updatedAt: '2026-11-01T10:00:00Z', doc: '{}' },
    b2: { name: 'night', title: '', targetClass: 'round-360', updatedAt: '2026-11-10T10:00:00Z', doc: '{}' }
  })
  const res = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.json.available, true)
  assert.deepStrictEqual(res.json.dashboards.map((d) => [d.id, d.title, d.targetClass, d.state, d.profileId]), [
    ['b2', 'night', 'round-360', 'new', null],
    ['a1', 'Day sailing', 'square-480', 'new', null]
  ])
})

test('mapListing marks an imported dashboard current, or update when newer on yey.boats', () => {
  const profiles = [{ id: 'yey-day', source: 'yey.boats', sourceId: 'a1', sourceUpdatedAt: '2026-11-01T10:00:00Z' }]
  const same = cloud.mapListing({ a1: { title: 'Day', updatedAt: '2026-11-01T10:00:00Z' } }, profiles)[0]
  assert.strictEqual(same.state, 'current')
  assert.strictEqual(same.profileId, 'yey-day')
  const newer = cloud.mapListing({ a1: { title: 'Day', updatedAt: '2026-11-02T10:00:00Z' } }, profiles)[0]
  assert.strictEqual(newer.state, 'update')
  assert.deepStrictEqual(cloud.mapListing(null, profiles), [])
})

test('unavailable states: no resources API, connector missing, connector offline', async () => {
  const { manager } = makeManager()
  const list = routes(manager)('GET', '/cloud-dashboards')

  let res = await call(list)
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.json.available, false)
  assert.strictEqual(res.json.reason, 'resources_api_missing')

  manager.app.resourcesApi = {
    listResources: async () => { throw new Error('No provider for yey-dashboards') },
    getResource: async () => { throw new Error('No provider for yey-dashboards') }
  }
  res = await call(list)
  assert.strictEqual(res.json.available, false)
  assert.strictEqual(res.json.reason, 'connector_missing')
  assert.match(res.json.message, /Connect this boat to yey\.boats/)

  manager.app.resourcesApi = {
    listResources: () => Promise.reject(new Error('not connected to yey.boats')),
    getResource: () => Promise.reject(new Error('not connected to yey.boats'))
  }
  res = await call(list)
  assert.strictEqual(res.json.reason, 'connector_unavailable')
  assert.match(res.json.message, /not connected to yey\.boats/)

  // Import while offline: a 503 with the reason, not a 500.
  res = await call(routes(manager)('POST', '/cloud-dashboards/:id/import'), { method: 'POST', params: { id: 'a1' } })
  assert.strictEqual(res.status, 503)
  assert.strictEqual(res.json.error.code, 'cloud_unavailable')
  assert.strictEqual(res.json.error.details.reason, 'connector_unavailable')
})

test('a hanging connector times out into the unavailable state', async () => {
  const app = { resourcesApi: { listResources: () => new Promise(() => {}), getResource: () => new Promise(() => {}) } }
  const r = await cloud.listCloudDashboards(app, [], { timeoutMs: 20 })
  assert.strictEqual(r.available, false)
  assert.strictEqual(r.reason, 'connector_unavailable')
})

test('import creates a profile through the shared validator, carrying title and origin; re-import updates it', needsBuild, async () => {
  const { manager } = makeManager()
  const store = connector(manager, {
    'dash-1': { name: 'passage', title: 'Passage <night>', targetClass: 'square-480', updatedAt: '2026-11-01T10:00:00Z', doc: MIDL_YAML }
  })
  const imp = routes(manager)('POST', '/cloud-dashboards/:id/import')
  let res = await call(imp, { method: 'POST', params: { id: 'dash-1' } })
  assert.strictEqual(res.status, 200, JSON.stringify(res.json))
  const id = res.json.id
  assert.strictEqual(id, 'yey-passage-night')
  assert.strictEqual(res.json.updated, false)
  assert.strictEqual(res.json.midlValidation.ok, true)
  let p = manager.store.profiles.profiles[id]
  assert.strictEqual(p.name, 'Passage <night>')
  assert.strictEqual(p.source, 'yey.boats')
  assert.strictEqual(p.sourceId, 'dash-1')
  assert.strictEqual(p.sourceUpdatedAt, '2026-11-01T10:00:00Z')
  assert.strictEqual(p.config.widgets.items.sog.path, 'navigation.speedOverGround')

  // Listed as current now.
  let list = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.strictEqual(list.json.dashboards[0].state, 'current')
  assert.strictEqual(list.json.dashboards[0].profileId, id)

  // Edited on yey.boats (now JSON text): listed as update, re-import updates in place.
  store['dash-1'].updatedAt = '2026-11-05T10:00:00Z'
  store['dash-1'].doc = JSON.stringify(midlDoc('Passage', ['navigation.speedOverGround', 'environment.depth.belowTransducer']))
  list = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.strictEqual(list.json.dashboards[0].state, 'update')
  const before = Object.keys(manager.store.profiles.profiles).length
  res = await call(imp, { method: 'POST', params: { id: 'dash-1' } })
  assert.strictEqual(res.json.id, id)
  assert.strictEqual(res.json.updated, true)
  assert.strictEqual(Object.keys(manager.store.profiles.profiles).length, before)
  p = manager.store.profiles.profiles[id]
  assert.strictEqual(p.version, 2)
  assert.strictEqual(p.sourceUpdatedAt, '2026-11-05T10:00:00Z')
  assert.strictEqual(Object.keys(p.config.widgets.items).length, 2)
})

test('import never overwrites a local profile with the same id', needsBuild, async () => {
  const { manager } = makeManager()
  manager.upsertProfile({ id: 'yey-day', name: 'mine', config: { widgets: { items: {} } } })
  connector(manager, { x: { title: 'Day', updatedAt: '2026-11-01T10:00:00Z', doc: JSON.stringify(midlDoc('Day', ['navigation.speedOverGround'])) } })
  const res = await call(routes(manager)('POST', '/cloud-dashboards/:id/import'), { method: 'POST', params: { id: 'x' } })
  assert.strictEqual(res.json.id, 'yey-day-2')
  assert.strictEqual(manager.store.profiles.profiles['yey-day'].name, 'mine')
})

test('an invalid doc is refused with the validator message, and nothing is stored', needsBuild, async () => {
  const { manager } = makeManager()
  const bad = midlDoc('Bad', ['navigation.speedOverGround'])
  bad.screens[0].elements.e0.type = 'nonsense'
  connector(manager, { bad: { title: 'Bad', updatedAt: '2026-11-01T10:00:00Z', doc: JSON.stringify(bad) } })
  const before = Object.keys(manager.store.profiles.profiles).length
  const imp = routes(manager)('POST', '/cloud-dashboards/:id/import')
  const res = await call(imp, { method: 'POST', params: { id: 'bad' } })
  assert.strictEqual(res.status, 422)
  assert.strictEqual(res.json.error.code, 'midl_invalid')
  assert.ok(res.json.error.details.issues.some((i) => /element type not supported: nonsense/.test(i.message)))
  assert.strictEqual(Object.keys(manager.store.profiles.profiles).length, before)

  // The same doc through the file import: the same refusal (one validator).
  await assert.rejects(
    async () => plugin._test.importDashboardPreset(manager, { raw: JSON.stringify(bad), presetId: 'bad' }, {}),
    (err) => err.status === 422 && err.payload.error.code === 'midl_invalid')

  // From the UI form: redirected back with the message.
  const form = await call(imp, { method: 'POST', params: { id: 'bad' }, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.strictEqual(form.status, 303)
  const loc = decodeURIComponent(form.headers.location)
  assert.match(loc, /\/ui\/profiles\?cloudError=MIDL document fails validation for square-480/)
  assert.match(loc, /element type not supported: nonsense/)
})

test('signalk-server drops provider rejections: empty list, empty get', async () => {
  const { manager } = makeManager()
  manager.app.resourcesApi = { listResources: async () => ({}), getResource: async () => undefined }
  const list = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.deepStrictEqual(list.json, { available: true, dashboards: [] })
  const imp = routes(manager)('POST', '/cloud-dashboards/:id/import')
  for (const got of [undefined, null, {}, { id: 'a1', title: 'T' }, { id: 'a1', doc: { midl: '1.0.0' } }]) {
    manager.app.resourcesApi.getResource = async () => got
    const res = await call(imp, { method: 'POST', params: { id: 'a1' } })
    assert.strictEqual(res.status, 502, JSON.stringify(got))
    assert.strictEqual(res.json.error.code, 'cloud_dashboard_unavailable')
    assert.strictEqual(res.json.error.message, "Couldn't fetch that dashboard from yey.boats (is the connector online?)")
  }
  const form = await call(imp, { method: 'POST', params: { id: 'a1' }, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.match(decodeURIComponent(form.headers.location), /cloudError=Couldn't fetch that dashboard/)
})

test('a malformed cloud doc is a 400, a doc-less resource a 502', async () => {
  const { manager } = makeManager()
  connector(manager, {
    junk: { title: 'Junk', updatedAt: '', doc: '{not json' },
    none: { title: 'None', updatedAt: '' }
  })
  const imp = routes(manager)('POST', '/cloud-dashboards/:id/import')
  let res = await call(imp, { method: 'POST', params: { id: 'junk' } })
  assert.strictEqual(res.status, 400)
  res = await call(imp, { method: 'POST', params: { id: 'none' } })
  assert.strictEqual(res.status, 502)
  assert.strictEqual(res.json.error.code, 'cloud_dashboard_unavailable')
})

test('the file import also takes a MIDL document now', needsBuild, () => {
  const { manager } = makeManager()
  const r = plugin._test.importDashboardPreset(manager, { raw: MIDL_YAML, format: 'yaml', presetId: 'from-file' }, {})
  assert.strictEqual(r.id, 'from-file')
  assert.strictEqual(r.name, 'Passage')
  assert.strictEqual(r.midlValidation.ok, true)
  assert.strictEqual(manager.store.profiles.profiles['from-file'].source, undefined)
})

test('profiles page: From yey.boats panel escapes cloud strings and shows the states', async () => {
  const { manager } = makeManager()
  const page = routes(manager)('GET', '/ui/profiles')
  let res = await call(page)
  assert.match(res.body, /From yey\.boats/)
  assert.match(res.body, /Connect this boat to yey\.boats with the yey connector to see your dashboards here/)

  connector(manager, {})
  res = await call(page)
  assert.match(res.body, /data-cloud-state="empty"/)
  assert.match(res.body, /No dashboards from yey\.boats yet\. Make sure the yey connector is installed, paired and online/)

  connector(manager, {
    'x"><script>': { name: '<b>n</b>', title: '<img src=x onerror=alert(1)>', targetClass: '<i>c</i>', updatedAt: '2026-11-01T10:00:00Z<x>', doc: '{}' }
  })
  res = await call(page)
  assert.ok(!res.body.includes('<img src=x'))
  assert.ok(!res.body.includes('x"><script>'))
  assert.ok(!res.body.includes('<i>c</i>'))
  assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.match(res.body, /cloud-dashboards\/x%22%3E%3Cscript%3E\/import/)
  assert.match(res.body, />Import</)

  const err = plugin._test.renderCloudDashboardsPanel({ available: true, dashboards: [] }, { query: { cloudError: '<svg onload=1>' } })
  assert.ok(!err.includes('<svg'))
  assert.match(err, /Import failed: &lt;svg/)
})
