'use strict'
// Dashboards the boat owner saved on yey.boats, read in-process from the
// SignalK resources API. The signalk-yey-connector plugin (0.5.0+) registers
// a resource provider for the custom type `yey-dashboards`:
//   listResources('yey-dashboards', {}) -> {[id]: {name, title, targetClass, updatedAt}}
//   getResource('yey-dashboards', id)   -> {id, name, title, targetClass, updatedAt, doc}
// where `doc` is MIDL as JSON or YAML text. Either call rejects when the
// connector is missing, not paired or offline; this module turns every such
// case into a plain "unavailable" state with a reason, never a stack trace.

const RESOURCE_TYPE = 'yey-dashboards'
const SOURCE = 'yey.boats'
const TIMEOUT_MS = 8000
const MAX_TEXT = 200

const CONNECT_HINT = 'Connect this boat to yey.boats with the yey connector to see your dashboards here.'

class CloudUnavailable extends Error {
  constructor (reason, message) {
    super(message)
    this.reason = reason
  }
}

function resourcesApiOf (app) {
  const api = app && app.resourcesApi
  if (!api || typeof api.listResources !== 'function' || typeof api.getResource !== 'function') {
    throw new CloudUnavailable('resources_api_missing',
      'This SignalK server has no resources API, so dashboards from yey.boats cannot be read. ' + CONNECT_HINT)
  }
  return api
}

// A provider error, classified. The server answers an unregistered type
// with something like "No provider for yey-dashboards"; anything else is the
// connector itself refusing (not paired, offline, ...) and its message is
// passed on as the reason.
function classify (err) {
  if (err instanceof CloudUnavailable) return err
  const message = String((err && err.message) || err || 'unknown error')
  if (/no provider|not (a )?(valid|registered)|unknown resource|invalid resource type|unsupported resource/i.test(message)) {
    return new CloudUnavailable('connector_missing',
      'The yey connector is not installed or not running on this server. ' + CONNECT_HINT)
  }
  return new CloudUnavailable('connector_unavailable', `yey.boats is not reachable: ${message.slice(0, MAX_TEXT)}`)
}

function withTimeout (promise, ms) {
  let timer
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the yey connector within ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

const text = (v) => (v === undefined || v === null ? '' : String(v).slice(0, MAX_TEXT))

function timeOf (v) {
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
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

function mapListing (listing, profiles) {
  const entries = listing && typeof listing === 'object' && !Array.isArray(listing) ? Object.entries(listing) : []
  return entries
    .filter(([, v]) => v && typeof v === 'object')
    .map(([id, v]) => {
      const entry = {
        id: text(id),
        title: text(v.title) || text(v.name) || text(id),
        name: text(v.name),
        targetClass: text(v.targetClass),
        updatedAt: text(v.updatedAt)
      }
      const profile = profileForSource(profiles, id)
      entry.profileId = profile ? profile.id : null
      entry.importedUpdatedAt = profile ? (profile.sourceUpdatedAt || null) : null
      entry.state = importState(entry, profile)
      return entry
    })
    .sort((a, b) => (timeOf(b.updatedAt) || 0) - (timeOf(a.updatedAt) || 0) || a.title.localeCompare(b.title))
}

// -> {available: true, dashboards: [...]} or {available: false, reason, message}
async function listCloudDashboards (app, profiles, opts) {
  try {
    const api = resourcesApiOf(app)
    const listing = await withTimeout(api.listResources(RESOURCE_TYPE, {}), (opts && opts.timeoutMs) || TIMEOUT_MS)
    return { available: true, dashboards: mapListing(listing, profiles) }
  } catch (err) {
    const u = classify(err)
    return { available: false, reason: u.reason, message: u.message }
  }
}

// -> {id, name, title, targetClass, updatedAt, doc}; throws a 503
// (`cloud_unavailable`, with the reason) or a 404/502 for a missing or
// malformed resource.
async function fetchCloudDashboard (app, id, opts) {
  let r
  try {
    const api = resourcesApiOf(app)
    r = await withTimeout(api.getResource(RESOURCE_TYPE, id), (opts && opts.timeoutMs) || TIMEOUT_MS)
  } catch (err) {
    const u = classify(err)
    throw httpError(503, 'cloud_unavailable', u.message, { reason: u.reason })
  }
  if (!r || typeof r !== 'object') throw httpError(404, 'cloud_dashboard_not_found', `no dashboard ${text(id)} on yey.boats`)
  const doc = r.doc
  if (typeof doc !== 'string' && !(doc && typeof doc === 'object')) {
    throw httpError(502, 'cloud_dashboard_invalid', 'the dashboard from yey.boats has no MIDL document')
  }
  return {
    id: text(r.id || id),
    name: text(r.name),
    title: text(r.title) || text(r.name) || text(id),
    targetClass: text(r.targetClass),
    updatedAt: text(r.updatedAt),
    doc
  }
}

function httpError (status, code, message, details) {
  const err = new Error(message)
  err.status = status
  err.payload = { error: { code, message, details: details || {} } }
  return err
}

module.exports = {
  RESOURCE_TYPE,
  SOURCE,
  CONNECT_HINT,
  listCloudDashboards,
  fetchCloudDashboard,
  profileForSource,
  mapListing
}
