// instruments-manager#23 follow-up (review on PR #24):
//
//   1. The manager API token (or any provisioning token) must not be able to
//      become an existing display: re-registering a known id with it is
//      refused. Re-keying a display is an explicit operator Re-claim, and the
//      display has to prove itself (its current token); its current token keeps
//      working until it has picked up the new one, so nobody can lock it out.
//   2. Displays paired with the old shared token are not sent secrets on
//      start (their stored address may have been set by anyone). They are
//      marked "needs re-claim"; the operator confirms the address per display
//      before the manager pushes its credentials there.
//   3. Operator / state-changing routes need the manager API token (header or
//      UI sign-in cookie), or a SignalK admin session when SignalK security is
//      on. With SignalK security off and no credential they are refused.
const assert = require('assert')
const http = require('http')
const { makeSecureManager, makeManager } = require('./test-utils')
const { YeyBoatsDisplayManager } = require('../lib/manager')
const makePlugin = require('../index')

const DEV = 'yeyboats-dev'
const bearer = (t) => ({ bearer: t, provision: null })

function basic (user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
}

function mockDisplay () {
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
      if (req.method === 'POST' && req.url === '/api/cmd') device.commands.push(body)
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
  })
  return {
    device,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve))
  }
}

function routesFor (manager) {
  const routes = []
  const add = (method) => (p, ...h) => routes.push({ method, p, h: h[h.length - 1] })
  makePlugin._test.registerRoutes({ use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }, () => manager)
  return {
    all: routes,
    find: (method, p) => {
      const r = routes.find((x) => x.method === method && x.p === p)
      assert.ok(r, `${method} ${p} registered`)
      return r
    }
  }
}

function call (route, { method, params = {}, query = {}, headers = {}, body = {}, extra = {} } = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return new Promise((resolve, reject) => {
    const out = {}
    const res = {
      statusCode: 200,
      setHeader (k, v) { out[k.toLowerCase()] = v },
      getHeader (k) { return out[k.toLowerCase()] },
      status (c) { this.statusCode = c; return this },
      json (b) { resolve({ status: this.statusCode, json: b, text: JSON.stringify(b), headers: out }) },
      end (b) { resolve({ status: this.statusCode, body: b, text: String(b || ''), headers: out }) }
    }
    const req = { method: method || route.method, params, query, headers: lower, body, socket: { remoteAddress: '127.0.0.1' }, get: (k) => lower[String(k).toLowerCase()] || '', ...extra }
    Promise.resolve(route.h(req, res)).catch(reject)
  })
}

module.exports = (async () => {
  // ---- 1. the API token cannot become an existing display -----------------
  {
    const { manager } = makeSecureManager({ auth: { provisionToken: 'static-provision-secret' } })
    const api = manager.apiToken.pendingReveal()
    manager.store.settings.ota = { password: 'FLEET-OTA' }
    const a = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(api))
    manager.updateStatus('yey-d-a', { network: { ip: '10.0.0.5' } }, bearer(a.deviceToken))
    const oneTime = manager.createProvisioningToken({ token: 'one-time-secret', uses: 1 })

    for (const auth of [bearer(api), { provision: api }, bearer('static-provision-secret'), { provision: 'static-provision-secret' }]) {
      assert.throws(
        () => manager.registerDevice({ device: { id: 'yey-d-a' }, network: { ip: '10.6.6.6' } }, auth),
        (e) => e.status === 409 && e.payload.error.code === 'reclaim_required',
        `re-register existing id with ${JSON.stringify(auth)} refused`
      )
    }
    assert.throws(() => manager.registerDevice({ device: { id: 'yey-d-a' } }, { provision: oneTime.token }), (e) => e.status === 401 || e.status === 409)
    // ...and the one-time token was not spent on the refused attempt.
    assert.strictEqual(manager.registerDevice({ device: { id: 'yey-d-new' } }, { provision: oneTime.token }).status, 'registered')
    // The real display is unaffected: its token works, its address did not move.
    assert.strictEqual(manager.getDevice('yey-d-a').status.network.ip, '10.0.0.5')
    assert.strictEqual(manager.updateStatus('yey-d-a', { network: { ip: '10.0.0.5' } }, bearer(a.deviceToken)).status, 'ok')
    assert.ok(!JSON.stringify(manager.deviceConfigFor('yey-d-a', bearer(api))).includes('FLEET-OTA'))

    // A discovery sighting (unauthenticated) of a registered id cannot be
    // "claimed" over it: that would move its address and push it a token.
    manager.recordDiscoveredDevice({ id: 'yey-d-a', address: '10.9.9.9', port: 8080 })
    assert.throws(() => manager.claimDiscoveredDevice('yey-d-a', { profileId: 'default', issueToken: true }), (e) => e.status === 409 && e.payload.error.code === 'reclaim_required')
    assert.strictEqual(manager.secrets.pendingManagerToken('yey-d-a'), null)
    assert.ok(!JSON.stringify(manager.deviceDeliveryTargets(manager.getDevice('yey-d-a'))).includes('10.9.9.9'))

    // Explicit operator Re-claim: no token in the result; the display proves
    // itself with its current token and collects the new one.
    const rc = manager.reclaimDevice('yey-d-a', {})
    assert.strictEqual(rc.status, 'pending')
    assert.strictEqual(rc.deviceToken, undefined)
    const hb = manager.updateStatus('yey-d-a', {}, bearer(a.deviceToken))
    assert.strictEqual(hb.requestedReregister, true, 'heartbeat asks the display to re-register')
    assert.throws(() => manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(api)), (e) => e.status === 409)
    const re = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(a.deviceToken))
    assert.ok(re.deviceToken && re.deviceToken !== a.deviceToken)
    // Old token still valid until the new one is used -> no lock-out window.
    assert.strictEqual(manager.updateStatus('yey-d-a', {}, bearer(a.deviceToken)).status, 'ok')
    const hb2 = manager.updateStatus('yey-d-a', {}, bearer(re.deviceToken))
    assert.strictEqual(hb2.status, 'ok')
    assert.ok(!hb2.requestedReregister)
    assert.throws(() => manager.updateStatus('yey-d-a', {}, bearer(a.deviceToken)), (e) => e.status === 401)
    assert.strictEqual(manager.secrets.pendingManagerToken('yey-d-a'), null)
    assert.strictEqual(manager.authStatus('yey-d-a').reclaim.state, 'done')

    // Token rotation is the same Re-claim: no plaintext token returned.
    const rot = manager.rotateDeviceToken('yey-d-a')
    assert.strictEqual(rot.deviceToken, undefined)
    assert.strictEqual(manager.updateStatus('yey-d-a', {}, bearer(re.deviceToken)).requestedReregister, true)

    // The Claim / Re-claim flow carries a pairing code slot (on-screen code,
    // firmware pending): until displays can show one it is refused, never ignored.
    assert.throws(() => manager.reclaimDevice('yey-d-a', { pairingCode: '123456' }), (e) => e.status === 501)
  }

  // ---- 2. migration: no secrets pushed on start; operator confirms address --
  {
    const mock = mockDisplay()
    const port = await mock.start()
    try {
      const old = makeManager({ auth: { mode: 'dev-shared-token' } })
      old.manager.registerDevice({ device: { id: 'yey-d-old' } }, bearer(DEV))
      // Before the upgrade anyone holding the public token could set this.
      old.manager.updateStatus('yey-d-old', { network: { ip: '10.6.6.6' } }, bearer(DEV))
      const webPass = old.manager.generateConfig('yey-d-old').webAuth.password
      mock.device.password = webPass
      old.manager.close()

      const manager = new YeyBoatsDisplayManager(old.app, { ...old.manager.options, auth: { mode: 'dev-shared-token' } })
      try {
        const sent = []
        const realPost = manager._postDeviceCommand.bind(manager)
        manager._postDeviceCommand = async (host, p, line, auth) => { sent.push({ host, p, line, auth }); return realPost(host, p, line, auth) }
        await manager.pushPendingManagerTokens()
        assert.strictEqual(sent.length, 0, 'nothing sent to the stored (possibly poisoned) address')
        assert.strictEqual(manager.secrets.pendingManagerToken('yey-d-old'), null)
        assert.strictEqual(manager.authStatus('yey-d-old').tokenMigration.state, 'needs-reclaim')
        // The legacy token keeps the display online (restricted) and triggers nothing.
        assert.strictEqual(manager.updateStatus('yey-d-old', {}, bearer(DEV)).status, 'ok')
        await new Promise((resolve) => setTimeout(resolve, 20))
        assert.strictEqual(sent.length, 0)

        // The operator sees it with its address and last-seen info.
        const list = manager.reclaimCandidates()
        const c = list.find((d) => d.id === 'yey-d-old')
        assert.ok(c, 'listed as needing re-claim')
        assert.strictEqual(c.address, `10.6.6.6:80`)
        assert.ok(c.lastSeen)
        // No proof is possible for a legacy display: the operator must confirm an address.
        assert.throws(() => manager.reclaimDevice('yey-d-old', {}), (e) => e.status === 409 && e.payload.error.code === 'confirm_address_required')
        assert.strictEqual(sent.length, 0)

        // Confirmed (operator-corrected) address: credentials go there only.
        const rc = manager.reclaimDevice('yey-d-old', { confirmAddress: `127.0.0.1:${port}` })
        assert.strictEqual(rc.status, 'pending')
        assert.strictEqual(rc.address, `127.0.0.1:${port}`)
        const delivered = await manager.pushDeviceManagerToken('yey-d-old')
        assert.strictEqual(delivered.status, 'delivered')
        assert.ok(sent.every((s) => s.host === '127.0.0.1' && s.p === port), JSON.stringify(sent.map((s) => `${s.host}:${s.p}`)))
        const tok = mock.device.commands[0].replace(/^manager-token /, '')
        assert.ok(tok && tok !== DEV)
        assert.strictEqual(mock.device.seen[mock.device.seen.length - 1], basic('yeyboats', webPass))
        assert.strictEqual(manager.updateStatus('yey-d-old', { network: { ip: '127.0.0.1' } }, bearer(tok)).status, 'ok')
        assert.strictEqual(manager.authStatus('yey-d-old').tokenMigration.state, 'done')
        assert.throws(() => manager.updateStatus('yey-d-old', {}, bearer(DEV)), (e) => e.status === 401)
      } finally { manager.close() }
    } finally { await mock.stop() }
  }

  // ---- 3. operator routes need a credential when SignalK security is off ---
  {
    const { manager, app } = makeSecureManager()
    const api = manager.apiToken.pendingReveal()
    const reg = manager.registerDevice({ device: { id: 'yey-d-r' } }, bearer(api))
    const routes = routesFor(manager)
    const host = { host: 'signalk.local:3000' }
    const op = { ...host, 'x-yeyboats-authorization': `Bearer ${api}` }
    const rotate = routes.find('POST', '/devices/:id/tokens/rotate')
    const tokRotate = routes.find('POST', '/ui/manager-token/rotate')
    const settings = routes.find('GET', '/ui/settings')

    const securityStates = [
      ['no strategy', undefined],
      ['dummy strategy', { isDummy: () => true, allowConfigure: () => true }]
    ]
    for (const [label, strategy] of securityStates) {
      app.securityStrategy = strategy
      const r = await call(rotate, { params: { id: 'yey-d-r' }, headers: host })
      assert.strictEqual(r.status, 401, `${label}: rotate without credential refused`)
      assert.ok(!/dev_/.test(r.text))
      const t = await call(tokRotate, { headers: host })
      assert.ok(t.status === 401 || t.status === 303, `${label}: API token rotate refused (${t.status})`)
      if (t.status === 303) assert.ok(/\/ui\/login/.test(t.headers.location))
      assert.ok(manager.apiToken.verify(api), `${label}: API token not rotated`)
      const s = await call(settings, { headers: host })
      assert.ok(!s.text.includes(api), `${label}: settings page does not reveal the token`)
      // A form post from the UI is sent to the sign-in page.
      const f = await call(routes.find('POST', '/ui/settings'), { headers: { ...host, 'content-type': 'application/x-www-form-urlencoded' }, body: { ssid: 'x' } })
      assert.strictEqual(f.status, 303)
      assert.ok(/\/ui\/login/.test(f.headers.location))
    }
    app.securityStrategy = undefined

    // Every state-changing route except the device-facing ones is guarded.
    const deviceFacing = new Set([
      'POST /devices/register', 'POST /devices/:id/status', 'POST /devices/:id/commands/:commandId/ack',
      'POST /devices/:id/firmware/jobs/:jobId/progress', 'POST /devices/:id/firmware/confirm',
      'POST /discovery/devices', 'POST /ui/login', 'POST /ui/logout'
    ])
    for (const r of routes.all.filter((x) => x.method !== 'GET' && !deviceFacing.has(`${x.method} ${x.p}`))) {
      const res = await call(r, { params: { id: 'yey-d-r', screenId: 'x', widgetId: 'x', commandId: 'x', jobId: 'x', groupId: 'x', artifactId: 'x' }, headers: host })
      assert.strictEqual(res.status, 401, `${r.method} ${r.p} without credential -> ${res.status}`)
    }
    // Device-facing routes keep working with the device's own token.
    const hb = await call(routes.find('POST', '/devices/:id/status'), { params: { id: 'yey-d-r' }, headers: { ...host, 'x-yeyboats-authorization': `Bearer ${reg.deviceToken}` }, body: {} })
    assert.strictEqual(hb.status, 200)

    // With the manager API token: allowed; rotation does not return the token.
    const ok = await call(rotate, { params: { id: 'yey-d-r' }, headers: op })
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(ok.json.deviceToken, undefined)
    assert.ok(!ok.text.includes('dev_'))
    // The display's own token is not an operator credential.
    assert.strictEqual((await call(rotate, { params: { id: 'yey-d-r' }, headers: { ...host, 'x-yeyboats-authorization': `Bearer ${reg.deviceToken}` } })).status, 401)

    // UI sign-in: the token sets an HttpOnly SameSite cookie that authorises the UI.
    const login = routes.find('POST', '/ui/login')
    const bad = await call(login, { headers: { ...host, 'content-type': 'application/x-www-form-urlencoded' }, body: { token: 'nope' } })
    assert.strictEqual(bad.status, 401)
    const good = await call(login, { headers: { ...host, 'content-type': 'application/x-www-form-urlencoded' }, body: { token: api } })
    assert.strictEqual(good.status, 303)
    const cookie = String(good.headers['set-cookie'])
    assert.ok(/HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie), cookie)
    const pair = cookie.split(';')[0]
    const viaCookie = await call(settings, { headers: { ...host, cookie: pair } })
    assert.ok(viaCookie.text.includes(api), 'signed-in operator sees the pending token')
    const ack = await call(routes.find('POST', '/ui/manager-token/ack'), { headers: { ...host, cookie: pair } })
    assert.strictEqual(ack.status, 303)
    assert.strictEqual(manager.apiToken.pendingReveal(), null)

    // SignalK security on: an admin session is an operator; others are not.
    app.securityStrategy = {
      isDummy: () => false,
      allowConfigure: (req) => Boolean(req.skIsAuthenticated && req.skPrincipal && req.skPrincipal.permissions === 'admin')
    }
    const asAdmin = await call(rotate, { params: { id: 'yey-d-r' }, headers: host, extra: { skIsAuthenticated: true, skPrincipal: { identifier: 'admin', permissions: 'admin' } } })
    assert.strictEqual(asAdmin.status, 200)
    const asRw = await call(rotate, { params: { id: 'yey-d-r' }, headers: host, extra: { skIsAuthenticated: true, skPrincipal: { identifier: 'crew', permissions: 'readwrite' } } })
    assert.strictEqual(asRw.status, 401)
    assert.strictEqual((await call(rotate, { params: { id: 'yey-d-r' }, headers: host })).status, 401)
    assert.strictEqual((await call(rotate, { params: { id: 'yey-d-r' }, headers: op })).status, 200, 'API token works with security on too')
  }
})()
