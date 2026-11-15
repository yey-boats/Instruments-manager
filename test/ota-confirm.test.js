// A display that rebooted into a new image confirms without a job id: it sends
// only its running build ({version, build_time, git_commit}), and a build
// without app rollback never confirms at all. Either way the job must not be
// left in "rebooting" once the display runs the artifact's version.
const assert = require('assert')
const { makeSecureManager } = require('./test-utils')

const bearer = (t) => ({ bearer: t, provision: null })
const { manager } = makeSecureManager()
const api = manager.apiToken.pendingReveal()
const device = {
  id: 'yey-d-0ca0c0ffee01',
  board: 'sunton_4848s040',
  chip: 'ESP32-S3',
  flashBytes: 16777216,
  psramBytes: 8388608,
  firmware: { name: 'yey-display', version: '0.4.0+209.gd9f27da2ce44' }
}
const reg = manager.registerDevice({ device }, bearer(api))
const dev = bearer(reg.deviceToken)

const artifact = manager.addFirmwareArtifact({
  vendor: { id: 'yey-boats', name: 'Yey Boats Project', trust: { level: 'local', allowUnsigned: true } },
  product: { id: 'yey-display', name: 'YEY Display' },
  firmware: { name: 'yey-display', version: '0.4.0+210.g5f011c146704', channel: 'dev' },
  compatibility: { boards: ['sunton_4848s040'], chip: 'ESP32-S3' },
  file: { name: 'fw.bin', size: 1000, sha256: 'sha256:' + 'a'.repeat(64) },
  signing: { signed: false }
})

function rebootingJob () {
  const job = manager.createFirmwareJob(device.id, { artifactId: artifact.artifactId })
  manager.updateFirmwareProgress(device.id, job.jobId, { state: 'rebooting' }, dev)
  assert.strictEqual(manager.getFirmwareJob(device.id, job.jobId).status, 'rebooting')
  return job
}

// 1. /firmware/confirm with the running build only (what the firmware sends).
{
  const job = rebootingJob()
  const out = manager.confirmFirmware(device.id, {
    version: '0.4.0+210.g5f011c146704', build_time: 'Nov 15 2026 20:40:00', git_commit: '5f011c146704'
  }, dev)
  assert.strictEqual(out.jobId, job.jobId)
  assert.strictEqual(manager.getFirmwareJob(device.id, job.jobId).status, 'confirmed')
}

// 2. A version no open job installs is still a 404 (nothing is confirmed).
{
  const job = rebootingJob()
  assert.throws(() => manager.confirmFirmware(device.id, { version: '9.9.9' }, dev), (e) => e.status === 404)
  assert.strictEqual(manager.getFirmwareJob(device.id, job.jobId).status, 'rebooting')

  // 3. ...and the heartbeat on the artifact's version completes it.
  manager.updateStatus(device.id, { firmware: { version: '0.4.0+210.g5f011c146704' } }, dev)
  assert.strictEqual(manager.getFirmwareJob(device.id, job.jobId).status, 'confirmed')
}

// 4. A heartbeat on another version leaves a rebooting job alone.
{
  const job = rebootingJob()
  manager.updateStatus(device.id, { firmware: { version: '0.4.0+209.gd9f27da2ce44' } }, dev)
  assert.strictEqual(manager.getFirmwareJob(device.id, job.jobId).status, 'rebooting')
  // An explicit job id still works as before.
  manager.confirmFirmware(device.id, { jobId: job.jobId }, dev)
  assert.strictEqual(manager.getFirmwareJob(device.id, job.jobId).status, 'confirmed')
}
