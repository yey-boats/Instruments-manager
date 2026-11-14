'use strict'
// Dashboards the boat's owner or crew saved on yey.boats, read in-process
// from the yey connector (signalk-yey-connector 0.5.1+). The connector
// exposes `app.yeyDashboards`; every method returns a Promise and rejects
// with an Error carrying `.code`:
//   state()     -> {connected, linked, user_label, expires_at,
//                   pending: {code, verify_url, expires_at} | null}
//   linkStart() -> {code, verify_url, expires_at}   ("sign in with yey.boats")
//   linkPoll()  -> {status: 'pending'|'approved'|'rejected'|'expired',
//                   user_label?, expires_at?}
//   list()      -> {dashboards: [{id, title, targetClass, updatedAt}], user_label}
//   get(id)     -> {id, title, targetClass, updatedAt, doc}  (doc: MIDL JSON or YAML text)
//   unlink()    -> signs out
// list() and get() reject `not_connected`, `not_linked` or `grant_invalid`
// (get() also `not_found`). Dashboards are readable only after someone
// proved a yey.boats login (the boat's owner or crew) through the link flow.
//
// The states, explicit:
//   connector_missing  the connector's API is absent (no connector, or older than 0.5.1)
//   not_connected      the connector is not connected to yey.boats
//   not_linked         nobody signed in (or the sign-in is no longer valid)
//   pending            a sign-in is waiting for approval on yey.boats
//   linked             signed in as user_label until expires_at, with the list
//   error              the connector failed or did not answer
// Every string here comes from the cloud; callers escape it when rendering.

const SOURCE = 'yey.boats'
const TIMEOUT_MS = 8000
const MAX_TEXT = 200
const LINK_STATUSES = ['pending', 'approved', 'rejected', 'expired']

const MESSAGES = {
  connector_missing: 'The yey connector is not installed, or is older than 0.5.1. Install or update signalk-yey-connector on this server to see your yey.boats dashboards here.',
  not_connected: 'The yey connector is not connected to yey.boats. Check its settings and the boat’s internet connection.',
  not_linked: 'Sign in with your yey.boats account (the boat’s owner or crew) to see your dashboards here.',
  grant_invalid: 'The yey.boats sign-in on this boat is no longer valid. Sign in again.',
  not_found: 'That dashboard is no longer on yey.boats.'
}
const EMPTY_HINT = 'No dashboards on yey.boats yet. Save one on yey.boats/instruments and it shows up here.'

class CloudError extends Error {
  constructor (code, message) {
    super(message)
    this.code = code
  }
}

// signalk-yey-connector (>= 0.5.1) publishes its API process-wide under this
// symbol: SignalK gives each plugin its own shallow copy of `app`
// (signalk-server interfaces/plugins.js: lodash.assign({}, app, ...)), so the
// connector's `app.yeyDashboards` is never visible on OUR app. `app.yeyDashboards`
// is still read as a fallback (tests, or a server that shares one app object).
const DASHBOARDS_KEY = Symbol.for('yey-boats.dashboards')

function apiOf (app) {
  const api = globalThis[DASHBOARDS_KEY] || (app && app.yeyDashboards)
  const methods = ['state', 'linkStart', 'linkPoll', 'list', 'get', 'unlink']
  if (!api || typeof api !== 'object' || methods.some((m) => typeof api[m] !== 'function')) {
    throw new CloudError('connector_missing', MESSAGES.connector_missing)
  }
  return api
}

const text = (v) => (v === undefined || v === null ? '' : String(v).slice(0, MAX_TEXT))

// Only an absolute https URL goes into an href; anything else is shown as
// text only (callers check `verify_url_safe`).
function safeHttpsUrl (v) {
  const s = text(v)
  try {
    const u = new URL(s)
    return u.protocol === 'https:' && !/[\s"'<>]/.test(s) ? u.href : null
  } catch (e) {
    return null
  }
}

function timeOf (v) {
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

function withTimeout (promise, ms) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new CloudError('timeout', `no answer from the yey connector within ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

// Calls one connector method; a synchronous throw counts as a rejection.
function invoke (app, method, args, opts) {
  return withTimeout(Promise.resolve().then(() => apiOf(app)[method](...(args || []))), (opts && opts.timeoutMs) || TIMEOUT_MS)
}

function codeOf (err) {
  return text(err && err.code) || 'error'
}

function errorMessage (err) {
  const code = codeOf(err)
  if (MESSAGES[code]) return MESSAGES[code]
  return `The yey connector failed: ${text((err && err.message) || err || 'unknown error')}`
}

// The profile already made from cloud dashboard `id`, if any.
function profileForSource (profiles, id) {
  return (profiles || []).find((p) => p && p.source === SOURCE && String(p.sourceId) === String(id)) || null
}

// 'new' (never imported), 'update' (the cloud copy is newer than the
// import) or 'current'.
function importState (entry, profile) {
  if (!profile) return 'new'
  const cloud = timeOf(entry.updatedAt)
  const local = timeOf(profile.sourceUpdatedAt)
  if (cloud !== null && (local === null || cloud > local)) return 'update'
  return 'current'
}

function mapListing (dashboards, profiles) {
  return (Array.isArray(dashboards) ? dashboards : [])
    .filter((v) => v && typeof v === 'object' && v.id !== undefined && v.id !== null && String(v.id) !== '')
    .map((v) => {
      const entry = {
        id: text(v.id),
        title: text(v.title) || text(v.id),
        targetClass: text(v.targetClass),
        updatedAt: text(v.updatedAt)
      }
      const profile = profileForSource(profiles, entry.id)
      entry.profileId = profile ? profile.id : null
      entry.importedUpdatedAt = profile ? (profile.sourceUpdatedAt || null) : null
      entry.state = importState(entry, profile)
      return entry
    })
    .sort((a, b) => (timeOf(b.updatedAt) || 0) - (timeOf(a.updatedAt) || 0) || a.title.localeCompare(b.title))
}

function pendingOf (p) {
  if (!p || typeof p !== 'object') return null
  return { code: text(p.code), verify_url: text(p.verify_url), verify_url_safe: safeHttpsUrl(p.verify_url), expires_at: text(p.expires_at) }
}

function fromError (err, extra) {
  const code = codeOf(err)
  if (code === 'connector_missing' || code === 'not_connected' || code === 'not_linked') {
    return Object.assign({ state: code, message: MESSAGES[code] }, extra || {})
  }
  if (code === 'grant_invalid') {
    return Object.assign({ state: 'not_linked', reason: 'grant_invalid', message: MESSAGES.grant_invalid }, extra || {})
  }
  return Object.assign({ state: 'error', reason: code, message: errorMessage(err) }, extra || {})
}

// The panel's state. Never rejects. With a sign-in pending it polls once,
// so a plain page reload also moves on once the sign-in is approved.
// -> {state, message?, reason?, user_label?, expires_at?, pending?,
//     dashboards?, link?: 'rejected'|'expired'}
async function cloudState (app, profiles, opts) {
  let s
  try {
    s = await invoke(app, 'state', [], opts)
  } catch (err) {
    return fromError(err)
  }
  s = s && typeof s === 'object' ? s : {}
  if (!s.connected) return { state: 'not_connected', message: MESSAGES.not_connected }
  let link = null
  if (!s.linked && s.pending) {
    let poll
    try {
      poll = await invoke(app, 'linkPoll', [], opts)
    } catch (err) {
      return fromError(err)
    }
    const status = poll && LINK_STATUSES.includes(poll.status) ? poll.status : 'pending'
    if (status === 'pending') {
      return { state: 'pending', pending: pendingOf(s.pending) }
    }
    if (status === 'approved') {
      // Once: a connector still reporting the sign-in as pending after
      // approving it must not loop.
      if (!(opts && opts.afterApproval)) return cloudState(app, profiles, Object.assign({}, opts, { afterApproval: true }))
      return { state: 'pending', pending: pendingOf(s.pending) }
    }
    link = status
  }
  if (!s.linked) {
    return Object.assign({ state: 'not_linked', message: MESSAGES.not_linked }, link ? { link } : {})
  }
  try {
    const r = await invoke(app, 'list', [], opts)
    return {
      state: 'linked',
      user_label: text((r && r.user_label) || s.user_label),
      expires_at: text(s.expires_at),
      dashboards: mapListing(r && r.dashboards, profiles)
    }
  } catch (err) {
    return fromError(err)
  }
}

// HTTP status for a connector refusal on an action route.
function statusFor (code) {
  if (code === 'connector_missing' || code === 'timeout') return 503
  if (code === 'not_found') return 404
  if (code === 'not_connected' || code === 'not_linked' || code === 'grant_invalid') return 409
  return 502
}

function toHttpError (err) {
  if (err && err.payload) return err
  const code = codeOf(err)
  return httpError(statusFor(code), code === 'error' ? 'cloud_failed' : `cloud_${code}`, errorMessage(err), { reason: code })
}

// "Sign in with yey.boats": -> {code, verify_url, verify_url_safe, expires_at}
async function startLink (app, opts) {
  try {
    const r = await invoke(app, 'linkStart', [], opts)
    return pendingOf(r) || { code: '', verify_url: '', verify_url_safe: null, expires_at: '' }
  } catch (err) {
    throw toHttpError(err)
  }
}

// -> {status, user_label?, expires_at?}
async function pollLink (app, opts) {
  try {
    const r = await invoke(app, 'linkPoll', [], opts)
    const status = r && LINK_STATUSES.includes(r.status) ? r.status : 'pending'
    const out = { status }
    if (status === 'approved') {
      if (r.user_label) out.user_label = text(r.user_label)
      if (r.expires_at) out.expires_at = text(r.expires_at)
    }
    return out
  } catch (err) {
    throw toHttpError(err)
  }
}

async function unlink (app, opts) {
  try {
    await invoke(app, 'unlink', [], opts)
    return { ok: true }
  } catch (err) {
    throw toHttpError(err)
  }
}

// -> {id, title, targetClass, updatedAt, doc}; throws an http error
// (404 not_found, 409 not connected / not signed in, 503 connector missing
// or silent, 502 otherwise or for a doc-less answer).
async function fetchCloudDashboard (app, id, opts) {
  let r
  try {
    r = await invoke(app, 'get', [String(id)], opts)
  } catch (err) {
    throw toHttpError(err)
  }
  if (!r || typeof r !== 'object' || typeof r.doc !== 'string' || !r.doc.trim()) {
    throw httpError(502, 'cloud_dashboard_unavailable', 'yey.boats sent that dashboard without a document', { id: text(id) })
  }
  return {
    id: text(r.id || id),
    title: text(r.title) || text(id),
    targetClass: text(r.targetClass),
    updatedAt: text(r.updatedAt),
    doc: r.doc
  }
}

function httpError (status, code, message, details) {
  const err = new Error(message)
  err.status = status
  err.payload = { error: { code, message, details: details || {} } }
  return err
}

module.exports = {
  SOURCE,
  MESSAGES,
  EMPTY_HINT,
  cloudState,
  startLink,
  pollLink,
  unlink,
  fetchCloudDashboard,
  profileForSource,
  mapListing,
  safeHttpsUrl
}
