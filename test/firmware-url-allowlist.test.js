// MGR-5: firmware artifact URLs (and the GitHub API base) are fetched
// server-side, so ingest must reject non-https schemes and off-allowlist hosts
// (SSRF-adjacent: otherwise the manager is an open fetch proxy toward LAN /
// cloud-metadata addresses when the SignalK admin session is off/compromised).
const assert = require('assert')
const { makeManager } = require('./test-utils')

module.exports = (async () => {
  const { manager } = makeManager({
    auth: { mode: 'dev-shared-token', devToken: 't' },
    firmware: { github: { enabled: false, owner: 'yey-boats', repo: 'instruments' } }
  })

  const baseBody = (url) => ({
    vendor: { id: 'yey-boats' },
    product: { id: 'yey-display' },
    firmware: { version: '9.9.9' },
    file: { sha256: 'sha256:' + 'a'.repeat(64), url }
  })

  // --- accepted: https on an allowlisted host --------------------------
  const okUrls = [
    'https://github.com/yey-boats/instruments/releases/download/v1/fw.bin',
    'https://api.github.com/repos/yey-boats/instruments/actions/artifacts/1/zip',
    'https://objects.githubusercontent.com/gh/abc/fw.bin'
  ]
  for (const url of okUrls) {
    const a = manager.addFirmwareArtifact(baseBody(url))
    assert.ok(a && a.artifactId, `allowlisted URL accepted: ${url}`)
  }

  // A body with no file.url at all is still fine (local upload path).
  {
    const body = baseBody(undefined)
    delete body.file.url
    const a = manager.addFirmwareArtifact(body)
    assert.ok(a && a.artifactId, 'artifact without a url is accepted')
  }

  // --- rejected: bad scheme / bad host ---------------------------------
  const badUrls = [
    'http://github.com/yey-boats/instruments/fw.bin', // not https
    'https://evil.example/fw.bin', // off allowlist
    'https://raw.githubusercontent.com/yey-boats/x/fw.bin', // sibling host, not allowed
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'file:///etc/passwd', // non-http scheme
    'https://github.com.attacker.example/fw.bin', // lookalike suffix
    'not a url'
  ]
  for (const url of badUrls) {
    assert.throws(
      () => manager.addFirmwareArtifact(baseBody(url)),
      (err) => err && err.status === 400 && /invalid_request/.test((err.payload && err.payload.error && err.payload.error.code) || ''),
      `rejected non-allowlisted URL: ${url}`
    )
  }

  // --- apiBase is validated too (server-side fetched) ------------------
  const { manager: m2 } = makeManager({
    firmware: { github: { enabled: true, owner: 'yey-boats', repo: 'instruments', apiBase: 'http://169.254.169.254' } }
  })
  await assert.rejects(
    () => m2.refreshFirmwareFromGithub(async () => { throw new Error('should not fetch') }),
    (err) => err && err.status === 400,
    'non-https apiBase rejected before any fetch'
  )

  const { manager: m3 } = makeManager({
    firmware: { github: { enabled: true, tipFromArtifacts: true, token: 'x', owner: 'o', repo: 'r', apiBase: 'https://evil.example' } }
  })
  await assert.rejects(
    () => m3.refreshTipFromArtifacts(async () => { throw new Error('should not fetch') }),
    (err) => err && err.status === 400,
    'off-allowlist apiBase rejected before any artifact fetch'
  )

  console.log('firmware-url-allowlist.test: OK')
})()
