const assert = require('assert')
const { makeManager } = require('./test-utils')

module.exports = (async () => {
  const { manager, auth } = makeManager({
    auth: { mode: 'dev-shared-token', devToken: 'test-token' },
    firmware: { github: { enabled: false } }
  })
  const deviceId = 'yey-d-github-fw'
  manager.registerDevice({
    device: {
      id: deviceId,
      board: 'sunton_4848s040',
      chip: 'ESP32-S3',
      firmware: { name: 'yey-display', version: '0.5.0' }
    }
  }, auth)

  const githubFetch = async (url) => {
    if (url === 'https://api.github.com/repos/yey-boats/instruments/releases/latest') {
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v0.6.0',
          prerelease: false,
          html_url: 'https://github.com/yey-boats/instruments/releases/tag/v0.6.0',
          assets: [
            {
              name: 'esp32-4848s040-merged_firmware.bin',
              size: 2097152,
              content_type: 'application/octet-stream',
              browser_download_url: 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/esp32-4848s040-merged_firmware.bin'
            },
            {
              name: 'waveshare-touch-lcd-7b_1024x600-merged_firmware.bin',
              size: 2098000,
              content_type: 'application/octet-stream',
              browser_download_url: 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/waveshare-touch-lcd-7b_1024x600-merged_firmware.bin'
            },
            {
              name: 'SHA256SUMS',
              browser_download_url: 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/SHA256SUMS'
            }
          ]
        })
      }
    }
    if (url === 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/SHA256SUMS') {
      return {
        ok: true,
        text: async () => [
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  esp32-4848s040-merged_firmware.bin',
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  waveshare-touch-lcd-7b_1024x600-merged_firmware.bin'
        ].join('\n')
      }
    }
    throw new Error(`unexpected fetch URL ${url}`)
  }

  manager.options.firmware.github.enabled = true
  const refreshed = await manager.refreshFirmwareFromGithub(githubFetch)
  assert.strictEqual(refreshed.refreshed.release, 'v0.6.0')
  assert.strictEqual(refreshed.refreshed.imported, 2)

  const artifact = manager.getFirmwareArtifact('github-v0.6.0-esp32-4848s040')
  assert.strictEqual(artifact.firmware.version, '0.6.0')
  assert.deepStrictEqual(artifact.compatibility.boards, ['sunton_4848s040'])
  assert.strictEqual(artifact.compatibility.releaseTarget, 'esp32-4848s040')
  assert.strictEqual(artifact.file.sha256, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.strictEqual(artifact.file.url.endsWith('/esp32-4848s040-merged_firmware.bin'), true)

  const job = manager.createFirmwareJob(deviceId, { artifactId: artifact.artifactId })
  const command = manager.pendingCommands(deviceId).find((cmd) => {
    return cmd.type === 'firmware.update' && cmd.payload.jobId === job.jobId
  })
  assert.ok(command)
  // The device is handed the manager-relative proxy path, NOT the raw GitHub
  // URL: the heap-constrained ESP32 pulls over plain LAN HTTP while the manager
  // (host) does the GitHub TLS/redirects and streams the binary. (was:
  // artifact.file.url — the raw release asset URL; see commit ee48245.)
  assert.strictEqual(command.payload.url, `/firmware/download/${job.jobId}`)
  assert.strictEqual(command.payload.version, '0.6.0')
  assert.strictEqual(command.payload.sha256, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  // Companion: GET /firmware/download/:jobId actually streams the (mocked)
  // GitHub asset bytes for that job's artifact. We exercise the manager's
  // firmware binary path with a fetch that returns a body for the release
  // asset, and assert the bytes come back with the claimed hash header.
  {
    const FW_BYTES = Buffer.from('firmware-payload-bytes')
    const crypto = require('crypto')
    const realSha = crypto.createHash('sha256').update(FW_BYTES).digest('hex')
    // Re-import the release so its recorded sha matches the streamed bytes,
    // otherwise MGR-3's server-side verification (correctly) rejects it.
    const streamFetch = async (url) => {
      if (url === 'https://api.github.com/repos/yey-boats/instruments/releases/latest') {
        return {
          ok: true,
          json: async () => ({
            tag_name: 'v0.6.0',
            prerelease: false,
            html_url: 'https://github.com/yey-boats/instruments/releases/tag/v0.6.0',
            assets: [
              {
                name: 'esp32-4848s040-merged_firmware.bin',
                size: FW_BYTES.length,
                content_type: 'application/octet-stream',
                browser_download_url: 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/esp32-4848s040-merged_firmware.bin'
              },
              {
                name: 'SHA256SUMS',
                browser_download_url: 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/SHA256SUMS'
              }
            ]
          })
        }
      }
      if (url === 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/SHA256SUMS') {
        return {
          ok: true,
          text: async () => `${realSha}  esp32-4848s040-merged_firmware.bin`
        }
      }
      if (url === 'https://github.com/yey-boats/instruments/releases/download/v0.6.0/esp32-4848s040-merged_firmware.bin') {
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/octet-stream']]),
          arrayBuffer: async () => FW_BYTES.buffer.slice(FW_BYTES.byteOffset, FW_BYTES.byteOffset + FW_BYTES.byteLength)
        }
      }
      throw new Error(`unexpected fetch URL ${url}`)
    }
    await manager.refreshFirmwareFromGithub(streamFetch)
    const fs = require('fs')
    const streamed = await manager.firmwareArtifactBinary('github-v0.6.0-esp32-4848s040', streamFetch)
    assert.ok(streamed && streamed.path, 'firmwareArtifactBinary resolves to a cached path')
    const cachedBytes = fs.readFileSync(streamed.path)
    assert.strictEqual(cachedBytes.equals(FW_BYTES), true,
      'cached (and sha-verified) bytes match the mocked GitHub asset')
  }
})()
