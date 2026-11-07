// Offline firmware catalog (issue #9): a FIRMWARE_DIR with index.json + the
// merged_firmware.bin binaries it describes should be listable and flashable
// (serial + OTA) with the GitHub API completely unreachable.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeManager } = require('./test-utils')

function writeFixtureDir (assets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-catalog-'))
  const written = []
  for (const asset of assets) {
    const bytes = asset.bytes || Buffer.from(`fixture-firmware-${asset.name}`)
    fs.writeFileSync(path.join(dir, asset.name), bytes)
    written.push({ name: asset.name, size: bytes.length, sha256: asset.includeSha === false ? undefined : `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` })
  }
  return { dir, written }
}

module.exports = (async () => {
  // --- Basic import: present at construction time, no network ------------
  {
    const { dir, written } = writeFixtureDir([
      { name: 'esp32-4848s040-merged_firmware.bin' }
    ])
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.4.0',
      prerelease: false,
      assets: [{ name: written[0].name, size: written[0].size, sha256: written[0].sha256 }]
    }))

    const { manager, auth } = makeManager({
      auth: { mode: 'dev-shared-token', devToken: 'test-token' },
      firmware: { github: { enabled: false }, local: { enabled: true, dir } }
    })

    // The constructor already ran refreshFirmwareFromLocal() synchronously —
    // no explicit refresh call needed, and no fetch was ever touched.
    const artifact = manager.getFirmwareArtifact('local-v1.4.0-esp32-4848s040')
    assert.strictEqual(artifact.firmware.version, '1.4.0')
    assert.strictEqual(artifact.source.type, 'local-catalog')
    assert.deepStrictEqual(artifact.compatibility.boards, ['sunton_4848s040'])
    assert.strictEqual(artifact.file.path, path.join(dir, written[0].name))
    assert.strictEqual(artifact.file.sha256, written[0].sha256)

    const deviceId = 'yey-d-local-fw'
    manager.registerDevice({
      device: { id: deviceId, board: 'sunton_4848s040', chip: 'ESP32-S3', firmware: { name: 'yey-display', version: '1.3.0' } }
    }, auth)

    // Serial flash path: firmwareArtifactBinary() resolves straight to the
    // on-disk file, no fetchImpl required.
    const binary = await manager.firmwareArtifactBinary(artifact.artifactId)
    assert.strictEqual(binary.path, artifact.file.path)
    assert.strictEqual(fs.readFileSync(binary.path).toString(), fs.readFileSync(path.join(dir, written[0].name)).toString())

    // OTA path: createFirmwareJob + firmwareDownloadInfo + firmwareArtifactBinary.
    const job = manager.createFirmwareJob(deviceId, { artifactId: artifact.artifactId })
    const info = manager.firmwareDownloadInfo(job.jobId)
    assert.strictEqual(info.artifact.artifactId, artifact.artifactId)
    const otaBinary = await manager.firmwareArtifactBinary(info.artifact.artifactId)
    assert.strictEqual(otaBinary.path, artifact.file.path)
    const command = manager.pendingCommands(deviceId).find((cmd) => cmd.type === 'firmware.update' && cmd.payload.jobId === job.jobId)
    assert.ok(command)
    assert.strictEqual(command.payload.url, `/firmware/download/${job.jobId}`)

    // Manual re-refresh (e.g. the UI "Refresh" button) is idempotent and
    // still needs no network.
    const refreshed = manager.refreshFirmwareFromLocal()
    assert.strictEqual(refreshed.refreshed.imported, 1)
  }

  // --- GitHub unreachable: local artifacts are still there ----------------
  {
    const { dir, written } = writeFixtureDir([
      { name: 'esp32-4848s040-merged_firmware.bin' }
    ])
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.5.0',
      assets: [{ name: written[0].name, size: written[0].size, sha256: written[0].sha256 }]
    }))

    // github.enabled stays false for makeManager() itself so construction
    // never fires a real startup fetch; flipped on right after, same as
    // github-firmware.test.js, so refreshFirmwareFromGithub can be driven
    // with an explicit (failing) fetchImpl instead.
    const { manager } = makeManager({
      firmware: { github: { enabled: false }, local: { enabled: true, dir } }
    })
    manager.options.firmware.github.enabled = true
    const unreachableFetch = async () => { throw new Error('ENETUNREACH (simulated offline boat)') }
    await assert.rejects(() => manager.refreshFirmwareFromGithub(unreachableFetch))

    const catalog = manager.listFirmware()
    assert.ok(catalog.artifacts.find((a) => a.artifactId === 'local-v1.5.0-esp32-4848s040'),
      'local artifact survives a failed GitHub refresh')
  }

  // --- No catalog dropped in yet: quiet no-op, not a throw ----------------
  {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-catalog-empty-'))
    const { manager } = makeManager({
      firmware: { github: { enabled: false }, local: { enabled: true, dir: emptyDir } }
    })
    assert.deepStrictEqual(manager.listFirmware().artifacts, [])
    assert.doesNotThrow(() => manager.refreshFirmwareFromLocal())
  }

  // --- Path traversal in index.json is rejected, not followed -------------
  {
    const { dir, written } = writeFixtureDir([
      { name: 'esp32-4848s040-merged_firmware.bin' }
    ])
    // A secret file OUTSIDE the firmware dir that a traversal must not reach.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-secret-'))
    fs.writeFileSync(path.join(secretDir, 'secret.bin'), 'top-secret')
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.6.0',
      assets: [
        // Malicious: tries to point the esp32 target at a file outside dir.
        { name: `../${path.basename(secretDir)}/secret.bin`, size: 10 },
        // A second, legitimate entry for a different target proves the
        // traversal entry is skipped in isolation, not fatal to the refresh.
        { name: written[0].name, size: written[0].size, sha256: written[0].sha256 }
      ]
    }))

    const { manager } = makeManager({
      firmware: { github: { enabled: false }, local: { enabled: true, dir } }
    })
    const catalog = manager.listFirmware()
    assert.strictEqual(catalog.artifacts.length, 1, 'only the safe asset is imported')
    assert.strictEqual(catalog.artifacts[0].file.path, path.join(dir, written[0].name))
    assert.ok(!catalog.artifacts.some((a) => String(a.file && a.file.path).includes('secret')),
      'no artifact ever points outside FIRMWARE_DIR')
  }

  // --- Checksum mismatch is rejected, not silently imported ----------------
  {
    const { dir, written } = writeFixtureDir([
      { name: 'esp32-4848s040-merged_firmware.bin' }
    ])
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.7.0',
      assets: [{ name: written[0].name, size: written[0].size, sha256: 'sha256:' + '0'.repeat(64) }]
    }))
    const { manager } = makeManager({
      firmware: { github: { enabled: false }, local: { enabled: true, dir } }
    })
    assert.deepStrictEqual(manager.listFirmware().artifacts, [])
  }
})()
