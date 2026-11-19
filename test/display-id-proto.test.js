'use strict'
// #88: display ids that name Object.prototype members ('__proto__',
// 'constructor', 'toString', ...) must never reach a device lookup as if they
// were a registered display. Before the fix, show_dashboard with
// displayIds: ['__proto__'] answered "queued" and wrote assignedProfile,
// updatedAt and midlDelivery onto Object.prototype for the whole SignalK
// process, breaking every later MIDL validation until a restart.
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert')
const plugin = require('..')
const cloudShow = require('../lib/cloud-show')
const { isDisplayId } = require('../lib/util')
const { makeSecureManager } = require('./test-utils')

const needsBuild = { skip: !fs.existsSync(path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs')) && 'midl not built' }
const RESERVED = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']

function midlDoc () {
  return {
    midl: '1.0.0',
    meta: { title: 'P' },
    screens: [{
      id: 'dash',
      title: 'P',
      elements: { e0: { type: 'single-value', name: 'SOG', bindings: { value: { kind: 'signalk', path: 'navigation.speedOverGround' } } } },
      layout: { rows: 1, cols: 1, cells: [{ element: 'e0' }] }
    }]
  }
}

// Every key a polluted prototype would expose on a plain {}.
function pollution () {
  const probe = {}
  return ['assignedProfile', 'updatedAt', 'midlDelivery', 'overrides', 'lastSeen'].filter((k) => probe[k] !== undefined)
}

function rig () {
  const { manager } = makeSecureManager({ midl: { push: true } })
  const token = manager.apiToken.pendingReveal()
  manager.registerDevice({ device: { id: 'yey-d-helm', display: { width: 480, height: 480 } } }, { bearer: token })
  return { manager, token }
}

test('isDisplayId: the registry id grammar, never an Object.prototype member', () => {
  for (const ok of ['yey-d-helm', 'yey-d-001', 'esp32.cabin', 'a', 'x_1']) assert.ok(isDisplayId(ok), ok)
  for (const bad of [...RESERVED, '', ' ', 'Yey-D', 'a/b', '../x', 'a b', 'x'.repeat(65), null, undefined, 3, {}, ['a']]) {
    assert.ok(!isDisplayId(bad), JSON.stringify(bad))
  }
})

test('showDashboard: reserved display ids are unknown and pollute nothing', needsBuild, async () => {
  const { manager } = rig()
  try {
    const api = cloudShow.createApi(() => manager, plugin._test.displayApiDeps())
    for (const id of RESERVED) {
      const r = await api.showDashboard({ sourceId: `p-${id.replace(/[^a-z]/gi, '')}`, title: 'P', doc: midlDoc(), displayIds: [id] })
      assert.deepStrictEqual(r.results, [{ display_id: id, state: 'unknown_display' }], id)
      assert.deepStrictEqual(pollution(), [], `Object.prototype polluted after ${id}`)
    }
  } finally {
    manager.close()
  }
})

test('manager device lookups: a reserved id is not a device, and writes stay off the prototype', () => {
  const { manager, token } = rig()
  try {
    for (const id of RESERVED) {
      assert.throws(() => manager.getDevice(id), (e) => e.status === 404, `getDevice(${id})`)
      manager.noteMidlDelivery(id, { state: 'shown' })
      assert.throws(() => manager.assignProfile(id, { profileId: 'default' }), (e) => e.status === 404, `assignProfile(${id})`)
      // registerDevice lowercases ids first: 'toString' becomes the ordinary id
      // 'tostring'. Only an id still reserved after that must be refused.
      if (id === id.toLowerCase()) {
        assert.throws(() => manager.registerDevice({ device: { id } }, { bearer: token }), (e) => e.status === 400, `registerDevice(${id})`)
      }
      assert.deepStrictEqual(pollution(), [], `Object.prototype polluted after ${id}`)
    }
    // The registered display is unaffected.
    assert.strictEqual(manager.getDevice('yey-d-helm').id, 'yey-d-helm')
  } finally {
    manager.close()
  }
})

test('the stored maps carry no prototype: a JSON key "__proto__" is just a key', () => {
  const { manager } = rig()
  try {
    for (const map of [manager.store.registry.devices, manager.store.discovery.devices, manager.store.profiles.profiles]) {
      assert.strictEqual(Object.getPrototypeOf(map), null)
    }
  } finally {
    manager.close()
  }
})
