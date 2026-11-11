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
const crypto = require('crypto')
const fs = require('fs')
const { makeManager, makeSecureManager } = require('./test-utils')
const { YeyBoatsDisplayManager } = require('../lib/manager')

function reloads (manager, id) {
  return manager.pendingCommands(id).filter((c) => c.type === 'config.reload')
}

function auditCount (manager, re) {
  let text = ''
  try { text = fs.readFileSync(manager.store.auditFile, 'utf8') } catch (e) {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => re.test(e.type)).length
}

const bearer = (t) => ({ bearer: t, provision: null })

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

  // ---- 6. PR #27 review: version flapping is coalesced and rate-limited ----
  {
    const { manager } = makeSecureManager()
    const api = manager.apiToken.pendingReveal()
    const tok = manager.registerDevice({ device: { id: 'yey-fw-f', firmware: { version: '1.4.0' } } }, bearer(api)).deviceToken
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    try {
      const n0 = manager.store.commands.commands.length
      const a0 = auditCount(manager, /^device\.firmware\./)
      for (let i = 0; i < 2000; i++) {
        manager.updateStatus('yey-fw-f', { firmware: { version: i % 2 ? '1.4.0' : '1.2.0' } }, bearer(tok))
      }
      const added = manager.store.commands.commands.length - n0
      assert.ok(added <= 1, `2000 flaps queued ${added} commands`)
      assert.ok(reloads(manager, 'yey-fw-f').length <= 1, 'at most one pending re-push')
      const audits = auditCount(manager, /^device\.firmware\./) - a0
      assert.ok(audits >= 2 && audits <= 3, `${audits} firmware audit lines`)
      assert.ok(auditCount(manager, /^device\.firmware\.flapping$/) >= 1, 'flapping is audited')
      // After the rate-limit window a change re-pushes again, replacing (not
      // appending to) any re-push still pending.
      offset += 11 * 60 * 1000
      manager.updateStatus('yey-fw-f', { firmware: { version: '1.3.0' } }, bearer(tok))
      assert.strictEqual(reloads(manager, 'yey-fw-f').length, 1)
      const flaps = manager.store.registry.devices['yey-fw-f'].firmwareRepush
      assert.ok(flaps && flaps.lastAt, 'last re-push recorded')
    } finally {
      Date.now = realNow
    }
    manager.close()
  }

  // ---- 7. a pending config.reload is replaced, not appended to -------------
  {
    const { manager, auth } = makeManager()
    manager.registerDevice({ device: { id: 'yey-fw-g', firmware: { version: '1.4.0' } } }, auth)
    manager.queueConfigReload('yey-fw-g')
    heartbeat(manager, 'yey-fw-g', auth, '1.2.0')
    const pending = reloads(manager, 'yey-fw-g')
    assert.strictEqual(pending.length, 1, 'still one pending config.reload')
    assert.strictEqual(pending[0].payload.hash, manager.generateConfig('yey-fw-g').hash)
  }

  // ---- 8. the shared yeyboats-dev token never triggers a re-push -----------
  {
    const { manager } = makeSecureManager()
    const api = manager.apiToken.pendingReveal()
    manager.registerDevice({ device: { id: 'yey-fw-l', firmware: { version: '1.4.0' } } }, bearer(api))
    const d = manager.store.registry.devices['yey-fw-l']
    d.legacyTokenHash = `sha256:${crypto.createHash('sha256').update('yeyboats-dev').digest('hex')}`
    d.deviceTokenHash = null
    const n0 = manager.store.commands.commands.length
    for (let i = 0; i < 200; i++) {
      manager.updateStatus('yey-fw-l', { firmware: { version: i % 2 ? '1' : '2' } }, bearer('yeyboats-dev'))
    }
    assert.strictEqual(manager.store.commands.commands.length - n0, 0, 'untrusted principal: no commands')
    assert.strictEqual(auditCount(manager, /^device\.firmware\.changed$/), 0)
    manager.close()
  }

  // ---- 9. completed / expired commands are pruned --------------------------
  {
    const { manager, auth } = makeManager()
    manager.registerDevice({ device: { id: 'yey-fw-p' } }, auth)
    for (let i = 0; i < 300; i++) {
      const c = manager.createCommand('yey-fw-p', { type: 'noop' })
      manager.ackCommand('yey-fw-p', c.id, { result: { ok: true } }, auth)
    }
    for (let i = 0; i < 300; i++) {
      manager.createCommand('yey-fw-p', { type: 'noop', expiresAt: new Date(Date.now() - 1000).toISOString() })
    }
    manager.expireCommands()
    const left = manager.store.commands.commands.filter((c) => c.deviceId === 'yey-fw-p').length
    assert.ok(left <= 50, `${left} finished commands kept`)
  }
})()
