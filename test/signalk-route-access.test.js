// #96: SignalK 2.36+ puts /plugins/<id>/* routes behind admin unless the plugin
// registers each route's access level with router.access(level). These tests
// check which level each display-facing route gets, and that the admin routes
// keep SignalK's default (admin).
//
// The SignalK side is modelled from signalk-server 2.37.0:
//   - dist/interfaces/plugins.js asPluginRouter: router.access(level).<method>
//     calls securityStrategy.registerPluginRoutePermissions(pluginId, [...]).
//   - dist/tokensecurity.js pluginAuthenticationMiddleware: the first entry whose
//     method and path match decides. 'readonly' passes any authenticated
//     principal (with allow_readonly, a request without a token counts as one);
//     'readwrite' needs a readwrite or admin principal; no entry means admin.
// The handler side runs the real plugin routes through a small Express-like shim.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const makePlugin = require('../index')

const PLUGIN_ID = 'yey-boats-display-manager'
const DEV_TOKEN = 'route-access-test-token'

const freshPlugin = () => makePlugin({ getDataDirPath: () => os.tmpdir(), debug: () => {}, handleMessage: () => {} })

// Routes a display (or the knob) calls itself, with the level this change gives
// them. Keep in sync with DEVICE_ROUTE_ACCESS in index.js: a change here must be
// deliberate.
const EXPECTED_ACCESS = [
  ['GET', '/.well-known/yeyboats-management', 'readonly'],
  ['GET', '/devices/:id/config', 'readonly'],
  ['GET', '/devices/:id/commands', 'readonly'],
  ['GET', '/devices/:id/midl/records/:rid', 'readonly'],
  ['GET', '/firmware/download/:jobId', 'readonly'],
  ['GET', '/devices/summary', 'readwrite'],
  ['GET', '/devices/:id/views', 'readwrite'],
  ['POST', '/devices/register', 'readwrite'],
  ['POST', '/devices/:id/status', 'readwrite'],
  ['POST', '/devices/:id/commands/:commandId/ack', 'readwrite'],
  ['POST', '/devices/:id/firmware/jobs/:jobId/progress', 'readwrite'],
  ['POST', '/devices/:id/firmware/confirm', 'readwrite']
]

// Operator routes that must stay on the default (admin) level.
const ADMIN_EXAMPLES = [
  ['POST', '/ui/devices/:id/delete'],
  ['DELETE', '/devices/:id'],
  ['POST', '/devices/:id/command'],
  ['GET', '/devices/:id/live/status'],
  ['GET', '/capabilities'],
  ['POST', '/discovery/devices'],
  ['GET', '/devices/:id/commands/:commandId'],
  ['POST', '/devices/:id/tokens/rotate'],
  ['POST', '/profiles'],
  ['GET', '/ui/devices']
]

// --- SignalK side -----------------------------------------------------------

// Mirrors asPluginRouter (signalk-server 2.37.0, dist/interfaces/plugins.js).
// `withAccess: false` models a server before router.access existed.
function makeSignalKRouter ({ withAccess }) {
  const routes = [] // { method, path }
  const permissions = [] // { method, path, permission }
  const add = (method) => (p, ...handlers) => {
    routes.push({ method, path: p, handlers })
  }
  const router = {
    use () {},
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE')
  }
  if (withAccess) {
    router.access = (level) => {
      const register = (method, p, handlers) => {
        permissions.push({ method, path: p, permission: level })
        router[method.toLowerCase()](p, ...handlers)
        return registrar
      }
      const registrar = {
        get: (p, ...h) => register('GET', p, h),
        post: (p, ...h) => register('POST', p, h),
        put: (p, ...h) => register('PUT', p, h),
        patch: (p, ...h) => register('PATCH', p, h),
        delete: (p, ...h) => register('DELETE', p, h)
      }
      return registrar
    }
  }
  return { router, routes, permissions }
}

// The permission a request gets, per tokensecurity.js pluginAuthenticationMiddleware.
// principal: 'anonymous' | 'readonly' | 'readwrite' | 'admin'.
function skAllows (permissions, method, requestPath, principal, allowReadonly) {
  const entry = permissions.find((e) => e.method === method && pathRegex(e.path).test(requestPath))
  const level = entry ? entry.permission : 'admin'
  if (level === 'readonly') {
    if (principal === 'anonymous') return allowReadonly
    return true // any authenticated principal
  }
  if (level === 'readwrite') return principal === 'readwrite' || principal === 'admin'
  return principal === 'admin'
}

function pathRegex (routePath) {
  const full = `/plugins/${PLUGIN_ID}${routePath}`
  const src = full.replace(/[.]/g, '\\.').replace(/:[A-Za-z]+/g, '[^/]+')
  return new RegExp(`^${src}/?$`)
}

// Concrete request path for a route template.
function concrete (routePath) {
  return routePath
    .replace(':id', 'yey-d-28372f8a0290')
    .replace(':commandId', 'cmd-1')
    .replace(':jobId', 'job-1')
    .replace(':rid', 'rec-1')
}

const requestPath = (routePath) => `/plugins/${PLUGIN_ID}${concrete(routePath)}`

const keyOf = (method, p) => `${method} ${p}`

// --- Handler side: Express-like shim over the real plugin routes ------------

function makeDispatchShim (plugin) {
  const routes = []
  const middleware = []
  const toSegments = (p) => p.split('/').filter(Boolean)
  const add = (method) => (p, ...handlers) => {
    routes.push({ method, segments: toSegments(p), handler: handlers[handlers.length - 1] })
  }
  const router = {
    use: (fn) => { middleware.push(fn) },
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE')
  }
  plugin.registerWithRouter(router)
  const match = (method, urlPath) => {
    const parts = toSegments(urlPath)
    for (const route of routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i])
        else if (seg !== parts[i]) { ok = false; break }
      }
      if (ok) return { route, params }
    }
    return null
  }
  return (method, urlPath, headers = {}, body = {}) => new Promise((resolve) => {
    const m = match(method, urlPath)
    const res = {
      statusCode: 200,
      status (code) { this.statusCode = code; return this },
      json (value) { resolve({ status: this.statusCode, body: value }) },
      setHeader () {},
      end () { resolve({ status: this.statusCode, body: undefined }) }
    }
    if (!m) { res.status(404).json({ error: { code: 'not_found' } }); return }
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    const req = {
      method,
      url: urlPath,
      params: m.params,
      query: {},
      headers: lower,
      body,
      get: (name) => lower[String(name).toLowerCase()] || ''
    }
    let i = 0
    const next = () => {
      if (i < middleware.length) {
        middleware[i++](req, res, next)
        return
      }
      Promise.resolve(m.route.handler(req, res)).catch((err) => {
        res.status(err.status || 500).json({ error: { message: err.message } })
      })
    }
    next()
  })
}

// --- tests ------------------------------------------------------------------

test('device routes are registered at the access level the display firmware needs', () => {
  const plugin = freshPlugin()
  const sk = makeSignalKRouter({ withAccess: true })
  plugin.registerWithRouter(sk.router)
  const actual = sk.permissions.map((e) => [e.method, e.path, e.permission]).sort((a, b) => keyOf(...a).localeCompare(keyOf(...b)))
  const expected = EXPECTED_ACCESS.slice().sort((a, b) => keyOf(...a).localeCompare(keyOf(...b)))
  assert.deepStrictEqual(actual, expected)
})

test('a display with a readwrite SignalK token reaches every device route', () => {
  const plugin = freshPlugin()
  const sk = makeSignalKRouter({ withAccess: true })
  plugin.registerWithRouter(sk.router)
  for (const [method, p] of EXPECTED_ACCESS) {
    assert.strictEqual(
      skAllows(sk.permissions, method, requestPath(p), 'readwrite', false), true,
      `readwrite token reaches ${method} ${p}`
    )
  }
})

test('readonly and anonymous callers cannot reach the device POST routes', () => {
  const plugin = freshPlugin()
  const sk = makeSignalKRouter({ withAccess: true })
  plugin.registerWithRouter(sk.router)
  for (const [method, p, level] of EXPECTED_ACCESS.filter((e) => e[0] === 'POST')) {
    assert.strictEqual(level, 'readwrite')
    assert.strictEqual(skAllows(sk.permissions, method, requestPath(p), 'readonly', false), false, `readonly refused on ${p}`)
    assert.strictEqual(skAllows(sk.permissions, method, requestPath(p), 'anonymous', true), false, `anonymous refused on ${p}`)
  }
})

test('admin routes stay admin: readwrite, readonly and anonymous callers are refused', () => {
  const plugin = freshPlugin()
  const sk = makeSignalKRouter({ withAccess: true })
  plugin.registerWithRouter(sk.router)
  const device = new Set(EXPECTED_ACCESS.map(([m, p]) => keyOf(m, p)))
  const admin = sk.routes.filter((r) => !device.has(keyOf(r.method, r.path)))
  assert.ok(admin.length > 50, `expected many admin routes, found ${admin.length}`)
  for (const [method, p] of ADMIN_EXAMPLES) {
    assert.ok(admin.some((r) => r.method === method && r.path === p), `${method} ${p} is registered and admin-only`)
  }
  for (const r of admin) {
    const rp = requestPath(r.path)
    assert.strictEqual(skAllows(sk.permissions, r.method, rp, 'readwrite', true), false, `readwrite refused on ${r.method} ${r.path}`)
    assert.strictEqual(skAllows(sk.permissions, r.method, rp, 'readonly', true), false, `readonly refused on ${r.method} ${r.path}`)
    assert.strictEqual(skAllows(sk.permissions, r.method, rp, 'anonymous', true), false, `anonymous refused on ${r.method} ${r.path}`)
    assert.strictEqual(skAllows(sk.permissions, r.method, rp, 'admin', false), true, `admin allowed on ${r.method} ${r.path}`)
  }
})

test('with allow_readonly on, only device-checked GETs and the discovery document are anonymous-readable', () => {
  const plugin = freshPlugin()
  const sk = makeSignalKRouter({ withAccess: true })
  plugin.registerWithRouter(sk.router)
  const open = EXPECTED_ACCESS
    .filter(([m, p]) => skAllows(sk.permissions, m, requestPath(p), 'anonymous', true))
    .map(([m, p]) => keyOf(m, p))
    .sort()
  // config, commands, firmware download and MIDL records check the device token in
  // their handler (anonymous gets 401 there). The discovery document is public
  // protocol info (server id, auth method names, intervals).
  assert.deepStrictEqual(open, [
    'GET /.well-known/yeyboats-management',
    'GET /devices/:id/commands',
    'GET /devices/:id/config',
    'GET /devices/:id/midl/records/:rid',
    'GET /firmware/download/:jobId'
  ])
})

test('without router.access (older SignalK) the routes register exactly as before', () => {
  const plugin = freshPlugin()
  const withAccess = makeSignalKRouter({ withAccess: true })
  freshPlugin().registerWithRouter(withAccess.router)
  const legacy = makeSignalKRouter({ withAccess: false })
  plugin.registerWithRouter(legacy.router)
  assert.deepStrictEqual(legacy.permissions, [], 'no access calls on a server without router.access')
  const shape = (routes) => routes.map((r) => keyOf(r.method, r.path))
  assert.deepStrictEqual(shape(legacy.routes), shape(withAccess.routes),
    'same routes, same order, with or without router.access')
})

test('handlers answer a device token and refuse anonymous calls (dev shared-token mode)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ybdm-route-access-'))
  const plugin = makePlugin({ getDataDirPath: () => dataDir, debug: () => {}, handleMessage: () => {} })
  // The plugin takes dev auth only from YEYBOATS_MANAGER_DEV_AUTH=1, never from
  // config, so set it for this test and restore it afterwards.
  const prevDevAuth = process.env.YEYBOATS_MANAGER_DEV_AUTH
  process.env.YEYBOATS_MANAGER_DEV_AUTH = '1'
  plugin.start({
    discoveryUdp: { enabled: false },
    deviceDiscoveryUdp: { enabled: false },
    firmware: { github: { enabled: false } },
    network: { mdns: { browser: false, advertiseManager: false } },
    auth: { mode: 'dev-shared-token', devToken: DEV_TOKEN }
  })
  try {
    const dispatch = makeDispatchShim(plugin)
    const dev = { 'x-yeyboats-authorization': `Bearer ${DEV_TOKEN}` }
    const deviceId = 'yey-d-aabbccddeeff'

    const reg = await dispatch('POST', '/devices/register', dev, { device: { id: deviceId, board: 'esp32-4848s040' } })
    assert.strictEqual(reg.status, 200, 'register with the device token succeeds')

    const summary = await dispatch('GET', '/devices/summary')
    assert.strictEqual(summary.status, 200, 'summary route answers')

    const cfgOk = await dispatch('GET', `/devices/${deviceId}/config`, dev)
    assert.strictEqual(cfgOk.status, 200, 'config with the device token succeeds')

    const cfgAnon = await dispatch('GET', `/devices/${deviceId}/config`)
    assert.strictEqual(cfgAnon.status, 401, 'config without a device token is refused by the handler')

    const cmdAnon = await dispatch('GET', `/devices/${deviceId}/commands`)
    assert.strictEqual(cmdAnon.status, 401, 'commands without a device token is refused by the handler')
  } finally {
    plugin.stop()
    if (prevDevAuth === undefined) delete process.env.YEYBOATS_MANAGER_DEV_AUTH
    else process.env.YEYBOATS_MANAGER_DEV_AUTH = prevDevAuth
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
