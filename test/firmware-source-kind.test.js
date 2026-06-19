const assert = require('assert')
const fs = require('fs')
const { makeManager } = require('./test-utils')

// Covers the flash-screen backend slice:
//  - multi-release import (tip + tagged release + prerelease)
//  - source.kind / source.tag / source.prerelease tagging
//  - RELEASES (release + tip) vs ALL filter semantics
//  - firmwareManifest version reads firmware.version (fix A)
//  - firmwareArtifactBinary downloads GitHub url on demand + sha verify (fix B)
//  - firmwareTargets() target<->board<->resolution table
module.exports = (async () => {
  const { manager } = makeManager({
    auth: { mode: 'dev-shared-token', devToken: 't' },
    firmware: { github: { enabled: false, owner: 'yey-boats', repo: 'instruments' } }
  })

  // Two GitHub binaries with known content; sha256 computed for the cache test.
  const crypto = require('crypto')
  const tipBin = Buffer.from('TIP-BINARY-BYTES')
  const relBin = Buffer.from('RELEASE-BINARY-BYTES')
  const tipSha = crypto.createHash('sha256').update(tipBin).digest('hex')
  const relSha = crypto.createHash('sha256').update(relBin).digest('hex')

  const target = 'esp32-4848s040'
  const assetName = `${target}-merged_firmware.bin`
  const mkRelease = (tag, prerelease, dl, sha) => ({
    tag_name: tag,
    prerelease,
    html_url: `https://github.com/yey-boats/instruments/releases/tag/${tag}`,
    assets: [
      { name: assetName, size: 16, content_type: 'application/octet-stream', browser_download_url: `${dl}/${assetName}` },
      { name: 'SHA256SUMS', browser_download_url: `${dl}/SHA256SUMS` }
    ],
    _sums: `${sha}  ${assetName}`,
    _bin: tag === 'tip' ? tipBin : relBin
  })

  const relV1 = mkRelease('v1.0.42', false, 'https://github.com/yey-boats/instruments/releases/download/v1.0.42', relSha)
  const tip = mkRelease('tip', true, 'https://github.com/yey-boats/instruments/releases/download/tip', tipSha)
  const rcV2 = mkRelease('v2.0.0-rc1', true, 'https://github.com/yey-boats/instruments/releases/download/v2.0.0-rc1', relSha)

  // includePrereleases=true -> /releases returns the full list; the explicit
  // /tags/tip fetch is skipped because tip is already in the list.
  manager.options.firmware.github.includePrereleases = true
  manager.options.firmware.github.enabled = true

  const githubFetch = async (url) => {
    if (url.endsWith('/releases')) {
      return { ok: true, json: async () => [relV1, tip, rcV2] }
    }
    if (url.endsWith('/SHA256SUMS')) {
      const r = [relV1, tip, rcV2].find((x) => url.includes('/download/' + x.tag_name + '/'))
      return { ok: true, text: async () => r._sums }
    }
    if (url.endsWith(`/${assetName}`)) {
      const r = [relV1, tip, rcV2].find((x) => url.includes('/download/' + x.tag_name + '/'))
      return { ok: true, arrayBuffer: async () => r._bin.buffer.slice(r._bin.byteOffset, r._bin.byteOffset + r._bin.byteLength) }
    }
    throw new Error(`unexpected fetch URL ${url}`)
  }

  const refreshed = await manager.refreshFirmwareFromGithub(githubFetch)
  // 3 releases x 1 matching target = 3 artifacts.
  assert.strictEqual(refreshed.refreshed.imported, 3)
  // Primary tag should be the stable release, not tip/rc.
  assert.strictEqual(refreshed.refreshed.release, 'v1.0.42')

  const all = manager.listFirmware().artifacts
  const byTag = (t) => all.find((a) => a.source && a.source.tag === t)

  const aRel = byTag('v1.0.42')
  const aTip = byTag('tip')
  const aRc = byTag('v2.0.0-rc1')
  assert.ok(aRel && aTip && aRc, 'all three releases imported')
  assert.strictEqual(aRel.source.kind, 'release')
  assert.strictEqual(aRel.source.prerelease, false)
  assert.strictEqual(aTip.source.kind, 'tip')
  assert.strictEqual(aTip.source.prerelease, true)
  assert.strictEqual(aRc.source.kind, 'prerelease')
  assert.strictEqual(aRc.source.prerelease, true)
  assert.strictEqual(aRc.firmware.version, '2.0.0-rc1')

  // RELEASES view = release + tip; ALL view = everything. (Mirrors the
  // client-side filter in public/flash.html.)
  const visibleReleases = all.filter((a) => {
    const kind = (a.source && a.source.kind) || 'release'
    return kind === 'release' || kind === 'tip'
  })
  assert.strictEqual(visibleReleases.length, 2, 'RELEASES view shows release + tip only')
  assert.strictEqual(all.length, 3, 'ALL view shows everything')

  // Fix A: manifest version comes from firmware.version, not legacy `version`.
  const man = manager.firmwareManifest(aTip.artifactId)
  assert.strictEqual(man.version, aTip.firmware.version)
  assert.notStrictEqual(man.version, '0')

  // Fix B: GitHub artifact has no file.path; binary is downloaded on demand,
  // verified against file.sha256, cached, and re-served from disk.
  const bin = await manager.firmwareArtifactBinary(aTip.artifactId, githubFetch)
  assert.ok(bin && bin.path, 'binary resolved to a local cache path')
  assert.ok(fs.existsSync(bin.path))
  assert.strictEqual(fs.readFileSync(bin.path).toString(), tipBin.toString())
  // Second call reuses the cache (no fetch needed) — pass a throwing fetch.
  const bin2 = await manager.firmwareArtifactBinary(aTip.artifactId, async () => { throw new Error('should not fetch') })
  assert.strictEqual(bin2.path, bin.path)

  // sha mismatch is rejected.
  const badArtifact = JSON.parse(JSON.stringify(aRel))
  badArtifact.artifactId = 'fw-bad-sha'
  badArtifact.file.sha256 = 'sha256:' + '0'.repeat(64)
  manager.store.firmware.artifacts.push(badArtifact)
  await assert.rejects(
    () => manager.firmwareArtifactBinary('fw-bad-sha', githubFetch),
    /checksum mismatch|sha/i
  )

  // firmwareTargets() maps every target to a board + resolution.
  const targets = manager.firmwareTargets().targets
  assert.strictEqual(targets.length, 8)
  const sunton = targets.find((t) => t.target === 'esp32-4848s040')
  assert.strictEqual(sunton.board, 'sunton_4848s040')
  assert.strictEqual(sunton.resolution, '480×480')
  const big = targets.find((t) => t.target === 'waveshare-touch-lcd-7b_1024x600')
  assert.strictEqual(big.resolution, '1024×600')

  console.log('firmware-source-kind.test: OK')
})()
