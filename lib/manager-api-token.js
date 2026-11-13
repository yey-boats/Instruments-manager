// Manager API token (instruments-manager#23).
//
// The manager used to accept the public string `yeyboats-dev` as its API
// credential. Now every install generates its own random token on first start
// and keeps it in `manager-api-token.json` in the plugin data dir, written
// 0600. Only a hash is kept long term: the plaintext stays in the file just
// until the SignalK admin has seen it once in the manager UI and pressed
// "I have saved it" (or until the token is rotated).
//
// The token is an OPERATOR/provisioning credential: it registers (pairs)
// displays, announces discovered devices and lets tooling read a device's
// config with secrets redacted. It is never a device credential; devices use
// their own per-device token.
//
// Never log the token or put it in an error message.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// 32 random bytes = 256 bits, base64url = 43 chars.
const API_TOKEN_BYTES = 32
const API_TOKEN_PREFIX = 'ybm_'

function generateApiToken () {
  return `${API_TOKEN_PREFIX}${crypto.randomBytes(API_TOKEN_BYTES).toString('base64url')}`
}

function hashApiToken (token) {
  return `sha256:${crypto.createHash('sha256').update(String(token || '')).digest('hex')}`
}

function safeEqual (a, b) {
  const aa = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb)
}

class ManagerApiTokenStore {
  constructor (dataDir) {
    this.file = path.join(dataDir, 'manager-api-token.json')
    this.data = null
    this.generated = false
  }

  // Load the token, generating one on first start.
  load () {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!this.data || typeof this.data.tokenHash !== 'string') throw Object.assign(new Error('invalid'), { code: 'EINVALID' })
      try { fs.chmodSync(this.file, 0o600) } catch (e) { /* best effort */ }
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'EINVALID' && !(err instanceof SyntaxError)) {
        throw new Error(`cannot read manager API token: ${err.code || 'invalid file'}`)
      }
      this.issue('generated')
      this.generated = true
    }
    return this
  }

  issue (reason) {
    const token = generateApiToken()
    const at = new Date().toISOString()
    this.data = {
      tokenHash: hashApiToken(token),
      createdAt: at,
      reason,
      // Shown once in the manager UI, then dropped by acknowledge().
      reveal: token,
      revealedAt: null
    }
    this.save()
    return token
  }

  rotate () {
    return this.issue('rotated')
  }

  verify (token) {
    if (!token || !this.data) return false
    return safeEqual(this.data.tokenHash, hashApiToken(token))
  }

  // The plaintext token while it still has to be shown to the admin, else null.
  pendingReveal () {
    return this.data && this.data.reveal ? this.data.reveal : null
  }

  acknowledge () {
    if (!this.data || !this.data.reveal) return false
    this.data.reveal = null
    this.data.revealedAt = new Date().toISOString()
    this.save()
    return true
  }

  status () {
    return {
      createdAt: this.data ? this.data.createdAt : null,
      reason: this.data ? this.data.reason : null,
      revealPending: Boolean(this.pendingReveal())
    }
  }

  save () {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    try { fs.unlinkSync(tmp) } catch (e) { /* not there */ }
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, this.file)
  }
}

module.exports = {
  ManagerApiTokenStore,
  generateApiToken,
  API_TOKEN_BYTES
}
