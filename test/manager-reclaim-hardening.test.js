// instruments-manager#25, review of PR #28:
//
//   1. capabilities.pairingCode is sticky once a display has advertised it: a
//      re-registration (possibly on a stolen token) cannot switch the code
//      gate off, nor lower any recorded capability. Only an operator clears it.
//   2. Anonymous sightings: a few flooding LAN hosts cannot starve real
//      displays (refreshes, a brand-new display) nor evict their records.
//   3. Failed sign-ins that were not audited one by one are written as a
//      summary line on a timer / on close, not only with the next failure.
const assert = require('assert')
const fs = require('fs')
const { makeSecureManager } = require('./test-utils')

const bearer = (t) => ({ bearer: t, provision: null })

function auditLines (manager, type) {
  let text = ''
  try { text = fs.readFileSync(manager.store.auditFile, 'utf8') } catch (e) {}
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type)
}

module.exports = (async () => {
  // ---- 1. capability lie ----------------------------------------------------
  {
    const { manager } = makeSecureManager()
    const api = manager.apiToken.pendingReveal()
    const a = manager.registerDevice({ device: { id: 'yey-d-p', capabilities: { pairingCode: true, widgets: ['a'] } } }, bearer(api))
    const old = a.deviceToken
    assert.throws(() => manager.reclaimDevice('yey-d-p', {}), (e) => e.status === 409 && e.payload.error.code === 'pairing_code_required')

    // A thief with the stolen token re-registers claiming no capabilities.
    try { manager.registerDevice({ device: { id: 'yey-d-p', capabilities: {} } }, bearer(old)) } catch (e) {}
    const caps = manager.getDevice('yey-d-p').capabilities
    assert.strictEqual(caps.pairingCode, true, 'pairingCode stays recorded')
    assert.deepStrictEqual(caps.widgets, ['a'], 'capabilities never change downward on re-registration')
    assert.throws(() => manager.reclaimDevice('yey-d-p', {}), (e) => e.status === 409 && e.payload.error.code === 'pairing_code_required',
      'Re-claim still needs the code after the lie')
    // Also with pairing_code: false explicitly.
    try { manager.registerDevice({ device: { id: 'yey-d-p', capabilities: { pairingCode: false, pairing_code: false } } }, bearer(old)) } catch (e) {}
    assert.ok(manager.deviceSupportsPairingCode(manager.getDevice('yey-d-p')))

    // A newer firmware may still add capabilities.
    try { manager.registerDevice({ device: { id: 'yey-d-p', capabilities: { touch: true } } }, bearer(old)) } catch (e) {}
    assert.strictEqual(manager.getDevice('yey-d-p').capabilities.touch, true)
    assert.strictEqual(manager.getDevice('yey-d-p').capabilities.pairingCode, true)

    // Only an operator clears it.
    const r = manager.clearPairingCodeRequirement('yey-d-p')
    assert.strictEqual(r.pairingCode, false)
    assert.ok(!manager.deviceSupportsPairingCode(manager.getDevice('yey-d-p')))
    assert.ok(auditLines(manager, 'device.pairing_code.cleared').length === 1)
    manager.close()
  }

  // ---- 2. discovery starvation ---------------------------------------------
  {
    const { manager } = makeSecureManager()
    let t = 1e12
    const realNow = Date.now
    Date.now = () => t
    try {
      for (let i = 0; i < 5; i++) assert.ok(manager.noteRejectedRegistration({ device: { id: `yey-real-${i}` } }, `10.0.0.${10 + i}`))
      manager.recordDiscoveredDevice({ id: 'yey-udp-1', address: '10.0.0.50', source: 'announcement' })
      let n = 0
      let realOk = 0
      let realTries = 0
      let newSeen = false
      for (let min = 0; min < 5; min++) {
        t += 60000
        for (let a = 0; a < 6; a++) {
          for (let k = 0; k < 5; k++) manager.noteRejectedRegistration({ device: { id: `yey-evil-${n++}` } }, `fe80::${a}`)
        }
        t += 30000
        for (let i = 0; i < 5; i++) {
          realTries++
          if (manager.noteRejectedRegistration({ device: { id: `yey-real-${i}` } }, `10.0.0.${10 + i}`)) realOk++
        }
        if (min === 0) newSeen = Boolean(manager.noteRejectedRegistration({ device: { id: 'yey-new' } }, '10.0.0.99'))
      }
      const d = manager.store.discovery.devices
      const ids = Object.keys(d)
      assert.strictEqual(realOk, realTries, `real refreshes accepted ${realOk}/${realTries}`)
      assert.ok(newSeen, 'a brand-new display is recorded during the flood')
      assert.ok(d['yey-new'], 'and kept')
      assert.strictEqual(ids.filter((x) => x.startsWith('yey-real')).length, 5, 'real sightings never evicted')
      assert.ok(d['yey-udp-1'], 'UDP-discovered record kept')
      assert.ok(ids.length <= 64, `${ids.length} records`)

      // Fill everything: still at least one (the newest) record per address.
      for (let min = 0; min < 30; min++) {
        t += 60000
        for (let a = 0; a < 40; a++) {
          for (let k = 0; k < 3; k++) manager.noteRejectedRegistration({ device: { id: `yey-spray-${n++}` } }, `fe80::1:${a}`)
        }
      }
      const after = Object.keys(manager.store.discovery.devices)
      assert.ok(after.length <= 65, `${after.length} records`)
      assert.strictEqual(after.filter((x) => x.startsWith('yey-real')).length, 5, 'one-record addresses survive a full table')
      assert.ok(manager.store.discovery.devices['yey-new'])

      // An anonymous register never rewrites a UDP/announcement record.
      const before = JSON.stringify(manager.store.discovery.devices['yey-udp-1'])
      manager.noteRejectedRegistration({ device: { id: 'yey-udp-1' } }, '6.6.6.6')
      assert.strictEqual(JSON.stringify(manager.store.discovery.devices['yey-udp-1']), before)
    } finally {
      Date.now = realNow
      manager.close()
    }
  }

  // ---- 3. failed-login summary on a timer -----------------------------------
  {
    const { manager } = makeSecureManager()
    const t = 1e12
    for (let i = 0; i < 5000; i++) manager.auditFailedLogin(t + i)
    assert.ok(auditLines(manager, 'manager.login.failed').length <= 10)
    // Attempts stop. The periodic flush writes the count without a new failure.
    manager.flushLoginFailureSummary(t + 61000)
    const s = auditLines(manager, 'manager.login.failed.summary')
    assert.strictEqual(s.length, 1, 'one summary line')
    assert.strictEqual(s[0].data.suppressed, 4990)
    manager.flushLoginFailureSummary(t + 122000)
    assert.strictEqual(auditLines(manager, 'manager.login.failed.summary').length, 1, 'nothing to report: no line')
    assert.ok(manager._loginSummaryTimer, 'a summary timer runs')
    // Pending count is also written on close.
    for (let i = 0; i < 20; i++) manager.auditFailedLogin(t + 200000 + i)
    manager.close()
    const s2 = auditLines(manager, 'manager.login.failed.summary')
    assert.strictEqual(s2.length, 2)
    assert.strictEqual(s2[1].data.suppressed, 10)
    assert.strictEqual(manager._loginSummaryTimer, null)
  }
})()
