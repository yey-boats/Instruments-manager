// MGR-3: GET /firmware/download/:jobId must not relay firmware bytes to the
// device unless the fetched body matches the recorded file.sha256.
//
// The route now resolves through manager.firmwareArtifactBinary (the same
// sha-verified path the browser-flash route uses). This test drives the REAL
// route (via registerRoutes + a minimal router shim) for a job whose artifact
// records one sha but whose upstream asset hashes to another, and asserts the
// device gets a 5xx error and ZERO firmware bytes.
const assert = require('assert')
const crypto = require('crypto')
const { makeManager } = require('./test-utils')
const { registerRoutes } = require('../index')._test

// --- minimal express-compatible router shim -----------------------------
function makeShim (getManager) {
  const routes = []
  const middleware = []
  const seg = (p) => p.split('/').filter(Boolean)
  const add = (method) => (p, ...h) => routes.push({ method, s: seg(p), handler: h[h.length - 1] })
  const router = {
    use: (fn) => middleware.push(fn),
    get: add('GET'),
    post: add('POST'),
    patch: add('PATCH'),
    put: add('PUT'),
    delete: add('DELETE')
  }
  registerRoutes(router, getManager)
  router.dispatch = (method, url, headers) => new Promise((resolve) => {
    const parts = seg(url)
    let m = null
    for (const r of routes) {
      if (r.method !== method || r.s.length !== parts.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < r.s.length; i++) {
        const s = r.s[i]
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i])
        else if (s !== parts[i]) { ok = false; break }
      }
      if (ok) { m = { r, params }; break }
    }
    let ended = false
    const chunks = []
    const res = {
      statusCode: 200,
      _json: undefined,
      _headers: {},
      status (c) { this.statusCode = c; return this },
      setHeader (k, v) { this._headers[String(k).toLowerCase()] = v },
      json (b) {
        if (ended) return
        ended = true
        this._json = b
        resolve({ status: this.statusCode, json: b, headers: this._headers, bytes: null })
      },
      write (c) { chunks.push(Buffer.from(c)) },
      end (c) {
        if (ended) return
        ended = true
        if (c) chunks.push(Buffer.from(c))
        resolve({
          status: this.statusCode,
          json: this._json,
          headers: this._headers,
          bytes: chunks.length ? Buffer.concat(chunks) : null
        })
      }
    }
    const req = {
      method,
      url,
      params: m ? m.params : {},
      query: {},
      headers: headers || {},
      get: (k) => (headers ? headers[String(k).toLowerCase()] : '') || '',
      body: {}
    }
    if (!m) { res.status(404).json({ error: { code: 'not_found' } }); return }
    let i = 0
    const next = () => {
      if (i < middleware.length) { middleware[i++](req, res, next) } else {
        Promise.resolve(m.r.handler(req, res)).catch((err) => {
          if (!ended) res.status(err.status || 500).json(err.payload || { error: { message: err.message } })
        })
      }
    }
    next()
  })
  return router
}

module.exports = (async () => {
  const { manager, auth } = makeManager({
    auth: { mode: 'dev-shared-token', devToken: 'test-token' },
    firmware: { github: { enabled: false } }
  })
  const deviceId = 'yey-d-verify'
  manager.registerDevice({
    device: {
      id: deviceId,
      board: 'sunton_4848s040',
      chip: 'ESP32-S3',
      firmware: { name: 'yey-display', version: '0.5.0' }
    }
  }, auth)

  // Bytes the upstream actually serves, and a DIFFERENT sha we pretend to trust.
  const realBytes = Buffer.from('the-actual-upstream-bytes-which-were-tampered')
  const claimedSha = '0'.repeat(64) // does NOT match realBytes
  manager.store.firmware.artifacts.push({
    artifactId: 'gh-tampered',
    firmware: { name: 'yey-display', version: '0.6.0' },
    compatibility: { boards: ['sunton_4848s040'], releaseTarget: 'esp32-4848s040', chip: 'ESP32-S3' },
    file: {
      name: 'esp32-4848s040-merged_firmware.bin',
      url: 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/esp32-4848s040-merged_firmware.bin',
      sha256: `sha256:${claimedSha}`,
      size: realBytes.length,
      contentType: 'application/octet-stream'
    }
  })
  // Inject the mock fetch the route's firmwareArtifactBinary will use.
  manager.options.firmware.github.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => realBytes.buffer.slice(realBytes.byteOffset, realBytes.byteOffset + realBytes.byteLength)
  })

  const job = manager.createFirmwareJob(deviceId, { artifactId: 'gh-tampered' })

  const router = makeShim(() => manager)
  const resp = await router.dispatch('GET', `/firmware/download/${job.jobId}`, {
    'x-yeyboats-authorization': 'Bearer test-token'
  })

  assert.ok(resp.status >= 500 && resp.status < 600,
    `tampered artifact must yield a 5xx, got ${resp.status}`)
  assert.strictEqual(resp.bytes, null, 'NO firmware bytes may be streamed on sha mismatch')
  assert.ok(resp.json && resp.json.error, 'response carries an error, not firmware')
  const code = resp.json.error.code || ''
  assert.ok(/sha|mismatch|download/i.test(code + JSON.stringify(resp.json.error)),
    `error should indicate a checksum problem; got ${JSON.stringify(resp.json.error)}`)

  // Sanity: without the device token the route rejects (auth still gates).
  const unauth = await router.dispatch('GET', `/firmware/download/${job.jobId}`, {})
  assert.strictEqual(unauth.status, 401, 'download requires device auth')
  assert.strictEqual(unauth.bytes, null, 'no bytes without auth')

  console.log('firmware-download-verify.test: OK (no bytes on sha mismatch)')
})()
