'use strict'
// Dashboards from yey.boats: the yey connector (0.5.0+) exposes them
// in-process as app.yeyDashboards, readable only after someone signs in with
// yey.boats (the link flow). The manager shows the sign-in state, runs the
// link flow, lists the dashboards and imports one as a profile through the
// same path as /profiles/import-dashboard. Every cloud-dashboards route is an
// operator route, the GETs included.
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')
const { makeManager, makeSecureManager } = require('./test-utils')
const cloud = require('../lib/cloud-dashboards')
const plugin = require('../index')

const midlBuilt = fs.existsSync(path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs'))
const needsBuild = { skip: midlBuilt ? false : 'MIDL bundle not built (midl/ts/dist/index.cjs missing)' }

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

const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

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

const coded = (code, message) => Object.assign(new Error(message || code), { code })

// A fake yey connector: app.yeyDashboards with the state behind it.
function connector (manager, init) {
  const c = Object.assign({
    connected: true,
    linked: false,
    user_label: null,
    expires_at: null,
    pending: null,
    // what linkPoll answers next while a sign-in is pending
    verdict: 'pending',
    dashboards: {},
    calls: []
  }, init || {})
  const rec = (name) => c.calls.push(name)
  const gate = () => {
    if (!c.connected) throw coded('not_connected')
    if (c.grantInvalid) throw coded('grant_invalid')
    if (!c.linked) throw coded('not_linked')
  }
  manager.app.yeyDashboards = {
    state: async () => {
      rec('state')
      return { connected: c.connected, linked: c.linked, user_label: c.user_label, expires_at: c.expires_at, pending: c.pending }
    },
    linkStart: async () => {
      rec('linkStart')
      if (!c.connected) throw coded('not_connected')
      c.pending = c.nextPending || { code: 'ABC-123', verify_url: 'https://yey.boats/link', expires_at: '2026-11-14T12:10:00Z' }
      c.verdict = 'pending'
      return c.pending
    },
    linkPoll: async () => {
      rec('linkPoll')
      if (!c.pending) return { status: 'expired' }
      if (c.verdict === 'approved') {
        Object.assign(c, { linked: true, user_label: c.approveAs || 'Skipper Ann', expires_at: '2026-12-14T12:00:00Z', pending: null })
        return { status: 'approved', user_label: c.user_label, expires_at: c.expires_at }
      }
      if (c.verdict !== 'pending') c.pending = null
      return { status: c.verdict }
    },
    list: async () => {
      rec('list')
      gate()
      return {
        user_label: c.user_label,
        dashboards: Object.entries(c.dashboards).map(([id, d]) => ({ id, title: d.title, targetClass: d.targetClass, updatedAt: d.updatedAt }))
      }
    },
    get: async (id) => {
      rec(`get:${id}`)
      gate()
      if (!c.dashboards[id]) throw coded('not_found', `dashboard ${id} not found`)
      return Object.assign({ id }, c.dashboards[id])
    },
    unlink: async () => {
      rec('unlink')
      Object.assign(c, { linked: false, user_label: null, expires_at: null, pending: null })
    }
  }
  return c
}

const linked = (extra) => Object.assign({ linked: true, user_label: 'Skipper Ann', expires_at: '2026-12-14T12:00:00Z' }, extra || {})

test('state: connector missing or older than 0.5.0', async () => {
  const { manager } = makeManager()
  const get = routes(manager)('GET', '/cloud-dashboards')
  let res = await call(get)
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.json.state, 'connector_missing')
  assert.match(res.json.message, /older than 0\.5\.0/)
  // An older connector: something there, but not the 0.5.0 API.
  manager.app.yeyDashboards = { list: async () => ({}) }
  res = await call(get)
  assert.strictEqual(res.json.state, 'connector_missing')
  const page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, /data-cloud-state="connector_missing"/)
  assert.ok(!page.body.includes('Sign in with yey.boats'))
})

test('state: boat not connected to yey.boats', async () => {
  const { manager } = makeManager()
  const c = connector(manager, { connected: false })
  const res = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.deepStrictEqual(res.json, { state: 'not_connected', message: cloud.MESSAGES.not_connected })
  assert.deepStrictEqual(c.calls, ['state'])
  const page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, /data-cloud-state="not_connected"/)
})

test('state: not signed in shows the sign-in button', async () => {
  const { manager } = makeManager()
  const c = connector(manager)
  const res = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.strictEqual(res.json.state, 'not_linked')
  assert.ok(!c.calls.includes('list'), 'no list without a sign-in')
  const page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, /data-cloud-state="not_linked"/)
  assert.match(page.body, /<form method="post" action="\/plugins\/yey-boats-display-manager\/cloud-dashboards\/link"><button type="submit">Sign in with yey\.boats<\/button>/)
})

test('state: signed in, with the list newest first and the import state', async () => {
  const { manager } = makeManager()
  connector(manager, linked({
    dashboards: {
      a1: { title: 'Day sailing', targetClass: 'square-480', updatedAt: '2026-11-01T10:00:00Z', doc: '{}' },
      b2: { title: '', targetClass: 'round-360', updatedAt: '2026-11-10T10:00:00Z', doc: '{}' }
    }
  }))
  const res = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.strictEqual(res.json.state, 'linked')
  assert.strictEqual(res.json.user_label, 'Skipper Ann')
  assert.strictEqual(res.json.expires_at, '2026-12-14T12:00:00Z')
  assert.deepStrictEqual(res.json.dashboards.map((d) => [d.id, d.title, d.targetClass, d.state, d.profileId]), [
    ['b2', 'b2', 'round-360', 'new', null],
    ['a1', 'Day sailing', 'square-480', 'new', null]
  ])
  const page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, /Signed in to yey\.boats as <strong>Skipper Ann<\/strong> until <time datetime="2026-12-14T12:00:00Z">/)
  assert.match(page.body, /action="\/plugins\/yey-boats-display-manager\/cloud-dashboards\/unlink"[^>]*><button type="submit">Sign out</)
  assert.match(page.body, /cloud-dashboards\/a1\/import/)
  assert.match(page.body, />Import</)
})

test('signed in with nothing saved yet', async () => {
  const { manager } = makeManager()
  connector(manager, linked())
  const page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, /data-cloud-state="linked"/)
  assert.match(page.body, /data-cloud-list="empty"/)
})

test('a sign-in that is no longer valid, a failing and a silent connector', async () => {
  const { manager } = makeManager()
  const c = connector(manager, linked({ grantInvalid: true }))
  let r = await cloud.cloudState(manager.app, [])
  assert.deepStrictEqual(r, { state: 'not_linked', reason: 'grant_invalid', message: cloud.MESSAGES.grant_invalid })
  const page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, /data-cloud-reason="grant_invalid"/)
  assert.match(page.body, /Sign in with yey\.boats/)

  c.grantInvalid = false
  manager.app.yeyDashboards.list = async () => { throw coded('boom', 'socket hang up') }
  r = await cloud.cloudState(manager.app, [])
  assert.strictEqual(r.state, 'error')
  assert.match(r.message, /socket hang up/)

  manager.app.yeyDashboards.state = () => new Promise(() => {})
  r = await cloud.cloudState(manager.app, [], { timeoutMs: 20 })
  assert.strictEqual(r.state, 'error')
  assert.strictEqual(r.reason, 'timeout')
})

test('link flow: start, then poll pending -> approved, then the list', async () => {
  const { manager } = makeManager()
  const c = connector(manager, { dashboards: { a1: { title: 'Day', targetClass: 'square-480', updatedAt: '2026-11-01T10:00:00Z', doc: '{}' } } })
  const r = routes(manager)

  const start = await call(r('POST', '/cloud-dashboards/link'), { method: 'POST' })
  assert.strictEqual(start.status, 200)
  assert.strictEqual(start.json.code, 'ABC-123')
  assert.strictEqual(start.json.verify_url, 'https://yey.boats/link')
  assert.strictEqual(start.json.verify_url_safe, 'https://yey.boats/link')

  // From the UI form: back to the panel.
  const form = await call(r('POST', '/cloud-dashboards/link'), { method: 'POST', headers: FORM })
  assert.strictEqual(form.status, 303)
  assert.strictEqual(form.headers.location, '/plugins/yey-boats-display-manager/ui/profiles#yey-boats')

  let state = await call(r('GET', '/cloud-dashboards'))
  assert.strictEqual(state.json.state, 'pending')
  assert.strictEqual(state.json.pending.code, 'ABC-123')

  const page = await call(r('GET', '/ui/profiles'))
  assert.match(page.body, /data-cloud-state="pending"/)
  assert.match(page.body, /class="cloud-code"[^>]*>ABC-123</)
  assert.match(page.body, /<a href="https:\/\/yey\.boats\/link" target="_blank" rel="noopener noreferrer">https:\/\/yey\.boats\/link<\/a>/)
  assert.match(page.body, /Waiting for approval…/)
  assert.match(page.body, /fetch\(url/)
  assert.match(page.body, /"\/plugins\/yey-boats-display-manager\/cloud-dashboards\/link"/)
  assert.match(page.body, /setTimeout\(poll, 3000\)/)

  const poll = r('GET', '/cloud-dashboards/link')
  let p = await call(poll)
  assert.deepStrictEqual(p.json, { status: 'pending' })
  assert.strictEqual(p.headers['cache-control'], 'no-store')

  c.verdict = 'approved'
  p = await call(poll)
  assert.deepStrictEqual(p.json, { status: 'approved', user_label: 'Skipper Ann', expires_at: '2026-12-14T12:00:00Z' })

  state = await call(r('GET', '/cloud-dashboards'))
  assert.strictEqual(state.json.state, 'linked')
  assert.strictEqual(state.json.user_label, 'Skipper Ann')
  assert.deepStrictEqual(state.json.dashboards.map((d) => d.id), ['a1'])
})

test('a page reload while pending polls once, so it moves on without script', async () => {
  const { manager } = makeManager()
  const c = connector(manager)
  await cloud.startLink(manager.app)
  c.verdict = 'approved'
  const r = await cloud.cloudState(manager.app, [])
  assert.strictEqual(r.state, 'linked')
  assert.strictEqual(r.user_label, 'Skipper Ann')
  // The no-script fallback while waiting.
  const { manager: m2 } = makeManager()
  connector(m2, { pending: { code: 'XYZ-999', verify_url: 'https://yey.boats/link', expires_at: '' } })
  const page = await call(routes(m2)('GET', '/ui/profiles'))
  assert.match(page.body, /<noscript><meta http-equiv="refresh" content="5"><\/noscript>/)
})

test('link flow: rejected and expired end in the not-signed-in state with a note', async () => {
  for (const verdict of ['rejected', 'expired']) {
    const { manager } = makeManager()
    const c = connector(manager)
    await cloud.startLink(manager.app)
    c.verdict = verdict
    const r = await cloud.cloudState(manager.app, [])
    assert.strictEqual(r.state, 'not_linked')
    assert.strictEqual(r.link, verdict)
    const html = plugin._test.renderCloudDashboardsPanel(r, { query: {} })
    assert.match(html, new RegExp(`data-cloud-link="${verdict}"`))
    assert.match(html, /Sign in with yey\.boats/)
    // The script reloads with ?cloudLink=<verdict> once its poll sees it.
    const after = plugin._test.renderCloudDashboardsPanel({ state: 'not_linked' }, { query: { cloudLink: verdict } })
    assert.match(after, new RegExp(`data-cloud-link="${verdict}"`))
  }
  const odd = plugin._test.renderCloudDashboardsPanel({ state: 'not_linked' }, { query: { cloudLink: '<x>' } })
  assert.ok(!odd.includes('data-cloud-link'))
})

test('link start refused: a 409 for the API, the message back on the panel for the form', async () => {
  const { manager } = makeManager()
  connector(manager, { connected: false })
  const link = routes(manager)('POST', '/cloud-dashboards/link')
  let res = await call(link, { method: 'POST' })
  assert.strictEqual(res.status, 409)
  assert.strictEqual(res.json.error.code, 'cloud_not_connected')
  res = await call(link, { method: 'POST', headers: FORM })
  assert.strictEqual(res.status, 303)
  assert.match(decodeURIComponent(res.headers.location), /\/ui\/profiles\?cloudError=Sign-in failed: The yey connector is not connected/)
  delete manager.app.yeyDashboards
  res = await call(link, { method: 'POST' })
  assert.strictEqual(res.status, 503)
  assert.strictEqual(res.json.error.code, 'cloud_connector_missing')
})

test('unlink signs out', async () => {
  const { manager } = makeManager()
  const c = connector(manager, linked())
  const r = routes(manager)
  let res = await call(r('POST', '/cloud-dashboards/unlink'), { method: 'POST' })
  assert.deepStrictEqual(res.json, { ok: true })
  assert.ok(c.calls.includes('unlink'))
  assert.strictEqual((await call(r('GET', '/cloud-dashboards'))).json.state, 'not_linked')

  Object.assign(c, linked())
  res = await call(r('POST', '/cloud-dashboards/unlink'), { method: 'POST', headers: FORM })
  assert.strictEqual(res.status, 303)
  assert.strictEqual(res.headers.location, '/plugins/yey-boats-display-manager/ui/profiles#yey-boats')
  assert.strictEqual(c.linked, false)
})

test('every cloud-dashboards route needs an operator, the GETs included', async () => {
  const { manager } = makeSecureManager()
  const api = manager.apiToken.pendingReveal()
  // SignalK security on, the caller a read-only guest (not an admin).
  manager.app.securityStrategy = { isDummy: () => false, allowConfigure: () => false }
  const c = connector(manager, linked({
    pending: null,
    dashboards: { a1: { title: 'Day', targetClass: 'square-480', updatedAt: '2026-11-01T10:00:00Z', doc: '{}' } }
  }))
  const r = routes(manager)
  const all = [
    ['GET', '/cloud-dashboards', {}],
    ['GET', '/cloud-dashboards/link', {}],
    ['POST', '/cloud-dashboards/link', {}],
    ['POST', '/cloud-dashboards/unlink', {}],
    ['POST', '/cloud-dashboards/:id/import', { id: 'a1' }]
  ]
  for (const [method, p, params] of all) {
    const res = await call(r(method, p), { method, params })
    assert.strictEqual(res.status, 401, `${method} ${p}`)
    assert.strictEqual(res.json.error.code, 'operator_auth_required')
  }
  assert.deepStrictEqual(c.calls, [], 'the connector is never asked for a guest')

  // The profiles page renders for the guest, without the list or the code.
  c.pending = { code: 'SEC-RET', verify_url: 'https://yey.boats/link', expires_at: '' }
  c.linked = false
  let page = await call(r('GET', '/ui/profiles'))
  assert.strictEqual(page.status, 200)
  assert.match(page.body, /data-cloud-state="operator_required"/)
  assert.ok(!page.body.includes('SEC-RET'))
  assert.ok(!page.body.includes('Sign in with yey.boats'))
  assert.deepStrictEqual(c.calls, [])

  // With the manager API token: allowed.
  const auth = { 'x-yeyboats-authorization': `Bearer ${api}` }
  const res = await call(r('GET', '/cloud-dashboards'), { headers: auth })
  assert.strictEqual(res.status, 200)
  assert.strictEqual(res.json.state, 'pending')
  const poll = await call(r('GET', '/cloud-dashboards/link'), { headers: auth })
  assert.deepStrictEqual(poll.json, { status: 'pending' })
  page = await call(r('GET', '/ui/profiles'), { headers: auth })
  assert.match(page.body, /SEC-RET/)

  // A SignalK admin session is enough too.
  manager.app.securityStrategy.allowConfigure = () => true
  assert.strictEqual((await call(r('GET', '/cloud-dashboards'))).status, 200)
})

test('cloud strings are escaped: titles, user_label, code, verify_url; only https goes into an href', async () => {
  const { manager } = makeManager()
  connector(manager, linked({
    user_label: '<img src=x onerror=alert(1)>',
    expires_at: '"><script>t</script>',
    dashboards: {
      'x"><script>': { title: '<img src=y onerror=alert(2)>', targetClass: '<i>c</i>', updatedAt: '2026-11-01T10:00:00Z<x>', doc: '{}' }
    }
  }))
  let res = await call(routes(manager)('GET', '/ui/profiles'))
  for (const raw of ['<img src=x', '<img src=y', 'x"><script>', '<i>c</i>', '<script>t</script>']) assert.ok(!res.body.includes(raw), raw)
  assert.ok(res.body.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.match(res.body, /cloud-dashboards\/x%22%3E%3Cscript%3E\/import/)

  for (const url of ['javascript:alert(1)', 'http://yey.boats/link', 'https://yey.boats/"onmouseover="x']) {
    const html = plugin._test.renderCloudDashboardsPanel({
      state: 'pending',
      pending: { code: '<b>C</b>', verify_url: url, verify_url_safe: cloud.safeHttpsUrl(url), expires_at: '' }
    }, { query: {} })
    assert.ok(!/<a href="(?!\/)/.test(html), `no href for ${url}`)
    assert.ok(!html.includes('<b>C</b>'))
    assert.ok(html.includes('&lt;b&gt;C&lt;/b&gt;'))
  }
  assert.strictEqual(cloud.safeHttpsUrl('https://yey.boats/link?c=1'), 'https://yey.boats/link?c=1')

  const err = plugin._test.renderCloudDashboardsPanel({ state: 'linked', dashboards: [] }, { query: { cloudError: '<svg onload=1>' } })
  assert.ok(!err.includes('<svg'))
  assert.match(err, /&lt;svg/)
})

test('mapListing marks an imported dashboard current, or update when newer on yey.boats', () => {
  const profiles = [{ id: 'yey-day', source: 'yey.boats', sourceId: 'a1', sourceUpdatedAt: '2026-11-01T10:00:00Z' }]
  const same = cloud.mapListing([{ id: 'a1', title: 'Day', updatedAt: '2026-11-01T10:00:00Z' }], profiles)[0]
  assert.strictEqual(same.state, 'current')
  assert.strictEqual(same.profileId, 'yey-day')
  const newer = cloud.mapListing([{ id: 'a1', title: 'Day', updatedAt: '2026-11-02T10:00:00Z' }], profiles)[0]
  assert.strictEqual(newer.state, 'update')
  assert.deepStrictEqual(cloud.mapListing(null, profiles), [])
  assert.deepStrictEqual(cloud.mapListing([null, { title: 'no id' }], profiles), [])
})

test('import via get() creates a profile through the shared validator, with its origin; re-import updates it', needsBuild, async () => {
  const { manager } = makeManager()
  const c = connector(manager, linked({
    dashboards: { 'dash-1': { title: 'Passage <night>', targetClass: 'square-480', updatedAt: '2026-11-01T10:00:00Z', doc: MIDL_YAML } }
  }))
  const imp = routes(manager)('POST', '/cloud-dashboards/:id/import')
  let res = await call(imp, { method: 'POST', params: { id: 'dash-1' } })
  assert.strictEqual(res.status, 200, JSON.stringify(res.json))
  assert.ok(c.calls.includes('get:dash-1'))
  const id = res.json.id
  assert.strictEqual(id, 'yey-passage-night')
  assert.strictEqual(res.json.updated, false)
  assert.strictEqual(res.json.midlValidation.ok, true)
  let p = manager.store.profiles.profiles[id]
  assert.strictEqual(p.name, 'Passage <night>')
  assert.strictEqual(p.source, 'yey.boats')
  assert.strictEqual(p.sourceId, 'dash-1')
  assert.strictEqual(p.sourceUpdatedAt, '2026-11-01T10:00:00Z')
  assert.strictEqual(p.sourceTargetClass, 'square-480')
  assert.ok(p.importedAt)
  assert.strictEqual(p.config.widgets.items.sog.path, 'navigation.speedOverGround')

  let list = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.strictEqual(list.json.dashboards[0].state, 'current')
  assert.strictEqual(list.json.dashboards[0].profileId, id)
  let page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, />Re-import</)

  // Edited on yey.boats (now JSON text): listed as update, re-import updates in place.
  c.dashboards['dash-1'].updatedAt = '2026-11-05T10:00:00Z'
  c.dashboards['dash-1'].doc = JSON.stringify(midlDoc('Passage', ['navigation.speedOverGround', 'environment.depth.belowTransducer']))
  list = await call(routes(manager)('GET', '/cloud-dashboards'))
  assert.strictEqual(list.json.dashboards[0].state, 'update')
  page = await call(routes(manager)('GET', '/ui/profiles'))
  assert.match(page.body, />Update</)
  const before = Object.keys(manager.store.profiles.profiles).length
  res = await call(imp, { method: 'POST', params: { id: 'dash-1' } })
  assert.strictEqual(res.json.id, id)
  assert.strictEqual(res.json.updated, true)
  assert.strictEqual(Object.keys(manager.store.profiles.profiles).length, before)
  p = manager.store.profiles.profiles[id]
  assert.strictEqual(p.version, 2)
  assert.strictEqual(p.sourceUpdatedAt, '2026-11-05T10:00:00Z')
  assert.strictEqual(Object.keys(p.config.widgets.items).length, 2)

  // From the UI form: to the preset page.
  const form = await call(imp, { method: 'POST', params: { id: 'dash-1' }, headers: FORM })
  assert.strictEqual(form.status, 303)
  assert.strictEqual(form.headers.location, `/plugins/yey-boats-display-manager/ui/profiles/${id}?status=cloud-updated`)
})

test('import never overwrites a local profile with the same id', needsBuild, async () => {
  const { manager } = makeManager()
  manager.upsertProfile({ id: 'yey-day', name: 'mine', config: { widgets: { items: {} } } })
  connector(manager, linked({ dashboards: { x: { title: 'Day', updatedAt: '2026-11-01T10:00:00Z', doc: JSON.stringify(midlDoc('Day', ['navigation.speedOverGround'])) } } }))
  const res = await call(routes(manager)('POST', '/cloud-dashboards/:id/import'), { method: 'POST', params: { id: 'x' } })
  assert.strictEqual(res.json.id, 'yey-day-2')
  assert.strictEqual(manager.store.profiles.profiles['yey-day'].name, 'mine')
})

test('an invalid doc is refused with the validator message, and nothing is stored', needsBuild, async () => {
  const { manager } = makeManager()
  const bad = midlDoc('Bad', ['navigation.speedOverGround'])
  bad.screens[0].elements.e0.type = 'nonsense'
  connector(manager, linked({ dashboards: { bad: { title: 'Bad', updatedAt: '2026-11-01T10:00:00Z', doc: JSON.stringify(bad) } } }))
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
  const form = await call(imp, { method: 'POST', params: { id: 'bad' }, headers: FORM })
  assert.strictEqual(form.status, 303)
  const loc = decodeURIComponent(form.headers.location)
  assert.match(loc, /\/ui\/profiles\?cloudError=Import failed: MIDL document fails validation for square-480/)
  assert.match(loc, /element type not supported: nonsense/)
})

test('import refusals from the connector: not found, not signed in, not connected, missing, doc-less, malformed', async () => {
  const { manager } = makeManager()
  const c = connector(manager, linked({
    dashboards: {
      junk: { title: 'Junk', updatedAt: '', doc: '{not json' },
      none: { title: 'None', updatedAt: '' }
    }
  }))
  const imp = routes(manager)('POST', '/cloud-dashboards/:id/import')
  const status = async (id) => (await call(imp, { method: 'POST', params: { id } }))
  let res = await status('gone')
  assert.strictEqual(res.status, 404)
  assert.strictEqual(res.json.error.code, 'cloud_not_found')
  res = await status('junk')
  assert.strictEqual(res.status, 400)
  res = await status('none')
  assert.strictEqual(res.status, 502)
  assert.strictEqual(res.json.error.code, 'cloud_dashboard_unavailable')

  c.grantInvalid = true
  res = await status('junk')
  assert.strictEqual(res.status, 409)
  assert.strictEqual(res.json.error.code, 'cloud_grant_invalid')
  c.grantInvalid = false
  c.linked = false
  res = await status('junk')
  assert.strictEqual(res.json.error.code, 'cloud_not_linked')
  c.connected = false
  res = await status('junk')
  assert.strictEqual(res.json.error.code, 'cloud_not_connected')
  const form = await call(imp, { method: 'POST', params: { id: 'junk' }, headers: FORM })
  assert.match(decodeURIComponent(form.headers.location), /cloudError=Import failed: The yey connector is not connected/)
  delete manager.app.yeyDashboards
  res = await status('junk')
  assert.strictEqual(res.status, 503)
  assert.strictEqual(res.json.error.code, 'cloud_connector_missing')
})

test('the file import also takes a MIDL document now', needsBuild, () => {
  const { manager } = makeManager()
  const r = plugin._test.importDashboardPreset(manager, { raw: MIDL_YAML, format: 'yaml', presetId: 'from-file' }, {})
  assert.strictEqual(r.id, 'from-file')
  assert.strictEqual(r.name, 'Passage')
  assert.strictEqual(r.midlValidation.ok, true)
  assert.strictEqual(manager.store.profiles.profiles['from-file'].source, undefined)
})
