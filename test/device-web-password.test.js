// instruments-manager#19: per-device web API passwords.
//
// The display firmware enforces HTTP Basic Auth on /api/* as soon as a web
// password is provisioned (instruments#21/#28). The manager used to push the
// SAME hard-coded password to every display, so anyone on the boat LAN who knew
// it could drive any display. These tests pin the replacement:
//
//   - a random, URL-safe, >=128-bit password is generated per device at pairing
//   - it lives in a 0600 secrets file in the plugin data dir (not registry.json)
//   - it is the password in that device's generated config and the one every
//     device HTTP call presents
//   - it can be rotated from the device page
//   - devices paired before this change (still on the old shared password) are
//     migrated on next contact: reached with the old password, pushed a new one
//     through the config pull, the new one persisted and verified
//   - the password never reaches logs, the audit trail or the admin JSON
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { makeManager } = require('./test-utils')
const makePlugin = require('../index')

const { LEGACY_SHARED_WEB_PASSWORD: LEGACY } = require('../lib/device-secrets')

function basic (user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

// Minimal display: enforces Basic Auth with `device.password` (null = setup
// open) and records every Authorization header it receives.
function mockDisplay () {
  const device = { username: 'yeyboats', password: null, seen: [] }
  const server = http.createServer((req, res) => {
    device.seen.push(req.headers.authorization || null)
    if (device.password && req.headers.authorization !== basic(device.username, device.password)) {
      res.statusCode = 401
      res.setHeader('www-authenticate', 'Basic realm="espdisp"')
      res.end('auth required')
      return
    }
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/api/state')) {
      res.end(JSON.stringify({ sk: { state: 'live' }, webAuth: { enabled: Boolean(device.password) } }))
      return
    }
    if (req.url.startsWith('/api/logs')) {
      res.end(JSON.stringify({ entries: [], lastSeq: 0 }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  return {
    device,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve))
  }
}

function pointAt (manager, port) {
  manager.deviceHttpCandidates = () => [`http://127.0.0.1:${port}`]
  manager.deviceHttpBase = () => `http://127.0.0.1:${port}`
}

function captureLogs (fn) {
  const lines = []
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info }
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.join(' ')); orig[k](...a) }
  return Promise.resolve().then(fn).finally(() => Object.assign(console, orig)).then(() => lines)
}

function allFiles (dir) {
  return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }))
}

module.exports = (async () => {
  // ---- 1. pairing issues a distinct random password per device -----------
  {
    const debug = []
    const { manager, auth, dataDir, app } = makeManager({
      auth: { mode: 'dev-shared-token', devToken: 'test-token' }
    })
    app.debug = (m) => debug.push(String(m))
    manager.registerDevice({ device: { id: 'yey-d-a' } }, auth)
    manager.registerDevice({ device: { id: 'yey-d-b' } }, auth)
    const a = manager.generateConfig('yey-d-a').webAuth
    const b = manager.generateConfig('yey-d-b').webAuth
    for (const w of [a, b]) {
      assert.strictEqual(w.enabled, true)
      assert.strictEqual(typeof w.password, 'string')
      assert.ok(/^[A-Za-z0-9_-]+$/.test(w.password), 'password is URL-safe')
      // >= 128 bits of entropy in base64url is >= 22 chars; firmware caps at 63.
      assert.ok(w.password.length >= 22 && w.password.length <= 63, `length ${w.password.length}`)
      assert.notStrictEqual(w.password, LEGACY)
    }
    assert.notStrictEqual(a.password, b.password, 'passwords are per device')
    // Stable across config generations (the config hash must not churn).
    assert.strictEqual(manager.generateConfig('yey-d-a').webAuth.password, a.password)

    // Stored in a 0600 secrets file in the plugin data dir...
    const secretsFile = path.join(dataDir, 'device-secrets.json')
    assert.ok(fs.existsSync(secretsFile), 'device-secrets.json written')
    assert.strictEqual(fs.statSync(secretsFile).mode & 0o777, 0o600)
    // ...and nowhere else on disk (registry, audit log, ...).
    for (const f of allFiles(dataDir)) {
      if (f.name === 'device-secrets.json') continue
      assert.ok(!f.text.includes(a.password), `password leaked into ${f.name}`)
    }
    // Admin JSON surfaces never echo it.
    assert.ok(!JSON.stringify(manager.getDevice('yey-d-a')).includes(a.password))
    assert.ok(!JSON.stringify(manager.authStatus('yey-d-a')).includes(a.password))
    const st = manager.webAuthStatus('yey-d-a')
    assert.strictEqual(st.passwordSet, true)
    assert.strictEqual(st.password, undefined)
    assert.ok(!debug.some((l) => l.includes(a.password)))

    // Survives a restart (loaded from the secrets file).
    const { YeyBoatsDisplayManager } = require('../lib/manager')
    const again = new YeyBoatsDisplayManager(app, manager.options)
    assert.strictEqual(again.generateConfig('yey-d-a').webAuth.password, a.password)

    // Deleting the device drops its secret.
    manager.deleteDevice('yey-d-b')
    assert.ok(!fs.readFileSync(secretsFile, 'utf8').includes(b.password))
  }

  // ---- 2. every device HTTP call presents the per-device password --------
  {
    const mock = mockDisplay()
    const port = await mock.start()
    try {
      const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
      manager.registerDevice({ device: { id: 'yey-d-live' } }, auth)
      pointAt(manager, port)
      const pass = manager.generateConfig('yey-d-live').webAuth.password
      mock.device.password = pass // device applied its config
      const status = await manager.getLiveStatus('yey-d-live')
      assert.strictEqual(status.sk.state, 'live')
      await manager.getLiveLogs('yey-d-live', 3)
      assert.ok(mock.device.seen.every((h) => h === basic('yeyboats', pass)))
      assert.ok(!mock.device.seen.includes(basic('yeyboats', LEGACY)), 'legacy never sent to a new device')
    } finally { await mock.stop() }
  }

  // ---- 3. migration of a device still on the old shared password ---------
  {
    const mock = mockDisplay()
    const port = await mock.start()
    try {
      const { manager, auth, dataDir } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
      manager.registerDevice({ device: { id: 'yey-d-old' } }, auth)
      // Simulate a pre-#19 install: no per-device secret on file, device on legacy.
      fs.unlinkSync(path.join(dataDir, 'device-secrets.json'))
      manager.secrets.load()
      mock.device.password = LEGACY
      pointAt(manager, port)
      manager.updateStatus('yey-d-old', { network: { ip: '127.0.0.1' }, config: { hash: 'legacy' } }, auth)

      const logs = await captureLogs(async () => {
        // Next contact: reachable with the old password (fallback)...
        const live = await manager.getLiveStatus('yey-d-old')
        assert.strictEqual(live.sk.state, 'live')
        assert.ok(mock.device.seen.includes(basic('yeyboats', LEGACY)))

        // ...and the heartbeat tells it to pull a config carrying a NEW password.
        const cfg = manager.generateConfig('yey-d-old')
        assert.notStrictEqual(cfg.webAuth.password, LEGACY)
        const hb = manager.updateStatus('yey-d-old', { config: { hash: 'legacy' } }, auth)
        assert.strictEqual(hb.desiredConfig.reload, true)
        assert.strictEqual(manager.webAuthStatus('yey-d-old').state, 'pending')

        // Device pulls + applies it, then reports the new hash: manager verifies.
        mock.device.password = cfg.webAuth.password
        manager.updateStatus('yey-d-old', { config: { hash: cfg.hash } }, auth)
        assert.strictEqual(await manager.pendingWebAuthVerification('yey-d-old'), true)
        const st = manager.webAuthStatus('yey-d-old')
        assert.strictEqual(st.state, 'verified')
        assert.strictEqual(st.fallbacks, 0)

        // After verification the old password is never presented again.
        mock.device.seen.length = 0
        mock.device.password = 'something-else' // even if the device lost it
        await assert.rejects(() => manager.getLiveStatus('yey-d-old'), (e) => e.status === 401)
        assert.ok(!mock.device.seen.includes(basic('yeyboats', LEGACY)))
        return cfg.webAuth.password
      })
      const newPass = manager.generateConfig('yey-d-old').webAuth.password
      assert.ok(!logs.some((l) => l.includes(newPass) || l.includes(LEGACY)), 'password logged')
    } finally { await mock.stop() }
  }

  // ---- 4. verification failure keeps the fallback --------------------------
  {
    const mock = mockDisplay()
    const port = await mock.start()
    try {
      const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
      manager.registerDevice({ device: { id: 'yey-d-rot' } }, auth)
      pointAt(manager, port)
      const first = manager.generateConfig('yey-d-rot')
      mock.device.password = first.webAuth.password
      manager.updateStatus('yey-d-rot', { config: { hash: first.hash } }, auth)
      assert.strictEqual(await manager.pendingWebAuthVerification('yey-d-rot'), true)

      // ---- rotation from the device page -----------------------------------
      const rotated = manager.rotateDeviceWebPassword('yey-d-rot')
      assert.ok(!JSON.stringify(rotated).includes(first.webAuth.password))
      assert.strictEqual(rotated.state, 'pending')
      assert.ok(rotated.command && rotated.command.type === 'config.reload', 'reload queued')
      const second = manager.generateConfig('yey-d-rot')
      assert.notStrictEqual(second.webAuth.password, first.webAuth.password)
      assert.notStrictEqual(second.hash, first.hash)

      // Device has not applied it yet: still reachable via the previous one.
      const live = await manager.getLiveStatus('yey-d-rot')
      assert.strictEqual(live.sk.state, 'live')
      // A heartbeat on the new hash whose verify fails keeps the fallback.
      manager.updateStatus('yey-d-rot', { config: { hash: second.hash } }, auth)
      assert.strictEqual(await manager.pendingWebAuthVerification('yey-d-rot'), false)
      assert.strictEqual(manager.webAuthStatus('yey-d-rot').state, 'pending')
      mock.device.password = second.webAuth.password
      manager.updateStatus('yey-d-rot', { config: { hash: second.hash } }, auth)
      assert.strictEqual(await manager.pendingWebAuthVerification('yey-d-rot'), true)
      assert.strictEqual(manager.webAuthStatus('yey-d-rot').state, 'verified')
    } finally { await mock.stop() }
  }

  // ---- 5. device page offers rotation; the route works -------------------
  {
    const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
    manager.registerDevice({ device: { id: 'yey-d-ui' } }, auth)
    const pass = manager.generateConfig('yey-d-ui').webAuth.password
    const html = makePlugin.__renderDevicePage(manager, 'yey-d-ui')
    assert.ok(html.includes('/ui/devices/yey-d-ui/web-auth/rotate'), 'rotate form on device page')
    assert.ok(!html.includes(pass), 'device page never renders the password')

    const routes = []
    const add = (method) => (p, ...h) => routes.push({ method, p, h: h[h.length - 1] })
    const router = { use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }
    makePlugin._test.registerRoutes(router, () => manager)
    const r = routes.find((x) => x.method === 'POST' && x.p === '/ui/devices/:id/web-auth/rotate')
    assert.ok(r, 'POST /ui/devices/:id/web-auth/rotate registered')
    await new Promise((resolve, reject) => {
      const res = { statusCode: 200, setHeader () {}, status (c) { this.statusCode = c; return this }, json: reject, end: resolve }
      Promise.resolve(r.h({ params: { id: 'yey-d-ui' }, headers: {}, body: {}, query: {}, get: () => '' }, res)).catch(reject)
    })
    assert.notStrictEqual(manager.generateConfig('yey-d-ui').webAuth.password, pass)
    const api = routes.find((x) => x.method === 'POST' && x.p === '/devices/:id/web-auth/rotate')
    assert.ok(api, 'POST /devices/:id/web-auth/rotate registered')
  }

  // ---- 6. the hard-coded shared password is gone from the plugin --------
  {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
    const schemaBlock = index.slice(index.indexOf('deviceWebAuth: {'), index.indexOf('discoveryUdp: {'))
    assert.ok(!/password\s*:/.test(schemaBlock), 'no shared device password in plugin schema')
    const { manager } = makeManager({})
    assert.strictEqual(manager.options.deviceWebAuth.password, undefined)
  }
})()
