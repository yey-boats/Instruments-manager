const assert = require('assert')
const { makeManager } = require('./test-utils')

const { manager, auth } = makeManager({
  auth: { mode: 'dev-shared-token', devToken: 'test-token' },
  network: { domain: 'local', hostnamePrefix: 'yey-d', namingPolicy: 'device-id' }
})

const reg = manager.registerDevice({
  device: {
    id: 'yey-d-aabbccddeeff',
    name: 'Bench Display',
    board: 'esp32-4848s040',
    mac: 'AA:BB:CC:DD:EE:FF',
    firmware: { version: '0.4.0' },
    capabilities: { touch: true, ota: true }
  }
}, auth)

assert.strictEqual(reg.status, 'registered')
assert.strictEqual(reg.deviceId, 'yey-d-aabbccddeeff')

const status = manager.updateStatus('yey-d-aabbccddeeff', {
  network: {
    hostname: 'yey-d-aabbccddeeff',
    domain: 'local',
    fqdn: 'yey-d-aabbccddeeff.local',
    ip: '192.168.1.42'
  },
  config: { hash: 'old' }
}, auth)

assert.strictEqual(status.status, 'ok')
assert.strictEqual(status.desiredConfig.reload, true)

const config = manager.generateConfig('yey-d-aabbccddeeff')
assert.strictEqual(config.protocol, 'yeyboats.management.v2')
assert.strictEqual(config.network.fqdn, 'yey-d-aabbccddeeff.local')
assert.ok(config.hash.startsWith('sha256:'))

const command = manager.createCommand('yey-d-aabbccddeeff', {
  type: 'screen.set',
  payload: { screen: 'dashboard' }
})
assert.strictEqual(command.status, 'pending')

const commands = manager.getCommands('yey-d-aabbccddeeff', auth, 10)
assert.strictEqual(commands.commands.length, 1)
assert.strictEqual(commands.commands[0].status, 'delivered')

const ack = manager.ackCommand('yey-d-aabbccddeeff', command.id, {
  result: { ok: true, message: 'done' }
}, auth)
assert.strictEqual(ack.status, 'acknowledged')

const artifact = manager.addFirmwareArtifact({
  vendor: { id: 'yey-boats', name: 'Yey Boats Project' },
  product: { id: 'yey-display', name: 'YEY Display' },
  firmware: { version: '0.4.1' },
  compatibility: { boards: ['esp32-4848s040'] },
  file: { name: 'yey-display.bin', size: 123, sha256: 'sha256:test' }
})
assert.ok(artifact.artifactId)

const job = manager.createFirmwareJob('yey-d-aabbccddeeff', {
  artifactId: artifact.artifactId
})
assert.strictEqual(job.status, 'queued')
