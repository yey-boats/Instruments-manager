// instruments-manager#25 (follow-ups from the re-review of #24):
//
//   1. Re-claim race: whoever holds a display's current token (possibly a thief)
//      can collect the pending new token. It is handed out ONCE per Re-claim,
//      never re-minted while one is pending, and the operator can cancel it.
//      For a compromised token the UI says: Revoke, then confirm the address.
//   2. A display that can show an on-screen pairing code must be re-claimed
//      with it (proof of physical presence); the token goes to the confirmed
//      address's pairing endpoint together with the code.
//   3. Anonymous sightings (/devices/register without a valid credential) and
//      failed UI sign-ins are capped / rate-limited: they cannot grow the
//      discovery file or the audit log without bound.
//   4. public/provision.js explains a 401 (sign in) instead of 'payload HTTP 401'.
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const path = require('path')
const vm = require('vm')
const { makeSecureManager } = require('./test-utils')
const makePlugin = require('../index')

const bearer = (t) => ({ bearer: t, provision: null })

function routesFor (manager) {
  const routes = []
  const add = (method) => (p, ...h) => routes.push({ method, p, h: h[h.length - 1] })
  makePlugin._test.registerRoutes({ use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }, () => manager)
  return (method, p) => {
    const r = routes.find((x) => x.method === method && x.p === p)
    assert.ok(r, `${method} ${p} registered`)
    return r
  }
}

function call (route, { params = {}, query = {}, headers = {}, body = {}, remoteAddress = '127.0.0.1' } = {}) {
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
    const req = { method: route.method, params, query, headers: lower, body, socket: { remoteAddress }, get: (k) => lower[String(k).toLowerCase()] || '' }
    Promise.resolve(route.h(req, res)).catch(reject)
  })
}

function auditLines (manager, type) {
  let text = ''
  try { text = fs.readFileSync(manager.store.auditFile, 'utf8') } catch (e) {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type)
}

function mockPairingDisplay (code) {
  const device = { pairs: [], commands: [] }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/pair') {
        let parsed = {}
        try { parsed = JSON.parse(body) } catch (e) {}
        device.pairs.push(parsed)
        res.statusCode = parsed.code === code ? 200 : 403
        res.end('{}')
        return
      }
      if (req.method === 'POST' && req.url === '/api/cmd') device.commands.push(body)
      res.end('{"ok":true}')
    })
  })
  return {
    device,
    start: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => server.close(resolve))
  }
}

module.exports = (async () => {
  // ---- 1. one pending Re-claim per device; its token is handed out once -----
  {
    const { manager } = makeSecureManager()
    const route = routesFor(manager)
    const api = manager.apiToken.pendingReveal()
    const op = { authorization: `Bearer ${api}` }
    const a = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(api))
    const old = a.deviceToken

    const rc = manager.reclaimDevice('yey-d-a', {})
    assert.strictEqual(rc.status, 'pending')
    const pendingHash = manager.getDevice('yey-d-a').pendingTokenHash
    // A second Re-claim while one is pending does not mint another token.
    assert.throws(() => manager.reclaimDevice('yey-d-a', {}),
      (e) => e.status === 409 && e.payload.error.code === 'reclaim_pending')
    assert.throws(() => manager.rotateDeviceToken('yey-d-a'),
      (e) => e.status === 409 && e.payload.error.code === 'reclaim_pending')
    assert.strictEqual(manager.getDevice('yey-d-a').pendingTokenHash, pendingHash)

    // First collection with the current token: the new token.
    const first = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(old))
    assert.ok(first.deviceToken && first.deviceToken !== old)
    // The old-token holder cannot collect it (or another one) again.
    const second = manager.registerDevice({ device: { id: 'yey-d-a' } }, bearer(old))
    assert.strictEqual(second.deviceToken, undefined, 'the pending token is handed out once')
    assert.ok(!manager.updateStatus('yey-d-a', {}, bearer(old)).requestedReregister,
      'no re-register request once the token was collected')
    assert.strictEqual(manager.authStatus('yey-d-a').reclaim.state, 'issued')

    // The operator cancels the pending Re-claim: the collected token is dead,
    // the current token keeps the display online.
    const cancelled = await call(route('DELETE', '/devices/:id/reclaim'), { params: { id: 'yey-d-a' }, headers: op })
    assert.strictEqual(cancelled.status, 200, cancelled.text)
    assert.strictEqual(cancelled.json.status, 'cancelled')
    assert.throws(() => manager.updateStatus('yey-d-a', {}, bearer(first.deviceToken)), (e) => e.status === 401)
    assert.strictEqual(manager.updateStatus('yey-d-a', {}, bearer(old)).status, 'ok')
    assert.strictEqual(manager.secrets.pendingManagerToken('yey-d-a'), null)
    assert.strictEqual(manager.authStatus('yey-d-a').reclaim.state, 'cancelled')
    assert.strictEqual(auditLines(manager, 'device.reclaim.cancelled').length, 1)
    // Nothing to cancel now.
    assert.throws(() => manager.cancelReclaim('yey-d-a'), (e) => e.status === 409)

    // A new Re-claim is possible after cancelling.
    assert.strictEqual(manager.reclaimDevice('yey-d-a', {}).status, 'pending')
    // UI cancel route.
    const uiCancel = await call(route('POST', '/ui/devices/:id/reclaim/cancel'), { params: { id: 'yey-d-a' }, headers: op })
    assert.strictEqual(uiCancel.status, 303)
    assert.ok(/status=reclaim-cancelled/.test(uiCancel.headers.location), uiCancel.headers.location)

    // Device page: says what to do for a compromised token, and offers
    // Revoke (UI) and Cancel for a pending Re-claim.
    manager.reclaimDevice('yey-d-a', {})
    const page = await call(route('GET', '/ui/devices/:id'), { params: { id: 'yey-d-a' }, headers: op })
    assert.ok(/stolen|compromised/i.test(page.text), 'device page explains the compromised-token case')
    assert.ok(/Revoke/.test(page.text) && /confirm/i.test(page.text))
    assert.ok(page.text.includes('/ui/devices/yey-d-a/reclaim/cancel'), 'Cancel action for the pending Re-claim')
    assert.ok(page.text.includes('/ui/devices/yey-d-a/tokens/revoke'), 'Revoke action')
    const uiRevoke = await call(route('POST', '/ui/devices/:id/tokens/revoke'), { params: { id: 'yey-d-a' }, headers: op })
    assert.strictEqual(uiRevoke.status, 303)
    assert.throws(() => manager.updateStatus('yey-d-a', {}, bearer(old)), (e) => e.status === 401)
    // ...after which the display is a confirm-address candidate.
    assert.ok(manager.reclaimCandidates().some((c) => c.id === 'yey-d-a'))
    manager.close()
  }

  // ---- 2. a display with an on-screen pairing code is re-claimed with it ----
  {
    const code = '7Q2KX9PM'
    const mock = mockPairingDisplay(code)
    const port = await mock.start()
    const { manager } = makeSecureManager()
    try {
      const api = manager.apiToken.pendingReveal()
      const a = manager.registerDevice({ device: { id: 'yey-d-p', capabilities: { pairingCode: true } } }, bearer(api))
      const old = a.deviceToken
      // Old-token collection is not offered for such a display.
      assert.throws(() => manager.reclaimDevice('yey-d-p', {}),
        (e) => e.status === 409 && e.payload.error.code === 'pairing_code_required')
      assert.throws(() => manager.reclaimDevice('yey-d-p', { pairingCode: code }),
        (e) => e.status === 409 && e.payload.error.code === 'confirm_address_required')
      assert.strictEqual(manager.getDevice('yey-d-p').pendingTokenHash, undefined)
      assert.ok(!manager.updateStatus('yey-d-p', {}, bearer(old)).requestedReregister)

      const rc = manager.reclaimDevice('yey-d-p', { pairingCode: code, confirmAddress: `127.0.0.1:${port}` })
      assert.strictEqual(rc.method, 'pairing-code')
      assert.strictEqual(rc.deviceToken, undefined)
      assert.strictEqual(JSON.stringify(rc).includes(code), false, 'the code is not echoed back')
      const delivered = await manager.pushDeviceManagerToken('yey-d-p')
      assert.strictEqual(delivered.status, 'delivered', JSON.stringify(delivered))
      assert.strictEqual(mock.device.pairs.length, 1)
      assert.strictEqual(mock.device.pairs[0].code, code)
      const tok = mock.device.pairs[0].manager_token
      assert.ok(tok && tok !== old)
      assert.strictEqual(mock.device.commands.length, 0, 'not sent with manager-token over /api/cmd')
      assert.strictEqual(manager.updateStatus('yey-d-p', {}, bearer(tok)).status, 'ok')
      assert.throws(() => manager.updateStatus('yey-d-p', {}, bearer(old)), (e) => e.status === 401)
      assert.ok(!JSON.stringify(manager.getDevice('yey-d-p')).includes(code), 'code not persisted')

      // A wrong code: the display refuses, the delivery fails.
      manager.reclaimDevice('yey-d-p', { pairingCode: 'WRONG000', confirmAddress: `127.0.0.1:${port}` })
      const failed = await manager.pushDeviceManagerToken('yey-d-p')
      assert.strictEqual(failed.status, 'failed')
    } finally { manager.close(); await mock.stop() }

    // Firmware without pairing codes: a code is still refused, never ignored.
    const { manager: m2 } = makeSecureManager()
    m2.registerDevice({ device: { id: 'yey-d-q' } }, bearer(m2.apiToken.pendingReveal()))
    assert.throws(() => m2.reclaimDevice('yey-d-q', { pairingCode: '123456' }), (e) => e.status === 501)
    m2.close()
  }

  // ---- 3. anonymous sightings and failed sign-ins are bounded ---------------
  {
    const { manager } = makeSecureManager()
    const route = routesFor(manager)
    let writes = 0
    const save = manager.store.saveDiscovery.bind(manager.store)
    manager.store.saveDiscovery = () => { writes++; save() }
    const reg = route('POST', '/devices/register')
    const silent = (p) => p.catch(() => {})
    // One address, 3000 bogus ids.
    for (let i = 0; i < 3000; i++) {
      await silent(call(reg, { body: { device: { id: `bogus-${i}` } }, remoteAddress: '10.1.1.1' }))
    }
    assert.ok(writes <= 10, `one address: ${writes} discovery writes`)
    // 3000 addresses.
    for (let i = 0; i < 3000; i++) {
      await silent(call(reg, { body: { device: { id: `spray-${i}` } }, remoteAddress: `10.2.${i >> 8}.${i & 255}` }))
    }
    const count = Object.keys(manager.store.discovery.devices).length
    assert.ok(count >= 1 && count <= 100, `${count} discovery records`)
    assert.ok(writes <= 100, `${writes} discovery writes`)
    assert.ok(auditLines(manager, 'device.discovered').length <= 100)

    // Failed UI sign-ins: audit appends are rate-limited.
    const login = route('POST', '/ui/login')
    for (let i = 0; i < 500; i++) {
      await call(login, { body: { token: `nope-${i}` } })
    }
    const failedLogins = auditLines(manager, 'manager.login.failed')
    assert.ok(failedLogins.length >= 1 && failedLogins.length <= 20, `${failedLogins.length} failed-login audit lines`)
    manager.close()
  }

  // ---- 4. provision.js: a 401 says "sign in", with a link -----------------
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'provision.js'), 'utf8')
    const els = {}
    const mk = (id) => ({
      id,
      textContent: '',
      children: [],
      disabled: false,
      scrollTop: 0,
      scrollHeight: 0,
      listeners: {},
      appendChild (c) { this.children.push(c); return c },
      addEventListener (t, f) { this.listeners[t] = f },
      insertAdjacentElement (where, c) { els[c.id || 'x'] = c; return c },
      setAttribute (k, v) { this[k] = v }
    })
    els['prov-log'] = mk('prov-log')
    els.provision = mk('provision')
    const document = {
      readyState: 'complete',
      getElementById: (id) => els[id] || null,
      createElement: (tag) => Object.assign(mk(''), { tagName: tag.toUpperCase() }),
      addEventListener () {}
    }
    const ctx = {
      document,
      navigator: { serial: { requestPort: () => { throw new Error('should not get here') } } },
      location: { pathname: '/plugins/yey-boats-display-manager/flash.html' },
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      setTimeout,
      console
    }
    ctx.window = ctx
    vm.runInNewContext(src, ctx)
    await els.provision.listeners.click()
    const log = els['prov-log'].textContent
    assert.ok(!/payload HTTP 401/.test(log), log)
    assert.ok(/sign in/i.test(log), log)
    const hint = els['prov-signin']
    assert.ok(hint, 'a sign-in hint element is shown')
    const link = JSON.stringify(hint)
    assert.ok(link.includes('/plugins/yey-boats-display-manager/ui/login'), link)
  }
})()
