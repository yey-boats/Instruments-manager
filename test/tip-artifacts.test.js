const assert = require('assert')
const fs = require('fs')
const zlib = require('zlib')
const { makeManager } = require('./test-utils')

// Build a minimal, real ZIP file in-memory containing a single entry named
// `merged_firmware.bin`, using either STORE (method 0) or DEFLATE (method 8).
// We write proper local file headers + a central directory + EOCD so the
// dependency-free extractor (which reads the central directory) is exercised
// the same way it would be against a real GitHub artifact zip.
function buildZip (name, content, method) {
  const nameBuf = Buffer.from(name, 'utf8')
  const crc = zlib.crc32 ? zlib.crc32(content) >>> 0 : crc32(content)
  let body
  if (method === 8) {
    body = zlib.deflateRawSync(content)
  } else {
    body = content
  }
  const compSize = body.length
  const uncompSize = content.length

  // Local file header (30 bytes + name + data)
  const lfh = Buffer.alloc(30)
  lfh.writeUInt32LE(0x04034b50, 0)
  lfh.writeUInt16LE(20, 4) // version needed
  lfh.writeUInt16LE(0, 6) // flags
  lfh.writeUInt16LE(method, 8)
  lfh.writeUInt16LE(0, 10) // mod time
  lfh.writeUInt16LE(0, 12) // mod date
  lfh.writeUInt32LE(crc, 14)
  lfh.writeUInt32LE(compSize, 18)
  lfh.writeUInt32LE(uncompSize, 22)
  lfh.writeUInt16LE(nameBuf.length, 26)
  lfh.writeUInt16LE(0, 28) // extra len
  const localOffset = 0
  const localPart = Buffer.concat([lfh, nameBuf, body])

  // Central directory header (46 bytes + name)
  const cdh = Buffer.alloc(46)
  cdh.writeUInt32LE(0x02014b50, 0)
  cdh.writeUInt16LE(20, 4) // version made by
  cdh.writeUInt16LE(20, 6) // version needed
  cdh.writeUInt16LE(0, 8) // flags
  cdh.writeUInt16LE(method, 10)
  cdh.writeUInt16LE(0, 12)
  cdh.writeUInt16LE(0, 14)
  cdh.writeUInt32LE(crc, 16)
  cdh.writeUInt32LE(compSize, 20)
  cdh.writeUInt32LE(uncompSize, 24)
  cdh.writeUInt16LE(nameBuf.length, 28)
  cdh.writeUInt16LE(0, 30) // extra len
  cdh.writeUInt16LE(0, 32) // comment len
  cdh.writeUInt16LE(0, 34) // disk number
  cdh.writeUInt16LE(0, 36) // internal attrs
  cdh.writeUInt32LE(0, 38) // external attrs
  cdh.writeUInt32LE(localOffset, 42)
  const cdPart = Buffer.concat([cdh, nameBuf])

  const cdOffset = localPart.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(1, 8) // entries on disk
  eocd.writeUInt16LE(1, 10) // total entries
  eocd.writeUInt32LE(cdPart.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  return Buffer.concat([localPart, cdPart, eocd])
}

// CRC32 fallback for Node versions without zlib.crc32.
function crc32 (buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}

module.exports = (async () => {
  // ---- Case 1: full refresh + extraction (stored + deflated) ----
  const FIRMWARE_BYTES = Buffer.from('YEY-DISPLAY-MERGED-FIRMWARE-PAYLOAD-' + 'X'.repeat(200))
  const ARCHIVE_URL_4848 = 'https://api.github.com/repos/yey-boats/instruments/actions/artifacts/111/zip'
  const ARCHIVE_URL_WS7B = 'https://api.github.com/repos/yey-boats/instruments/actions/artifacts/222/zip'
  const SIGNED_4848 = 'https://pipelines.storage.example/blob/111?sig=abc'
  const SIGNED_WS7B = 'https://pipelines.storage.example/blob/222?sig=def'

  const zipStored = buildZip('merged_firmware.bin', FIRMWARE_BYTES, 0)
  const zipDeflated = buildZip('build/merged_firmware.bin', FIRMWARE_BYTES, 8)

  let sentAuthToSignedUrl = false

  const githubFetch = async (url, opts) => {
    const headers = (opts && opts.headers) || {}
    // Runs list
    if (url === 'https://api.github.com/repos/yey-boats/instruments/actions/runs?branch=main&event=push&status=success&per_page=10') {
      assert.strictEqual(headers.Authorization, 'Bearer test-pat', 'runs list must be authenticated')
      assert.strictEqual(headers['X-GitHub-Api-Version'], '2022-11-28')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workflow_runs: [
            { id: 9001, name: 'CI', run_number: 42, head_sha: 'deadbeef', html_url: 'https://github.com/yey-boats/instruments/actions/runs/9001', created_at: '2026-06-19T00:00:00Z' },
            { id: 8000, name: 'Other', run_number: 41, head_sha: 'cafef00d' }
          ]
        })
      }
    }
    // VERSION contents
    if (url === 'https://api.github.com/repos/yey-boats/instruments/contents/VERSION?ref=main') {
      assert.strictEqual(headers.Authorization, 'Bearer test-pat')
      return {
        ok: true,
        status: 200,
        json: async () => ({ encoding: 'base64', content: Buffer.from('1.7.99\n').toString('base64') })
      }
    }
    // Run artifacts list
    if (url === 'https://api.github.com/repos/yey-boats/instruments/actions/runs/9001/artifacts') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          artifacts: [
            { id: 111, name: 'firmware-esp32-4848s040-latest', expires_at: '2026-09-17T00:00:00Z', archive_download_url: ARCHIVE_URL_4848 },
            { id: 222, name: 'firmware-waveshare-touch-lcd-7b_1024x600-latest', expires_at: '2026-09-17T00:00:00Z', archive_download_url: ARCHIVE_URL_WS7B },
            { id: 333, name: 'some-other-artifact', archive_download_url: 'https://x/zip' }
          ]
        })
      }
    }
    // Zip download (authenticated) -> 302 to signed storage URL
    if (url === ARCHIVE_URL_4848) {
      assert.strictEqual(headers.Authorization, 'Bearer test-pat', 'zip download must be authenticated')
      return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? SIGNED_4848 : null) } }
    }
    if (url === ARCHIVE_URL_WS7B) {
      return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? SIGNED_WS7B : null) } }
    }
    // Signed storage URL (must NOT carry the Authorization header)
    if (url === SIGNED_4848) {
      if (headers.Authorization) sentAuthToSignedUrl = true
      return { ok: true, status: 200, arrayBuffer: async () => zipStored.buffer.slice(zipStored.byteOffset, zipStored.byteOffset + zipStored.length) }
    }
    if (url === SIGNED_WS7B) {
      if (headers.Authorization) sentAuthToSignedUrl = true
      return { ok: true, status: 200, arrayBuffer: async () => zipDeflated.buffer.slice(zipDeflated.byteOffset, zipDeflated.byteOffset + zipDeflated.length) }
    }
    throw new Error(`unexpected fetch URL ${url}`)
  }

  const { manager } = makeManager({
    firmware: { github: { enabled: false, tipFromArtifacts: true, token: 'test-pat' } }
  })
  manager.options.firmware.github.enabled = true

  const result = await manager.refreshTipFromArtifacts(githubFetch)
  assert.strictEqual(result.tip.runNumber, 42)
  assert.strictEqual(result.tip.version, '1.7.42')
  assert.strictEqual(result.tip.imported, 2)

  const tip4848 = manager.getFirmwareArtifact('tip-esp32-4848s040')
  assert.strictEqual(tip4848.source.kind, 'tip')
  assert.strictEqual(tip4848.source.runId, 9001)
  assert.strictEqual(tip4848.source.headSha, 'deadbeef')
  assert.strictEqual(tip4848.firmware.version, '1.7.42')
  assert.strictEqual(tip4848.firmware.channel, 'tip')
  assert.deepStrictEqual(tip4848.compatibility.boards, ['sunton_4848s040'])
  assert.strictEqual(tip4848.compatibility.chip, 'ESP32-S3')
  assert.strictEqual(tip4848.file.kind, 'actions-artifact')
  assert.strictEqual(tip4848.file.url, ARCHIVE_URL_4848)

  const tipWs = manager.getFirmwareArtifact('tip-waveshare-touch-lcd-7b_1024x600')
  assert.deepStrictEqual(tipWs.compatibility.boards, ['waveshare_touch_lcd_7b_1024x600'])

  // Manifest for a tip artifact: version + chipFamily + same-origin /binary.
  const man = manager.firmwareManifest('tip-esp32-4848s040')
  assert.strictEqual(man.version, '1.7.42')
  assert.strictEqual(man.builds[0].chipFamily, 'ESP32-S3')
  assert.ok(man.builds[0].parts[0].path.endsWith('/firmware/artifacts/tip-esp32-4848s040/binary'))

  // Binary serving: stored entry -> exact bytes.
  const bin4848 = await manager.firmwareArtifactBinary('tip-esp32-4848s040', githubFetch)
  assert.ok(bin4848 && bin4848.path)
  assert.deepStrictEqual(fs.readFileSync(bin4848.path), FIRMWARE_BYTES)

  // MGR-4: extraction computes + persists a sha256 of merged_firmware.bin so
  // later serves self-verify. The unsigned TIP build is now checksum-covered.
  const crypto = require('crypto')
  const expectedSha = crypto.createHash('sha256').update(FIRMWARE_BYTES).digest('hex')
  const tip4848b = manager.getFirmwareArtifact('tip-esp32-4848s040')
  assert.strictEqual(tip4848b.file.sha256, `sha256:${expectedSha}`, 'extracted sha256 persisted')
  assert.strictEqual(tip4848b.file.size, FIRMWARE_BYTES.length)
  assert.strictEqual(tip4848b.signing.checksums, 'sha256-extracted', 'checksum-covered marker set')
  // Still an unsigned build (allowUnsigned true) — the UI warns on it.
  assert.strictEqual(tip4848b.vendor.trust.allowUnsigned, true)

  // Cache hit self-verifies without re-fetching (pass a throwing fetch).
  const cached = await manager.firmwareArtifactBinary('tip-esp32-4848s040',
    async () => { throw new Error('should not fetch') })
  assert.strictEqual(cached.path, bin4848.path)

  // Tamper the cached bin: the next serve must refuse it on sha mismatch.
  fs.writeFileSync(bin4848.path, Buffer.from('TAMPERED-CACHE-BYTES'))
  await assert.rejects(
    () => manager.firmwareArtifactBinary('tip-esp32-4848s040',
      async () => { throw new Error('should not fetch') }),
    /checksum mismatch|sha/i,
    'tampered TIP cache is rejected'
  )
  // Restore a clean cache for any later assertions.
  fs.writeFileSync(bin4848.path, FIRMWARE_BYTES)

  // Binary serving: deflated entry (nested path) -> exact bytes.
  const binWs = await manager.firmwareArtifactBinary('tip-waveshare-touch-lcd-7b_1024x600', githubFetch)
  assert.deepStrictEqual(fs.readFileSync(binWs.path), FIRMWARE_BYTES)

  assert.strictEqual(sentAuthToSignedUrl, false, 'Authorization header must not be sent to the signed storage URL')

  // ---- Case 2: stale tip pruning ----
  // A subsequent run drops the waveshare target; its tip record must vanish.
  const githubFetch2 = async (url, opts) => {
    if (url === 'https://api.github.com/repos/yey-boats/instruments/actions/runs?branch=main&event=push&status=success&per_page=10') {
      return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ id: 9100, name: 'CI', run_number: 43, head_sha: 'feedface' }] }) }
    }
    if (url === 'https://api.github.com/repos/yey-boats/instruments/contents/VERSION?ref=main') {
      return { ok: true, status: 200, json: async () => ({ encoding: 'base64', content: Buffer.from('1.7.0').toString('base64') }) }
    }
    if (url === 'https://api.github.com/repos/yey-boats/instruments/actions/runs/9100/artifacts') {
      return { ok: true, status: 200, json: async () => ({ artifacts: [{ id: 444, name: 'firmware-esp32-4848s040-latest', archive_download_url: ARCHIVE_URL_4848 }] }) }
    }
    throw new Error(`unexpected fetch URL ${url}`)
  }
  await manager.refreshTipFromArtifacts(githubFetch2)
  assert.ok(manager.store.firmware.artifacts.find((a) => a.artifactId === 'tip-esp32-4848s040'), 'live tip kept')
  assert.ok(!manager.store.firmware.artifacts.find((a) => a.artifactId === 'tip-waveshare-touch-lcd-7b_1024x600'), 'stale tip pruned')
  assert.strictEqual(manager.getFirmwareArtifact('tip-esp32-4848s040').firmware.version, '1.7.43')

  // ---- Case 3: no token -> skip quietly (no fetch calls) ----
  let debugMsgs = []
  const { manager: m2 } = makeManager({
    firmware: { github: { enabled: false, tipFromArtifacts: true, token: '' } }
  })
  m2.app.debug = (msg) => debugMsgs.push(msg)
  let fetchCalled = false
  const noFetch = async () => { fetchCalled = true; throw new Error('should not fetch') }
  const r3 = await m2.refreshTipFromArtifacts(noFetch)
  assert.strictEqual(fetchCalled, false, 'no token must not trigger any fetch')
  assert.ok(Array.isArray(r3.artifacts), 'returns listFirmware shape')
  assert.ok(debugMsgs.some((m) => m.includes('no GitHub token')), 'logs the skip reason once')
  // Logged only once.
  debugMsgs = []
  await m2.refreshTipFromArtifacts(noFetch)
  assert.strictEqual(debugMsgs.length, 0, 'skip is logged only once')

  // MGR-4: the flash UI must visibly warn before installing an unsigned build.
  const path = require('path')
  const flashHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'flash.html'), 'utf8')
  assert.ok(/allowUnsigned/.test(flashHtml), 'flash UI must key off vendor.trust.allowUnsigned')
  assert.ok(/id="unsigned-warn"/.test(flashHtml), 'flash UI must contain the unsigned-build warning element')
  assert.ok(/Unsigned build/i.test(flashHtml), 'flash UI must show an "Unsigned build" warning')

  console.log('tip-artifacts test passed')
})()
