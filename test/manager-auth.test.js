// instruments-manager#23: the manager API must not accept a public default
// token, and device credentials must be separate from operator credentials.
//
//   - first start generates a random manager API token (>=128 bits), kept in a
//     0600 file in the plugin data dir and revealed to the admin once
//   - `yeyboats-dev` (and auth.mode=disabled) only work behind the explicit
//     dev flag; a saved `dev-shared-token` config falls back to the secure mode
//   - devices get their own random token at pairing; the manager API token can
//     pair a device but never acts as one
//   - GET /devices/:id/config returns webAuth.password (and the OTA password)
//     only to that device's own token
//   - heartbeat network updates only come from the authenticated device
//   - devices paired with the shared dev token keep working and are migrated:
//     the manager pushes a per-device token over the device's authenticated
//     web API, then stops accepting the shared token for that device
//   - a claim delivers the device its token the same way
//   - state-changing routes reject cross-site browser requests (CSRF)
//   - the screenshot proxy only sends a device's credentials to its own port
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { makeSecureManager, makeManager } = require('./test-utils')
const { YeyBoatsDisplayManager } = require('../lib/manager')
const makePlugin = require('../index')

const DEV = 'yeyboats-dev'

function basic (user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

// Display web API: Basic Auth (null password = setup open), POST /api/cmd runs
// a console line. Records commands and Authorization headers.
function mockDisplay (host) {
  const device = { password: null, seen: [], commands: [] }
  const server = http.createServer((req, res) => {
    device.seen.push(req.headers.authorization || null)
    if (device.password && req.headers.authorization !== basic('yeyboats', device.password)) {
      res.statusCode = 401
      res.end('auth required')
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/cmd') {
        device.commands.push(body)
        res.setHeader('content-type', 'application/json')
        res.end('{"ok":true}')
        return
      }
      if (req.url === '/api/screenshot.png') {
        res.setHeader('content-type', 'image/png')
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        return
      }
      if (req.url.startsWith('/api/state')) {
        res.setHeader('content-type', 'application/json')
        res.end('{"sk":{"state":"live"}}')
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  return {
    device,
    start: () => new Promise((resolve) => server.listen(0, host || '127.0.0.1', () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve))
  }
}

function routesFor (manager) {
  const routes = []
  const add = (method) => (p, ...h) => routes.push({ method, p, h: h[h.length - 1] })
  const router = { use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }
  makePlugin._test.registerRoutes(router, () => manager)
  return {
    find: (method, p) => {
      const r = routes.find((x) => x.method === method && x.p === p)
      assert.ok(r, `${method} ${p} registered`)
      return r
    }
  }
}

function call (route, { method = 'GET', params = {}, query = {}, headers = {}, body = {}, remoteAddress = '127.0.0.1' } = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return new Promise((resolve, reject) => {
    const out = {}
    const res = {
      statusCode: 200,
      setHeader (k, v) { out[k.toLowerCase()] = v },
      status (c) { this.statusCode = c; return this },
      json (b) { resolve({ status: this.statusCode, json: b, headers: out }) },
      end (b) { resolve({ status: this.statusCode, body: b, headers: out }) }
    }
    const req = { method, params, query, headers: lower, body, socket: { remoteAddress }, get: (k) => lower[String(k).toLowerCase()] || '' }
    Promise.resolve(route.h(req, res)).catch(reject)
  })
}

const bearer = (t) => ({ bearer: t, provision: null })

module.exports = (async () => {
  // ---- 1. a random manager API token is generated on first start ----------
  {
    const { manager, dataDir, app } = makeSecureManager()
    const file = path.join(dataDir, 'manager-api-token.json')
    assert.ok(fs.existsSync(file), 'manager-api-token.json written')
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600)
    const token = manager.apiToken.pendingReveal()
    assert.ok(token, 'token pending reveal after first start')
    assert.notStrictEqual(token, DEV)
    // >= 128 bits: 32 random bytes base64url after the prefix.
    assert.ok(/^ybm_[A-Za-z0-9_-]{43}$/.test(token), `token shape ${token.length}`)
    assert.ok(manager.apiToken.verify(token))
    // A second install gets a different token.
    assert.notStrictEqual(makeSecureManager().manager.apiToken.pendingReveal(), token)
    // Not in the registry / audit / admin JSON.
    for (const f of fs.readdirSync(dataDir)) {
      if (f === 'manager-api-token.json') continue
      const p = path.join(dataDir, f)
      if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(token), `token leaked into ${f}`)
    }
    assert.ok(!JSON.stringify(manager.dashboard()).includes(token))
    assert.strictEqual(manager.dashboard().managerApiToken.revealPending, true)

    // Shown once: after the admin acknowledges, only the hash is kept...
    manager.apiToken.acknowledge()
    assert.strictEqual(manager.apiToken.pendingReveal(), null)
    assert.ok(!fs.readFileSync(file, 'utf8').includes(token), 'plaintext dropped after acknowledge')
    // ...it still verifies, and survives a restart without being regenerated.
    const again = new YeyBoatsDisplayManager(app, manager.options)
    assert.ok(again.apiToken.verify(token))
    assert.strictEqual(again.apiToken.pendingReveal(), null)
    // Rotation issues a new token and reveals it again; the old one stops working.
    const rotated = again.apiToken.rotate()
    assert.ok(!again.apiToken.verify(token))
    assert.ok(again.apiToken.verify(rotated))
    assert.strictEqual(again.apiToken.pendingReveal(), rotated)
  }

  // ---- 2. the public dev token is not accepted by default -----------------
  for (const mode of [undefined, 'dev-shared-token', 'disabled', 'provision-token']) {
    const { manager } = makeSecureManager(mode ? { auth: { mode } } : {})
    assert.strictEqual(manager.options.auth.mode, 'device-token', `mode ${mode} -> device-token without the dev flag`)
    assert.throws(() => manager.registerDevice({ device: { id: 'yey-d-x' } }, bearer(DEV)), (e) => e.status === 401)
    assert.throws(() => manager.registerDevice({ device: { id: 'yey-d-x' } }, { bearer: null, provision: DEV }), (e) => e.status === 401)
    assert.throws(() => manager.registerDevice({ device: { id: 'yey-d-x' } }, {}), (e) => e.status === 401)
    assert.throws(() => manager.announceDiscoveredDevice({ id: 'yey-d-x' }, bearer(DEV)), (e) => e.status === 401)
    assert.throws(() => manager.announceDiscoveredDevice({ id: 'yey-d-x' }, { provision: 'yeyboats-provision' }), (e) => e.status === 401)
    assert.ok(!manager.discovery().auth.methods.includes('dev-shared-token'))
  }
  // The dev modes still exist behind the explicit flag.
  {
    const { manager } = makeManager({ auth: { mode: 'dev-shared-token' } })
    assert.strictEqual(manager.options.auth.mode, 'dev-shared-token')
    assert.strictEqual(manager.registerDevice({ device: { id: 'yey-d-dev' } }, bearer(DEV)).status, 'registered')
  }

  // ---- 3. pairing issues a per-device token; the API token is not one ------
  {
    const { manager } = makeSecureManager()
    const api = manager.apiToken.pendingReveal()
    const a = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(api))
    const b = manager.registerDevice({ device: { id: 'yey-d-b' } }, bearer(api))
    for (const r of [a, b]) {
      assert.strictEqual(r.status, 'registered')
      assert.ok(r.deviceToken && r.deviceToken !== api && r.deviceToken !== DEV)
      assert.ok(r.deviceToken.length >= 30, 'device token has >=128 bits')
    }
    assert.notStrictEqual(a.deviceToken, b.deviceToken)
    assert.strictEqual(manager.updateStatus('yey-d-a', {}, bearer(a.deviceToken)).status, 'ok')
    // Operator token and other devices' tokens cannot act as the device.
    for (const t of [api, b.deviceToken, DEV]) {
      assert.throws(() => manager.updateStatus('yey-d-a', {}, bearer(t)), (e) => e.status === 401)
      assert.throws(() => manager.getCommands('yey-d-a', bearer(t), 5), (e) => e.status === 401)
    }
    // Re-registering with the device's own token keeps the token.
    const again = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(a.deviceToken))
    assert.strictEqual(again.status, 'updated')
    assert.strictEqual(again.deviceToken, undefined)
    assert.strictEqual(manager.updateStatus('yey-d-a', {}, bearer(a.deviceToken)).status, 'ok')
    // A device that lost its token re-pairs with an operator credential and gets a new one.
    const repair = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(api))
    assert.ok(repair.deviceToken && repair.deviceToken !== a.deviceToken)
    assert.throws(() => manager.updateStatus('yey-d-a', {}, bearer(a.deviceToken)), (e) => e.status === 401)

    // ---- 4. config secrets only go to the device's own credential ---------
    const own = manager.deviceConfigFor('yey-d-b', bearer(b.deviceToken))
    const pass = manager.generateConfig('yey-d-b').webAuth.password
    assert.strictEqual(own.webAuth.password, pass)
    const asOperator = manager.deviceConfigFor('yey-d-b', bearer(api))
    assert.strictEqual(asOperator.webAuth.password, undefined)
    assert.ok(!JSON.stringify(asOperator).includes(pass))
    assert.notStrictEqual(asOperator.hash, own.hash, 'redacted config has its own hash')
    for (const t of [a.deviceToken, DEV, null]) {
      assert.throws(() => manager.deviceConfigFor('yey-d-b', bearer(t)), (e) => e.status === 401)
    }

    // ---- 5. heartbeat network identity only from the device ----------------
    manager.updateStatus('yey-d-b', { network: { ip: '10.0.0.5' } }, bearer(b.deviceToken))
    assert.strictEqual(manager.getDevice('yey-d-b').status.network.ip, '10.0.0.5')
    assert.throws(() => manager.updateStatus('yey-d-b', { network: { ip: '10.6.6.6' } }, bearer(api)))
    assert.throws(() => manager.updateStatus('yey-d-b', { network: { ip: '10.6.6.6' } }, bearer(DEV)))
    assert.strictEqual(manager.getDevice('yey-d-b').status.network.ip, '10.0.0.5')
  }

  // ---- 6. migration of devices paired with the shared dev token ------------
  {
    const mock = mockDisplay()
    const port = await mock.start()
    try {
      // An install that ran in dev-shared-token mode...
      const old = makeManager({ auth: { mode: 'dev-shared-token' } })
      old.manager.registerDevice({ device: { id: 'yey-d-old' } }, bearer(DEV))
      old.manager.updateStatus('yey-d-old', { network: { ip: '127.0.0.1' }, config: { hash: 'x' } }, bearer(DEV))
      old.manager.store.registry.devices['yey-d-old'].httpPort = port
      old.manager.store.saveRegistry()
      const webPass = old.manager.generateConfig('yey-d-old').webAuth.password
      mock.device.password = webPass
      old.manager.close()

      // ...upgraded: same data dir, saved config still says dev-shared-token.
      const manager = new YeyBoatsDisplayManager(old.app, { ...old.manager.options, auth: { mode: 'dev-shared-token', devToken: DEV } })
      try {
        assert.strictEqual(manager.options.auth.mode, 'device-token')
        assert.strictEqual(manager.authStatus('yey-d-old').tokenMigration.state, 'pending')

        // The device keeps working with the token it holds...
        assert.strictEqual(manager.updateStatus('yey-d-old', { network: { ip: '10.6.6.6' }, config: { hash: 'x' } }, bearer(DEV)).status, 'ok')
        assert.ok(manager.getCommands('yey-d-old', bearer(DEV), 5))
        // ...but the shared token can no longer move its address or read its secrets.
        assert.strictEqual(manager.getDevice('yey-d-old').status.network.ip, '127.0.0.1')
        const redacted = manager.deviceConfigFor('yey-d-old', bearer(DEV))
        assert.strictEqual(redacted.webAuth.password, undefined)
        assert.strictEqual(redacted.webAuth.enabled, true)
        // Nor register a brand-new device.
        assert.throws(() => manager.registerDevice({ device: { id: 'yey-d-new' } }, bearer(DEV)), (e) => e.status === 401)

        // The manager delivers a per-device token over the device's web API
        // (its stored address + registered port, its own Basic Auth).
        const result = await manager.pushDeviceManagerToken('yey-d-old')
        assert.strictEqual(result.status, 'delivered')
        assert.strictEqual(mock.device.commands.length, 1)
        const m = mock.device.commands[0].match(/^manager-token (\S+)$/)
        assert.ok(m, `pushed ${mock.device.commands[0]}`)
        const newToken = m[1]
        assert.notStrictEqual(newToken, DEV)
        assert.strictEqual(mock.device.seen[mock.device.seen.length - 1], basic('yeyboats', webPass))
        assert.ok(!fs.readFileSync(path.join(old.dataDir, 'registry.json'), 'utf8').includes(newToken))

        // Until the device uses it, the legacy token still works (restricted).
        assert.strictEqual(manager.updateStatus('yey-d-old', {}, bearer(DEV)).status, 'ok')
        // Once it does, the shared token is retired for that device.
        assert.strictEqual(manager.updateStatus('yey-d-old', { network: { ip: '127.0.0.1' } }, bearer(newToken)).status, 'ok')
        assert.strictEqual(manager.authStatus('yey-d-old').tokenMigration.state, 'done')
        assert.throws(() => manager.updateStatus('yey-d-old', {}, bearer(DEV)), (e) => e.status === 401)
        assert.strictEqual(manager.deviceConfigFor('yey-d-old', bearer(newToken)).webAuth.password, webPass)
        assert.strictEqual(manager.secrets.pendingManagerToken('yey-d-old'), null)
      } finally { manager.close() }
    } finally { await mock.stop() }
  }

  // ---- 7. a claim delivers the device its token ----------------------------
  {
    const mock = mockDisplay()
    const port = await mock.start()
    try {
      const { manager } = makeSecureManager()
      manager.recordDiscoveredDevice({ id: 'yey-d-fresh', address: '127.0.0.1', port })
      const claimed = manager.claimDiscoveredDevice('yey-d-fresh', { profileId: 'default' })
      assert.strictEqual(claimed.status, 'claimed')
      const delivery = await manager.pushDeviceManagerToken('yey-d-fresh')
      assert.strictEqual(delivery.status, 'delivered')
      const tok = mock.device.commands[0].replace(/^manager-token /, '')
      assert.ok(tok && tok !== DEV)
      // The device registers with the delivered token.
      assert.strictEqual(manager.registerDevice({ device: { id: 'yey-d-fresh' } }, bearer(tok)).status, 'updated')
      assert.strictEqual(manager.updateStatus('yey-d-fresh', {}, bearer(tok)).status, 'ok')
      assert.strictEqual(manager.secrets.pendingManagerToken('yey-d-fresh'), null, 'plaintext dropped once used')

      // Rotation delivers the new token too, so the display is not stranded.
      const rotated = manager.rotateDeviceToken('yey-d-fresh')
      assert.strictEqual((await manager.pushDeviceManagerToken('yey-d-fresh')).status, 'delivered')
      assert.strictEqual(mock.device.commands[1], `manager-token ${rotated.deviceToken}`)
      assert.throws(() => manager.updateStatus('yey-d-fresh', {}, bearer(tok)), (e) => e.status === 401)
      assert.strictEqual(manager.updateStatus('yey-d-fresh', {}, bearer(rotated.deviceToken)).status, 'ok')

      // An unreachable display: delivery fails, recorded, nothing thrown.
      const { manager: m2 } = makeSecureManager()
      m2.recordDiscoveredDevice({ id: 'yey-d-gone', address: '127.0.0.1', port: 1 })
      m2.claimDiscoveredDevice('yey-d-gone', { profileId: 'default' })
      m2.getDevice('yey-d-gone').networkIdentity = {}
      const failed = await m2.pushDeviceManagerToken('yey-d-gone')
      assert.strictEqual(failed.status, 'failed')
      assert.strictEqual(m2.authStatus('yey-d-gone').tokenDelivery.state, 'failed')
    } finally { await mock.stop() }
  }

  // ---- 8. routes: rejected bootstrap registration shows up in discovery ----
  {
    const { manager } = makeSecureManager()
    const routes = routesFor(manager)
    const r = await call(routes.find('POST', '/devices/register'), {
      method: 'POST',
      headers: { 'x-yeyboats-authorization': `Bearer ${DEV}` },
      body: { device: { id: 'yey-d-boot', name: 'Boot' } },
      remoteAddress: '::ffff:192.168.1.77'
    })
    assert.strictEqual(r.status, 401)
    const seen = manager.listDiscoveredDevices().devices.find((d) => d.deviceId === 'yey-d-boot')
    assert.ok(seen, 'unauthenticated register attempt listed for the operator to claim')
    assert.strictEqual(seen.address, '192.168.1.77')
    assert.strictEqual(manager.store.registry.devices['yey-d-boot'], undefined)

    // GET config through the route: operator token -> redacted.
    const api = manager.apiToken.pendingReveal()
    const reg = manager.registerDevice({ device: { id: 'yey-d-r' } }, bearer(api))
    const cfgRoute = routes.find('GET', '/devices/:id/config')
    const asOp = await call(cfgRoute, { params: { id: 'yey-d-r' }, headers: { 'x-yeyboats-authorization': `Bearer ${api}` } })
    assert.strictEqual(asOp.status, 200)
    assert.strictEqual(asOp.json.webAuth.password, undefined)
    const asDev = await call(cfgRoute, { params: { id: 'yey-d-r' }, headers: { 'x-yeyboats-authorization': `Bearer ${reg.deviceToken}` } })
    assert.ok(asDev.json.webAuth.password)
    const asPublic = await call(cfgRoute, { params: { id: 'yey-d-r' }, headers: { 'x-yeyboats-authorization': `Bearer ${DEV}` } })
    assert.strictEqual(asPublic.status, 401)

    // ---- 9. CSRF: cross-site browser requests to state-changing routes ----
    const rotate = routes.find('POST', '/ui/devices/:id/web-auth/rotate')
    const host = { host: 'signalk.local:3000' }
    const blocked = [
      { ...host, origin: 'http://evil.example' },
      { ...host, origin: 'null' },
      { ...host, 'sec-fetch-site': 'cross-site' },
      { ...host, 'sec-fetch-site': 'same-site' },
      { ...host, referer: 'http://evil.example/page' }
    ]
    for (const headers of blocked) {
      const res = await call(rotate, { method: 'POST', params: { id: 'yey-d-r' }, headers })
      assert.strictEqual(res.status, 403, `blocked ${JSON.stringify(headers)}`)
    }
    const before = manager.webAuthStatus('yey-d-r').rotatedAt
    const allowed = [
      { ...host, origin: 'http://signalk.local:3000', 'sec-fetch-site': 'same-origin' },
      { ...host, referer: 'http://signalk.local:3000/plugins/yey-boats-display-manager/ui' },
      { ...host } // non-browser client (curl, device)
    ]
    for (const headers of allowed) {
      const res = await call(rotate, { method: 'POST', params: { id: 'yey-d-r' }, headers })
      assert.ok(res.status === 303 || res.status === 200, `allowed ${JSON.stringify(headers)} -> ${res.status}`)
    }
    assert.ok(manager.webAuthStatus('yey-d-r').rotatedAt >= before)
    // Reads are not affected.
    assert.strictEqual((await call(routes.find('GET', '/devices'), { headers: { ...host, origin: 'http://evil.example' } })).status, 200)

    // Manager API token UI: ack drops the plaintext; rotate reveals a new one.
    assert.ok(manager.apiToken.pendingReveal())
    const settings = await call(routes.find('GET', '/ui/settings'), {})
    assert.ok(String(settings.body).includes(api), 'settings page shows the pending token')
    await call(routes.find('POST', '/ui/manager-token/ack'), { method: 'POST', headers: host })
    assert.strictEqual(manager.apiToken.pendingReveal(), null)
    assert.ok(!String((await call(routes.find('GET', '/ui/settings'), {})).body).includes(api))
    const xs = await call(routes.find('POST', '/ui/manager-token/rotate'), { method: 'POST', headers: { ...host, origin: 'http://evil.example' } })
    assert.strictEqual(xs.status, 403)
    assert.ok(manager.apiToken.verify(api))
    await call(routes.find('POST', '/ui/manager-token/rotate'), { method: 'POST', headers: host })
    assert.ok(!manager.apiToken.verify(api))
    assert.ok(manager.apiToken.pendingReveal())
  }

  // ---- 10. screenshot proxy: credentials only to the registered port -------
  {
    const mock = mockDisplay()
    const port = await mock.start()
    const other = mockDisplay()
    const otherPort = await other.start()
    try {
      const { manager } = makeSecureManager()
      const api = manager.apiToken.pendingReveal()
      const reg = manager.registerDevice({ device: { id: 'yey-d-shot' } }, bearer(api))
      manager.updateStatus('yey-d-shot', { network: { ip: '127.0.0.1' } }, bearer(reg.deviceToken))
      manager.store.registry.devices['yey-d-shot'].httpPort = port
      const pass = manager.generateConfig('yey-d-shot').webAuth.password
      mock.device.password = pass
      other.device.password = pass
      const proxy = routesFor(manager).find('GET', '/devices/proxy/screenshot.png')
      const ok = await call(proxy, { query: { url: `http://127.0.0.1:${port}` } })
      assert.strictEqual(ok.status, 200)
      assert.strictEqual(mock.device.seen[mock.device.seen.length - 1], basic('yeyboats', pass))
      // Same host, a different port (another service on the device's IP): no credentials.
      const r = await call(proxy, { query: { url: `http://127.0.0.1:${otherPort}` } })
      assert.strictEqual(r.status, 401)
      assert.ok(other.device.seen.length > 0 && other.device.seen.every((h) => h === null))
    } finally { await mock.stop(); await other.stop() }
  }

  // ---- 11. the plugin only enables dev auth from the environment -----------
  {
    const { dataDir } = makeSecureManager()
    const app = { getDataDirPath: () => dataDir, debug () {}, setPluginStatus () {}, setPluginError () {} }
    const opts = {
      auth: { mode: 'dev-shared-token', devAuth: true },
      discoveryUdp: { enabled: false },
      deviceDiscoveryUdp: { enabled: false },
      firmware: { github: { enabled: false } },
      network: { mdns: { browser: false, advertiseManager: false } }
    }
    const saved = process.env.YEYBOATS_MANAGER_DEV_AUTH
    try {
      delete process.env.YEYBOATS_MANAGER_DEV_AUTH
      const plugin = makePlugin(app)
      plugin.start(opts)
      assert.strictEqual(plugin._manager().options.auth.mode, 'device-token', 'config cannot enable dev auth')
      plugin.stop()
      process.env.YEYBOATS_MANAGER_DEV_AUTH = '1'
      const devPlugin = makePlugin(app)
      devPlugin.start(opts)
      assert.strictEqual(devPlugin._manager().options.auth.mode, 'dev-shared-token')
      devPlugin.stop()
    } finally {
      if (saved === undefined) delete process.env.YEYBOATS_MANAGER_DEV_AUTH
      else process.env.YEYBOATS_MANAGER_DEV_AUTH = saved
    }
    const schemaAuth = makePlugin(app).schema().properties.auth.properties
    assert.notStrictEqual(schemaAuth.devToken.default, DEV, 'no public default token in the schema')
  }
})()
