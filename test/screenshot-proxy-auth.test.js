// instruments-manager#20: the screenshot proxy must send the device's Basic
// Auth. Displays enforce web auth once a password is provisioned
// (instruments#28), so an unauthenticated proxy fetch 401s and the layout
// editor's live preview breaks.
//
// A mock display enforces Basic Auth with the device's per-device password
// (#19). Credentials go only to a host that is a registered device; an
// unknown host gets no Authorization header.
const assert = require('assert')
const http = require('http')
const { makeManager } = require('./test-utils')
const makePlugin = require('../index')
const { LEGACY_SHARED_WEB_PASSWORD: LEGACY } = require('../lib/device-secrets')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function basic (user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

function mockDisplay (host) {
  const device = { password: null, seen: [] }
  const server = http.createServer((req, res) => {
    device.seen.push(req.headers.authorization || null)
    if (device.password && req.headers.authorization !== basic('yeyboats', device.password)) {
      res.statusCode = 401
      res.setHeader('www-authenticate', 'Basic realm="espdisp"')
      res.end('auth required')
      return
    }
    if (req.url === '/api/screenshot.png') {
      res.setHeader('content-type', 'image/png')
      res.end(PNG)
      return
    }
    res.statusCode = 404
    res.end()
  })
  return {
    device,
    start: () => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve))
  }
}

function routesFor (manager) {
  const routes = []
  const add = (method) => (p, ...h) => routes.push({ method, p, h: h[h.length - 1] })
  const router = { use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }
  makePlugin._test.registerRoutes(router, () => manager)
  return routes
}

function call (route, query) {
  return new Promise((resolve, reject) => {
    const headers = {}
    const res = {
      statusCode: 200,
      setHeader (k, v) { headers[k.toLowerCase()] = v },
      status (c) { this.statusCode = c; return this },
      json (body) { resolve({ status: this.statusCode, json: body, headers }) },
      end (body) { resolve({ status: this.statusCode, body, headers }) }
    }
    Promise.resolve(route.h({ params: {}, query, headers: {}, body: {}, get: () => '' }, res)).catch(reject)
  })
}

module.exports = (async () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  manager.registerDevice({ device: { id: 'yey-d-shot' } }, auth)
  manager.updateStatus('yey-d-shot', { network: { ip: '127.0.0.1' }, config: { hash: 'x' } }, auth)
  const route = routesFor(manager).find((r) => r.method === 'GET' && r.p === '/devices/proxy/screenshot.png')
  assert.ok(route, 'screenshot proxy route registered')
  const password = manager.generateConfig('yey-d-shot').webAuth.password

  // ---- 1. registered device enforcing auth: proxy authenticates ----------
  const mock = mockDisplay('127.0.0.1')
  const port = await mock.start()
  try {
    mock.device.password = password
    const r = await call(route, { url: `http://127.0.0.1:${port}` })
    assert.strictEqual(r.status, 200, `proxy status ${r.status} ${JSON.stringify(r.json)}`)
    assert.ok(Buffer.compare(Buffer.from(r.body), PNG) === 0, 'PNG streamed back')
    assert.strictEqual(r.headers['content-type'], 'image/png')
    assert.strictEqual(mock.device.seen[mock.device.seen.length - 1], basic('yeyboats', password))

    // ---- 2. device not yet migrated (still on the old password) ----------
    mock.device.password = LEGACY
    const fs = require('fs')
    const path = require('path')
    fs.unlinkSync(path.join(manager.store.dataDir, 'device-secrets.json'))
    manager.secrets.load()
    const r2 = await call(route, { url: `127.0.0.1:${port}` })
    assert.strictEqual(r2.status, 200, 'falls back to the password the device still holds')

    // ---- 3. wrong password everywhere: the 401 is surfaced, not a crash --
    mock.device.password = 'not-what-the-manager-has'
    const r3 = await call(route, { url: `http://127.0.0.1:${port}` })
    assert.strictEqual(r3.status, 401)
  } finally { await mock.stop() }

  // ---- 4. unknown host: credentials are never sent ------------------------
  const stranger = mockDisplay('127.0.0.2')
  const sport = await stranger.start()
  try {
    stranger.device.password = password
    const r = await call(route, { url: `http://127.0.0.2:${sport}` })
    assert.strictEqual(r.status, 401)
    assert.ok(stranger.device.seen.length > 0 && stranger.device.seen.every((h) => h === null),
      'no Authorization header sent to a host that is not a registered device')
  } finally { await stranger.stop() }

  // ---- 5. existing guards still hold ---------------------------------------
  assert.strictEqual((await call(route, { url: 'http://8.8.8.8' })).status, 403)
  assert.strictEqual((await call(route, {})).status, 400)
})()
