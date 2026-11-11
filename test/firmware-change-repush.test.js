// instruments-manager#26: re-push a display's config (incl. its web password)
// whenever it reports a firmware version different from the one last seen.
//
// After a manual downgrade below the firmware version that hashes the web
// password (instruments#34) the old firmware cannot read its stored password.
// The device's reported config hash may still match the desired one, so the
// ordinary hash comparison would not reload it. Any version change (upgrade or
// downgrade) must therefore queue a config.reload and flag reload in the
// heartbeat response; the last-seen version is persisted across restarts.
const assert = require('assert')
const { makeManager } = require('./test-utils')
const { YeyBoatsDisplayManager } = require('../lib/manager')

function reloads (manager, id) {
  return manager.pendingCommands(id).filter((c) => c.type === 'config.reload')
}

function heartbeat (manager, id, auth, version) {
  const hash = manager.generateConfig(id).hash
  return manager.updateStatus(id, {
    firmware: { version },
    config: { version: 1, hash, applied: true }
  }, auth)
}

module.exports = (async () => {
  // ---- 1. first sighting and same-version heartbeats do not re-push -------
  {
    const { manager, auth } = makeManager()
    manager.registerDevice({ device: { id: 'yey-fw-a', firmware: { version: '1.4.0' } } }, auth)
    assert.strictEqual(reloads(manager, 'yey-fw-a').length, 0, 'first sighting: no re-push')
    const res = heartbeat(manager, 'yey-fw-a', auth, '1.4.0')
    assert.strictEqual(res.desiredConfig.reload, false)
    assert.strictEqual(reloads(manager, 'yey-fw-a').length, 0, 'same version: no re-push')
    assert.strictEqual(manager.store.registry.devices['yey-fw-a'].lastSeenFirmwareVersion, '1.4.0')
  }

  // ---- 2. a downgrade in a heartbeat re-pushes the config ------------------
  {
    const { manager, auth } = makeManager()
    manager.registerDevice({ device: { id: 'yey-fw-b', firmware: { version: '1.4.0' } } }, auth)
    heartbeat(manager, 'yey-fw-b', auth, '1.4.0')
    const res = heartbeat(manager, 'yey-fw-b', auth, '1.2.0')
    assert.strictEqual(res.desiredConfig.reload, true, 'reload flagged though the reported hash matches')
    const cmds = reloads(manager, 'yey-fw-b')
    assert.strictEqual(cmds.length, 1, 'one config.reload queued')
    const config = manager.generateConfig('yey-fw-b')
    assert.strictEqual(cmds[0].payload.hash, config.hash)
    assert.ok(config.webAuth && config.webAuth.password, 'the pushed config carries the web password')
    assert.strictEqual(res.commandsPending, 1)
    assert.strictEqual(manager.store.registry.devices['yey-fw-b'].lastSeenFirmwareVersion, '1.2.0')
    // A further heartbeat on the same (new) version does not queue another.
    const again = heartbeat(manager, 'yey-fw-b', auth, '1.2.0')
    assert.strictEqual(again.desiredConfig.reload, false)
    assert.strictEqual(reloads(manager, 'yey-fw-b').length, 1)
  }

  // ---- 3. an upgrade reported on re-registration re-pushes too -------------
  {
    const { manager, auth } = makeManager()
    manager.registerDevice({ device: { id: 'yey-fw-c', firmware: { version: '1.2.0' } } }, auth)
    manager.registerDevice({ device: { id: 'yey-fw-c', firmware: { version: '1.5.0' } } }, auth)
    assert.strictEqual(reloads(manager, 'yey-fw-c').length, 1, 're-registration with a new version re-pushes')
    assert.strictEqual(manager.store.registry.devices['yey-fw-c'].lastSeenFirmwareVersion, '1.5.0')
  }

  // ---- 4. the last-seen version survives a manager restart -----------------
  {
    const { manager, auth, app } = makeManager()
    manager.registerDevice({ device: { id: 'yey-fw-d', firmware: { version: '2.0.0' } } }, auth)
    const restarted = new YeyBoatsDisplayManager(app, manager.options)
    assert.strictEqual(restarted.store.registry.devices['yey-fw-d'].lastSeenFirmwareVersion, '2.0.0')
    heartbeat(restarted, 'yey-fw-d', auth, '2.0.0')
    assert.strictEqual(reloads(restarted, 'yey-fw-d').length, 0)
    heartbeat(restarted, 'yey-fw-d', auth, '1.9.0')
    assert.strictEqual(reloads(restarted, 'yey-fw-d').length, 1)
  }

  // ---- 5. devices registered before #26 (no lastSeenFirmwareVersion) -------
  // fall back to the stored firmware record as the previous version.
  {
    const { manager, auth } = makeManager()
    manager.registerDevice({ device: { id: 'yey-fw-e', firmware: { version: '1.0.0' } } }, auth)
    delete manager.store.registry.devices['yey-fw-e'].lastSeenFirmwareVersion
    heartbeat(manager, 'yey-fw-e', auth, '0.9.0')
    assert.strictEqual(reloads(manager, 'yey-fw-e').length, 1)
  }
})()
