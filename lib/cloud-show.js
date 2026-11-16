'use strict'
// Display Manager's in-process API for the yey connector (provisioning
// contract v1, section 2): the connector's `displays` / `show_dashboard`
// RPC ops call it so the boat's owner can put a yey.boats dashboard on a
// display from yey.boats (route A, push over the connector link).
//
// Published process-wide while the plugin runs, because SignalK gives each
// plugin its own shallow copy of `app` (see lib/cloud-dashboards.js):
//   globalThis[Symbol.for('yey-boats.display-manager')] =
//     { version: 1, listDisplays, showDashboard }
//
// listDisplays() -> Promise<[{ id, name, class, online,
//                              screen: {id, title, record} | null,
//                              preset: {id, name} | null }]>
// showDashboard({ sourceId, title, updatedAt, doc, screen, displayIds, requestedBy })
//   -> Promise<{ preset: {id, name, created},
//                results: [{ display_id, state, screen?, error? }] }>
//   state: shown (pushed + activated) | queued (offline / pull fallback:
//   shown when it connects) | refused (error: the class gate / display
//   validator message; nothing assigned) | unknown_display
//   Rejects { code: 'invalid_dashboard', message } when the doc is not MIDL,
//   fails validation for its own class and every target, names a screen it
//   does not have, or the store-time gate refuses it for a display already
//   showing that preset; { code: 'bad_request' } for a call without a
//   sourceId or displays; { code: 'unavailable' } while the plugin is stopped.
// Who may call it (the boat's owner, the on-board switch, the envelope) is
// decided by the connector and yey.boats before this is reached.

const midlRecords = require('./midl-records')

const API_KEY = Symbol.for('yey-boats.display-manager')
const VERSION = 1
const MAX_TEXT = 200
const DELIVERY_WAIT_MS = 12000 // the connector gives up after 15 s

const text = (v) => (v === undefined || v === null ? '' : String(v).slice(0, MAX_TEXT))

function fail (code, message) {
  return Object.assign(new Error(message), { code })
}

function screenOf (manager, device) {
  const ui = device.status && device.status.ui
  let current = ui && ui.screen
  if (current && typeof current === 'object') current = current.id
  if (!current) return null
  current = String(current)
  let screens = []
  try { screens = manager.deviceScreens(device.id) } catch (e) { screens = [] }
  const s = screens.find((x) => x.id === current)
  return s ? { id: s.id, title: s.title || s.id, record: s.record || null } : { id: current, title: current, record: null }
}

function listDisplays (manager) {
  return Object.values(manager.store.registry.devices)
    .filter((d) => d && d.id)
    .map((device) => {
      let profile = null
      try { profile = manager.deviceProfile(device.id) } catch (e) { profile = null }
      return {
        id: device.id,
        name: device.name || device.id,
        class: manager.deviceMidlClass(device),
        online: manager.isDeviceOnline(device),
        screen: screenOf(manager, device),
        preset: profile ? { id: profile.id, name: profile.name || profile.id } : null
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

// "fails validation for square-480: /screens/0/... message; ..."
function issuesText (check) {
  const issues = (check.issues || []).slice(0, 3).map((i) => [i.path, i.message].filter(Boolean).join(' ')).filter(Boolean)
  const more = (check.issues || []).length > issues.length ? ` (and ${check.issues.length - issues.length} more)` : ''
  return `the dashboard fails MIDL validation for ${check.className}` + (issues.length ? `: ${issues.join('; ')}${more}` : '')
}

// The delivery outcome (Manager#_deliverMidl) as a per-display result.
function resultOf (id, screen, outcome) {
  if (!outcome) return { display_id: id, state: 'queued', screen }
  if (outcome.state === 'pushed') return { display_id: id, state: 'shown', screen }
  if (outcome.state === 'refused') return { display_id: id, state: 'refused', error: text(outcome.error) || 'the display refused the dashboard' }
  // Pull fallback (offline, pull-only, push failed, ...), push turned off,
  // or a delivery error: the assignment is stored and the display takes it
  // (config.reload / its next heartbeat), showing `screen` when it does.
  return { display_id: id, state: 'queued', screen }
}

function settleWithin (promise, ms) {
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ state: 'delivering' }), ms) })
  return Promise.race([promise.catch((err) => ({ state: 'error', error: String((err && err.message) || err) })), late])
    .finally(() => clearTimeout(timer))
}

// deps: { importCloudDoc(manager, cloud, more), parseDoc(text), isMidlDocument(doc), errorText(err) }
async function showDashboard (manager, deps, args) {
  args = args && typeof args === 'object' ? args : {}
  const sourceId = text(args.sourceId)
  if (!sourceId) throw fail('bad_request', 'sourceId is required')
  const wanted = args.displayIds === 'all' || (Array.isArray(args.displayIds) && args.displayIds.includes('all'))
    ? Object.keys(manager.store.registry.devices)
    : [...new Set((Array.isArray(args.displayIds) ? args.displayIds : (args.displayIds ? [args.displayIds] : [])).map(text).filter(Boolean))]
  if (!wanted.length) throw fail('bad_request', 'displayIds is required (one or more display ids, or "all")')

  let doc = args.doc
  if (typeof doc === 'string') {
    try { doc = deps.parseDoc(doc) } catch (err) { throw fail('invalid_dashboard', deps.errorText(err)) }
  }
  if (!deps.isMidlDocument(doc)) throw fail('invalid_dashboard', 'the dashboard is not a MIDL document (midl, screens)')
  const screens = midlRecords.screensOf(doc)
  if (!screens.length) throw fail('invalid_dashboard', 'the dashboard has no screens')
  const screen = args.screen ? text(args.screen) : screens[0].id
  if (!screens.some((s) => s.id === screen)) throw fail('invalid_dashboard', `the dashboard has no screen "${screen}"`)
  const requestedBy = text(args.requestedBy) || 'yey.boats'
  const title = text(args.title) || midlRecords.recordTitle(doc, '') || sourceId

  // Each target display's class gate, before anything is stored.
  const results = new Map()
  const accepted = []
  for (const id of wanted) {
    if (!manager.store.registry.devices[id]) {
      results.set(id, { display_id: id, state: 'unknown_display' })
      continue
    }
    const check = manager.checkMidlDocForDevice(id, doc)
    if (!check.unavailable && !check.ok) results.set(id, { display_id: id, state: 'refused', error: issuesText(check) })
    else accepted.push(id)
  }

  // The preset: created or updated exactly as "From yey.boats -> Import"
  // does for this sourceId (validated for the first display that takes it).
  const first = accepted[0] ? manager.getDevice(accepted[0]) : null
  let preset
  try {
    preset = deps.importCloudDoc(manager, {
      id: sourceId,
      title,
      targetClass: first ? manager.deviceMidlClass(first) : '',
      updatedAt: text(args.updatedAt),
      doc
    }, {
      deviceId: first ? first.id : undefined,
      extra: { shownBy: requestedBy, shownAt: new Date().toISOString() }
    })
  } catch (err) {
    const status = err && err.status
    if (status === 400 || status === 409 || status === 422) {
      const message = deps.errorText(err)
      manager.store.audit('cloud.dashboard.refused', sourceId, { sourceId, displays: wanted, requestedBy, error: message })
      throw fail('invalid_dashboard', message)
    }
    throw err
  }

  // Assign + show: the #84 delivery with the requested screen.
  const deliveries = []
  for (const id of accepted) {
    try {
      const { delivery } = manager.assignProfileDelivered(id, { profileId: preset.id, screen })
      deliveries.push(settleWithin(delivery, DELIVERY_WAIT_MS).then((outcome) => results.set(id, resultOf(id, screen, outcome))))
    } catch (err) {
      results.set(id, { display_id: id, state: 'refused', error: deps.errorText(err) })
    }
  }
  await Promise.all(deliveries)

  const out = {
    preset: { id: preset.id, name: preset.name || preset.id, created: !preset.updated },
    results: wanted.map((id) => results.get(id))
  }
  manager.store.audit('cloud.dashboard.shown', preset.id, {
    sourceId,
    presetId: preset.id,
    displays: out.results.map((r) => ({ id: r.display_id, state: r.state })),
    requestedBy
  })
  if (manager.app && manager.app.debug) {
    manager.app.debug(`yey-boats-display-manager: yey.boats dashboard ${sourceId} -> preset ${preset.id} for ${requestedBy}: ` +
      out.results.map((r) => `${r.display_id} ${r.state}`).join(', '))
  }
  return out
}

// The API object for the current plugin instance; `getManager()` is read at
// every call, so a stopped plugin answers `unavailable` instead of using a
// closed manager.
function createApi (getManager, deps) {
  const managerOrFail = () => {
    const m = getManager()
    if (!m) throw fail('unavailable', 'Display Manager is not running')
    return m
  }
  return Object.freeze({
    version: VERSION,
    listDisplays: async () => listDisplays(managerOrFail()),
    showDashboard: async (args) => showDashboard(managerOrFail(), deps, args)
  })
}

function register (api) {
  globalThis[API_KEY] = api
  return api
}

// Removes the API only when it is still ours (a newer start may have
// replaced it).
function unregister (api) {
  if (globalThis[API_KEY] === api) delete globalThis[API_KEY]
}

module.exports = { API_KEY, VERSION, createApi, register, unregister, listDisplays }
