// Offline firmware catalog (issue #9): a FIRMWARE_DIR with index.json + the
// merged_firmware.bin binaries it describes should be listable and flashable
// (serial + OTA) with the GitHub API completely unreachable.
const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { makeManager, mergeTestOptions } = require('./test-utils')
const { YeyBoatsDisplayManager } = require('../lib/manager')
const makePlugin = require('../index')

// Minimal Express-compatible router shim (same idea as knob-contract.test.js):
// records the handlers registerWithRouter() installs and dispatches mock
// requests through them, so the real route bodies in index.js run.
function makeRouterShim () {
  const routes = []
  const middleware = []
  const add = (method) => (routePath, ...handlers) => {
    routes.push({ method, path: routePath, handler: handlers[handlers.length - 1] })
  }
  const router = { use: (fn) => { middleware.push(fn) }, get: add('GET'), post: add('POST'), patch: add('PATCH'), put: add('PUT'), delete: add('DELETE') }
  router.dispatch = (method, urlPath, headers = {}) => new Promise((resolve) => {
    const route = routes.find((r) => r.method === method && r.path === urlPath)
    const res = {
      statusCode: 200,
      headers: {},
      _json: undefined,
      status (code) { this.statusCode = code; return this },
      json (body) { this._json = body; resolve({ status: this.statusCode, body, headers: this.headers }) },
      setHeader (k, v) { this.headers[k.toLowerCase()] = v },
      end () { resolve({ status: this.statusCode, body: this._json, headers: this.headers }) }
    }
    const req = { method, url: urlPath, params: {}, query: {}, headers, get: () => '', body: {} }
    if (!route) { res.status(404).json({ error: { code: 'not_found' } }); return }
    let i = 0
    const next = () => {
      if (i < middleware.length) { middleware[i++](req, res, next) } else {
        Promise.resolve(route.handler(req, res)).catch((err) => res.status(err.status || 500).json({ error: { message: err.message } }))
      }
    }
    next()
  })
  return router
}

const ESP = 'esp32-4848s040-merged_firmware.bin'

function sha256Of (bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

function localIds (manager) {
  return manager.listFirmware().artifacts
    .filter((a) => a.source && a.source.type === 'local-catalog')
    .map((a) => a.artifactId)
}

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
    assert.strictEqual(artifact.file.path, fs.realpathSync(path.join(dir, written[0].name)))
    assert.strictEqual(artifact.file.size, written[0].size)
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

  // --- Path traversal is rejected, not followed --------------------------
  // The asset lookup is `${target}-merged_firmware.bin`, so the only way an
  // operator-controlled string reaches the filesystem is via local.targets
  // (index.json asset names that don't match a target are never looked at).
  // Drive a traversal through a target, with the escaped file really present
  // and declared in index.json, so the import would succeed without the
  // containment check.
  {
    const { dir, written } = writeFixtureDir([
      { name: 'esp32-4848s040-merged_firmware.bin' }
    ])
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-secret-'))
    const evilTarget = `../${path.basename(secretDir)}/secret`
    const secretBytes = Buffer.from('top-secret')
    fs.writeFileSync(path.join(secretDir, 'secret-merged_firmware.bin'), secretBytes)
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.6.0',
      assets: [
        { name: `${evilTarget}-merged_firmware.bin`, size: secretBytes.length, sha256: sha256Of(secretBytes) },
        // A legitimate entry for another target proves the traversal entry
        // is skipped in isolation, not fatal to the refresh.
        { name: written[0].name, size: written[0].size, sha256: written[0].sha256 }
      ]
    }))

    const { manager } = makeManager({
      firmware: {
        github: { enabled: false },
        local: { enabled: true, dir, targets: [{ target: evilTarget, board: 'evil' }, 'esp32-4848s040'] }
      }
    })
    const catalog = manager.listFirmware()
    assert.deepStrictEqual(catalog.artifacts.map((a) => a.artifactId), ['local-v1.6.0-esp32-4848s040'],
      'only the safe asset is imported')
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
  // --- Declared size must match the file; recorded size is the file's -----
  {
    const { dir, written } = writeFixtureDir([{ name: ESP }])
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.8.0',
      assets: [{ name: ESP, size: written[0].size + 1, sha256: written[0].sha256 }]
    }))
    const { manager } = makeManager({ firmware: { github: { enabled: false }, local: { enabled: true, dir } } })
    assert.deepStrictEqual(localIds(manager), [], 'size mismatch is skipped')

    // No declared size: imported, size taken from disk (never index.json).
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.8.0', assets: [{ name: ESP, sha256: written[0].sha256 }]
    }))
    manager.refreshFirmwareFromLocal()
    assert.strictEqual(manager.getFirmwareArtifact('local-v1.8.0-esp32-4848s040').file.size, written[0].size)
  }

  // --- Unhashable (a directory) is skipped even with a declared sha --------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-catalog-'))
    fs.mkdirSync(path.join(dir, ESP))
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v1.9.0', assets: [{ name: ESP, sha256: 'sha256:' + 'a'.repeat(64) }]
    }))
    const { manager } = makeManager({ firmware: { github: { enabled: false }, local: { enabled: true, dir } } })
    assert.deepStrictEqual(localIds(manager), [], 'a directory is never imported on a declared sha alone')
  }

  // --- Symlinks: outside the dir rejected, inside the dir allowed ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-catalog-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-outside-'))
    const bytes = Buffer.from('outside-bytes')
    fs.writeFileSync(path.join(outside, 'real.bin'), bytes)
    fs.symlinkSync(path.join(outside, 'real.bin'), path.join(dir, ESP))
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
      tag_name: 'v2.0.0', assets: [{ name: ESP, size: bytes.length, sha256: sha256Of(bytes) }]
    }))
    const { manager } = makeManager({ firmware: { github: { enabled: false }, local: { enabled: true, dir } } })
    assert.deepStrictEqual(localIds(manager), [], 'symlink escaping FIRMWARE_DIR is not imported')

    fs.unlinkSync(path.join(dir, ESP))
    fs.writeFileSync(path.join(dir, 'real.bin'), bytes)
    fs.symlinkSync(path.join(dir, 'real.bin'), path.join(dir, ESP))
    manager.refreshFirmwareFromLocal()
    const artifact = manager.getFirmwareArtifact('local-v2.0.0-esp32-4848s040')
    assert.strictEqual(artifact.file.path, fs.realpathSync(path.join(dir, 'real.bin')),
      'an in-dir symlink is imported and recorded by its resolved path')
  }

  // --- Malformed JSON / multiple releases: 400, and stale entries pruned ---
  {
    const { dir, written } = writeFixtureDir([{ name: ESP }])
    const good = JSON.stringify({ tag_name: 'v2.1.0', assets: [{ name: ESP, size: written[0].size, sha256: written[0].sha256 }] })
    fs.writeFileSync(path.join(dir, 'index.json'), good)
    const { manager } = makeManager({ firmware: { github: { enabled: false }, local: { enabled: true, dir } } })
    assert.deepStrictEqual(localIds(manager), ['local-v2.1.0-esp32-4848s040'])

    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json')
    assert.throws(() => manager.refreshFirmwareFromLocal(),
      (err) => err.status === 400 && err.payload.error.code === 'local_firmware_catalog_invalid')
    assert.deepStrictEqual(localIds(manager), [], 'malformed index.json prunes previously imported entries')

    // Two releases would alias the same flat binary under two versions.
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([JSON.parse(good), { ...JSON.parse(good), tag_name: 'v2.2.0' }]))
    assert.throws(() => manager.refreshFirmwareFromLocal(),
      (err) => err.status === 400 && err.payload.error.code === 'local_firmware_catalog_multiple_releases')
    assert.deepStrictEqual(localIds(manager), [])

    // A one-element array is still accepted.
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([JSON.parse(good)]))
    manager.refreshFirmwareFromLocal()
    assert.deepStrictEqual(localIds(manager), ['local-v2.1.0-esp32-4848s040'])

    // The constructor swallows the error rather than failing plugin start.
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json')
    assert.doesNotThrow(() => makeManager({ firmware: { github: { enabled: false }, local: { enabled: true, dir } } }))
  }

  // --- Stale pruning on early return: index.json gone, dir cleared, disabled
  {
    const { dir, written } = writeFixtureDir([{ name: ESP }])
    const index = JSON.stringify({ tag_name: 'v2.3.0', assets: [{ name: ESP, size: written[0].size, sha256: written[0].sha256 }] })
    fs.writeFileSync(path.join(dir, 'index.json'), index)
    const { manager, app } = makeManager({ firmware: { github: { enabled: false }, local: { enabled: true, dir } } })
    const id = 'local-v2.3.0-esp32-4848s040'
    assert.deepStrictEqual(localIds(manager), [id])

    fs.unlinkSync(path.join(dir, 'index.json'))
    manager.refreshFirmwareFromLocal()
    assert.deepStrictEqual(localIds(manager), [], 'index.json removed -> pruned')

    fs.writeFileSync(path.join(dir, 'index.json'), index)
    manager.refreshFirmwareFromLocal()
    manager.options.firmware.local.dir = ''
    manager.refreshFirmwareFromLocal()
    assert.deepStrictEqual(localIds(manager), [], 'dir cleared -> pruned')

    manager.options.firmware.local.dir = dir
    manager.refreshFirmwareFromLocal()
    assert.deepStrictEqual(localIds(manager), [id])
    manager.options.firmware.local.enabled = false
    manager.refreshFirmwareFromLocal()
    assert.deepStrictEqual(localIds(manager), [], 'catalog disabled -> pruned')

    // Persisted entries from an earlier config are pruned at startup when the
    // catalog is now disabled (the constructor always runs the refresh).
    manager.options.firmware.local.enabled = true
    manager.refreshFirmwareFromLocal()
    assert.deepStrictEqual(localIds(manager), [id])
    if (manager.close) manager.close()
    const restarted = new YeyBoatsDisplayManager(app, mergeTestOptions({
      auth: { mode: 'dev-shared-token', devAuth: true },
      discoveryUdp: { enabled: false },
      deviceDiscoveryUdp: { enabled: false },
      network: { mdns: { browser: false, advertiseManager: false } }
    }, { firmware: { github: { enabled: false }, local: { enabled: false, dir } } }))
    assert.deepStrictEqual(localIds(restarted), [], 'disabled at startup -> persisted local entries pruned')
    if (restarted.close) restarted.close()
  }

  // --- Refresh routes: a bad index.json never blocks the GitHub refresh ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-firmware-catalog-'))
    fs.writeFileSync(path.join(dir, 'index.json'), '{ not json')
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yey-boats-display-manager-'))
    let fetchCalls = 0
    const offlineFetch = async () => { fetchCalls++; throw new Error('ENETUNREACH (simulated offline boat)') }
    const plugin = makePlugin({ getDataDirPath: () => dataDir, debug: () => {}, handleMessage: () => {} })
    const router = makeRouterShim()
    plugin.registerWithRouter(router)
    plugin.start({
      discoveryUdp: { enabled: false },
      deviceDiscoveryUdp: { enabled: false },
      firmware: { github: { enabled: false, fetch: offlineFetch }, local: { enabled: true, dir } },
      network: { mdns: { browser: false, advertiseManager: false } }
    })
    // Enabled after start so the constructor's background GitHub refresh
    // doesn't race the counts below.
    plugin._manager().options.firmware.github.enabled = true
    // The refresh routes are operator routes: authenticate with the manager
    // API token generated on first start.
    const op = { 'x-yeyboats-authorization': `Bearer ${plugin._manager().apiToken.pendingReveal()}` }

    const api = await router.dispatch('POST', '/firmware/catalog/refresh', op)
    assert.strictEqual(fetchCalls > 0, true, 'GitHub refresh ran despite the bad local index.json')
    assert.strictEqual(api.status, 502, 'a GitHub failure is an error status, not 200 + error field')
    assert.strictEqual(api.body.localError.code, 'local_firmware_catalog_invalid')
    assert.ok(Array.isArray(api.body.artifacts), 'error body still carries the catalog')

    const before = fetchCalls
    const ui = await router.dispatch('POST', '/ui/firmware/catalog/refresh', op)
    assert.ok(fetchCalls > before, 'UI refresh also reaches GitHub past the bad local catalog')
    assert.ok(ui.status >= 400, 'UI refresh reports the GitHub failure')

    // GitHub disabled: local error alone does not fail the route.
    plugin._manager().options.firmware.github.enabled = false
    const ok = await router.dispatch('POST', '/firmware/catalog/refresh', op)
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(ok.body.localError.code, 'local_firmware_catalog_invalid')
    const okUi = await router.dispatch('POST', '/ui/firmware/catalog/refresh', op)
    assert.strictEqual(okUi.status, 303)
    plugin.stop()
  }
})()
