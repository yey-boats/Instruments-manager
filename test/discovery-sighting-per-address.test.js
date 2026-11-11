// instruments-manager#29 (interim, until the on-screen pairing code of
// instruments#33): first-claim race on anonymous sightings.
//
//   1. An anonymous /devices/register never changes the address or the
//      capabilities of an existing sighting; a register for the same id from
//      another address is a new sighting of that id.
//   2. Claiming an anonymous sighting needs the operator to pick one of the
//      addresses seen for that id; the claim takes that sighting's details
//      and the token push goes only to that address.
//   3. The Claim control lists every address with first/last seen and makes
//      the operator choose one.
//   4. IPv6 rate limits bucket per /64: an address flood from one prefix does
//      not stop new real displays from being listed.
const assert = require('assert')
const { makeSecureManager } = require('./test-utils')
const plugin = require('../index.js')

module.exports = (async () => {
  // ---- 1-2. race: attacker cannot rewrite, operator picks the address -------
  {
    const { manager } = makeSecureManager()
    let t = 1e12
    const realNow = Date.now
    Date.now = () => t
    try {
      const real = () => manager.noteRejectedRegistration({ device: { id: 'yey-real', capabilities: { pairingCode: true } } }, '10.0.0.10')
      const evil = () => manager.noteRejectedRegistration({ device: { id: 'yey-real', name: 'x', capabilities: {} } }, '10.0.0.66')
      assert.ok(real(), 'real display sighted')
      evil()
      for (let m = 0; m < 5; m++) {
        t += 60000
        real()
        for (let k = 0; k < 5; k++) evil()
        const d = manager.store.discovery.devices['yey-real']
        assert.strictEqual(d.address, '10.0.0.10', 'an anonymous register never moves an existing sighting')
        assert.deepStrictEqual(d.capabilities, { pairingCode: true }, 'nor changes its capabilities')
      }
      const d = manager.store.discovery.devices['yey-real']
      const addrs = (d.sightings || []).map((s) => s.address).sort()
      assert.deepStrictEqual(addrs, ['10.0.0.10', '10.0.0.66'], 'one sighting per (id, address)')
      for (const s of d.sightings) {
        assert.ok(s.firstSeen && s.lastSeen, 'each sighting has first/last seen')
        assert.ok(s.seenCount >= 1)
      }
      const attacker = d.sightings.find((s) => s.address === '10.0.0.66')
      assert.deepStrictEqual(attacker.capabilities, {}, 'the second sighting keeps what it said')

      // The listing carries the sightings for the Claim dialog.
      const listed = manager.listDiscoveredDevices().devices.find((x) => x.deviceId === 'yey-real')
      assert.strictEqual(listed.sightings.length, 2)

      // No address chosen: refused.
      assert.throws(() => manager.claimDiscoveredDevice('yey-real', {}),
        (e) => e.status === 409 && e.payload.error.code === 'address_choice_required')
      // An address never seen for this id: refused.
      assert.throws(() => manager.claimDiscoveredDevice('yey-real', { address: '10.0.0.99' }),
        (e) => e.status === 400 && e.payload.error.code === 'address_not_seen')
      assert.ok(!manager.store.registry.devices['yey-real'], 'nothing registered by refused claims')

      // Operator picks the real display's address.
      manager.claimDiscoveredDevice('yey-real', { address: '10.0.0.10' })
      const dev = manager.store.registry.devices['yey-real']
      assert.strictEqual(dev.discovery.address, '10.0.0.10')
      assert.strictEqual(dev.capabilities.pairingCode, true, 'claim takes the chosen sighting\'s capabilities')
      assert.deepStrictEqual(dev.tokenDelivery.target, { host: '10.0.0.10', port: 80 }, 'token push pinned to the chosen address')

      const sent = []
      manager._postDeviceCommand = async (host, port, line) => { sent.push(`${host}:${port}`); throw new Error('unreachable in test') }
      await manager.pushDeviceManagerToken('yey-real')
      assert.ok(sent.length >= 1, 'a push was attempted')
      assert.ok(sent.every((h) => h === '10.0.0.10:80'), `token pushed only to the chosen address: ${sent.join(',')}`)
    } finally {
      Date.now = realNow
      manager.close()
    }
  }

  // Choosing the attacker's address is the operator's call, and then only it is used.
  {
    const { manager } = makeSecureManager()
    manager.noteRejectedRegistration({ device: { id: 'yey-r2', capabilities: { pairingCode: true } } }, '10.0.0.10')
    manager.noteRejectedRegistration({ device: { id: 'yey-r2', capabilities: {} } }, '10.0.0.66')
    manager.claimDiscoveredDevice('yey-r2', { address: '10.0.0.66' })
    const dev = manager.store.registry.devices['yey-r2']
    assert.strictEqual(dev.discovery.address, '10.0.0.66')
    assert.deepStrictEqual(dev.capabilities, {})
    manager.close()
  }

  // A single sighting still needs the explicit choice.
  {
    const { manager } = makeSecureManager()
    manager.noteRejectedRegistration({ device: { id: 'yey-one' } }, '10.0.0.20')
    assert.throws(() => manager.claimDiscoveredDevice('yey-one', {}),
      (e) => e.status === 409 && e.payload.error.code === 'address_choice_required')
    manager.claimDiscoveredDevice('yey-one', { address: '10.0.0.20' })
    assert.ok(manager.store.registry.devices['yey-one'])
    manager.close()
  }

  // Addresses per id are bounded.
  {
    const { manager } = makeSecureManager()
    let t = 1e12
    const realNow = Date.now
    Date.now = () => t
    try {
      for (let i = 0; i < 40; i++) {
        t += 60000
        manager.noteRejectedRegistration({ device: { id: 'yey-many' } }, `10.0.${i}.1`)
      }
      const d = manager.store.discovery.devices['yey-many']
      assert.ok(d.sightings.length <= 8, `${d.sightings.length} sightings`)
      assert.strictEqual(d.address, '10.0.0.1', 'the record\'s own address is still the first one')
    } finally {
      Date.now = realNow
      manager.close()
    }
  }

  // ---- 3. Claim control -------------------------------------------------------
  {
    const render = plugin.__renderDiscoveryClaimControl
    assert.strictEqual(typeof render, 'function', 'claim control renderer exported for tests')
    const device = {
      deviceId: 'yey-real',
      address: '10.0.0.10',
      port: 80,
      source: 'register-rejected',
      sightings: [
        { address: '10.0.0.10', port: 80, firstSeen: '2026-11-11T10:00:00.000Z', lastSeen: '2026-11-11T10:05:00.000Z', seenCount: 6 },
        { address: '10.0.0.66', port: 80, firstSeen: '2026-11-11T10:01:00.000Z', lastSeen: '2026-11-11T10:05:30.000Z', seenCount: 26 }
      ]
    }
    const html = render(device, [{ id: 'default', name: 'Default' }])
    for (const s of device.sightings) {
      assert.ok(html.includes(`value="${s.address}"`), `address ${s.address} offered`)
      assert.ok(html.includes(s.firstSeen) && html.includes(s.lastSeen), 'first/last seen shown')
    }
    assert.ok(/type="radio"[^>]*name="address"[^>]*required/.test(html), 'operator must pick one')
    assert.ok(!/name="address"[^>]*checked/.test(html), 'none preselected')
  }

  // ---- 4. IPv6 /64 buckets ------------------------------------------------------
  {
    const { manager } = makeSecureManager()
    let t = 1e12
    const realNow = Date.now
    Date.now = () => t
    try {
      for (let i = 0; i < 5; i++) manager.noteRejectedRegistration({ device: { id: `yey-real-${i}` } }, `10.0.0.${10 + i}`)
      let n = 0
      let realOk = 0
      let tries = 0
      const newSeen = []
      for (let min = 0; min < 15; min++) {
        for (let a = 0; a < 300; a++) {
          manager.noteRejectedRegistration({ device: { id: `yey-evil-${n++}` } }, '2001:db8::' + (min * 1000 + a).toString(16))
        }
        t += 30000
        for (let i = 0; i < 5; i++) {
          tries++
          if (manager.noteRejectedRegistration({ device: { id: `yey-real-${i}` } }, `10.0.0.${10 + i}`)) realOk++
        }
        newSeen.push(manager.noteRejectedRegistration({ device: { id: `yey-new-${min}` } }, `10.0.1.${min}`) ? 1 : 0)
        t += 30000
      }
      const ids = Object.keys(manager.store.discovery.devices)
      assert.strictEqual(realOk, tries, `real refreshes ${realOk}/${tries}`)
      assert.strictEqual(newSeen.join(''), '1'.repeat(15), 'a new real display is listed every minute of the flood')
      assert.ok(ids.filter((x) => x.startsWith('yey-evil')).length <= 4, 'one /64 holds no more than one address\'s share')
      assert.ok(manager._sightingLimits.byAddress.size <= 30, 'limiter keyed per /64')
    } finally {
      Date.now = realNow
      manager.close()
    }
  }
})()
