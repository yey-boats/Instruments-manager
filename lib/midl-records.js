'use strict'
// MIDL records: what a Display Manager profile holds for the screens and what
// it delivers to a display (docs: MIDL-only screens contract, 2026-11-15).
//
// A profile keeps the non-screen settings in `profile.config` and its screens
// in `profile.midl = { records: [{ id, title, doc, source, sourceId?,
// sourceUpdatedAt? }], index: { order, defaultScreen, hidden } }`.
//
// - A record is one MIDL document (it may hold several screens). Its id is
//   `[a-z0-9_-]{1,32}`; its hash is `sha256:<hex>` of JSON.stringify(doc),
//   which is also exactly the `doc` text DM sends, so the hash the device
//   computes over the bytes it stores matches.
// - The built-in screens are embedded records baked into the firmware. DM
//   reads the same documents (midl/library/builtin/*.midl.json) for its
//   preview and screen lists; a profile only lists them in its index, so a
//   display on the default profile needs nothing pushed. A profile record with
//   the id of an embedded record overrides it.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const RECORD_ID = /^[a-z0-9_-]{1,32}$/
// Embedded record ids (one per built-in screen; screen id = record id).
const RECT_BUILTINS = ['dashboard', 'wind', 'wind_classic', 'wind_steer', 'nav', 'depth', 'steering',
  'route', 'autopilot', 'trip', 'status']
const ROUND_BUILTINS = ['ap_hud', 'knob_compass', 'knob_wind', 'knob_big']
const ALL_BUILTINS = RECT_BUILTINS.concat(ROUND_BUILTINS)

// Where the built-in documents come from: the midl submodule (the shared
// source, yey-boats/midl library/builtin), else the copy `prepack` stages in
// an installed package (tools/stage-midl-runtime.js).
const BUILTIN_DIRS = [
  path.join(__dirname, '..', 'midl', 'library', 'builtin'),
  path.join(__dirname, 'midl-runtime', 'builtin')
]

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function docText (doc) {
  return JSON.stringify(doc)
}

function docHash (doc) {
  return `sha256:${crypto.createHash('sha256').update(docText(doc)).digest('hex')}`
}

function screensOf (doc, fallbackId) {
  if (!doc || !Array.isArray(doc.screens)) return fallbackId ? [{ id: fallbackId, title: fallbackId }] : []
  return doc.screens
    .filter((s) => s && typeof s.id === 'string' && s.id)
    .map((s) => ({ id: s.id, title: typeof s.title === 'string' && s.title ? s.title : s.id }))
}

function recordTitle (doc, fallback) {
  if (doc && isObj(doc.meta) && typeof doc.meta.title === 'string' && doc.meta.title.trim()) return doc.meta.title.trim()
  const first = screensOf(doc)[0]
  return (first && first.title) || fallback || ''
}

function isRecordId (id) {
  return typeof id === 'string' && RECORD_ID.test(id)
}

// A record id from a title / screen id / file name.
function toRecordId (value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '')
}

function uniqueRecordId (base, taken) {
  let id = toRecordId(base) || 'screen'
  if (!taken.has(id)) return id
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${id.slice(0, 32 - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

let builtinCache = null
// id -> { id, title, source: 'embedded', doc, hash } for every built-in
// document found.
function loadBuiltins () {
  if (builtinCache) return builtinCache
  const out = new Map()
  for (const id of ALL_BUILTINS) {
    for (const dir of BUILTIN_DIRS) {
      const file = path.join(dir, `${id}.midl.json`)
      if (!fs.existsSync(file)) continue
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
        out.set(id, { id, title: recordTitle(doc, id), source: 'embedded', doc, hash: docHash(doc) })
        break
      } catch (e) { /* unreadable copy: try the next source */ }
    }
  }
  builtinCache = out
  return out
}

function builtinIdsForClass (className) {
  return String(className || '').startsWith('round') ? ROUND_BUILTINS.slice() : RECT_BUILTINS.slice()
}

function isBuiltinId (id) {
  return ALL_BUILTINS.includes(id)
}

function emptyIndex () {
  return { order: [], defaultScreen: '', hidden: [] }
}

function emptyMidl () {
  return { records: [], index: emptyIndex() }
}

function normalizeIndex (index) {
  const i = isObj(index) ? index : {}
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter(isRecordId))] : [])
  return {
    order: ids(i.order),
    defaultScreen: typeof i.defaultScreen === 'string' ? i.defaultScreen : '',
    hidden: ids(i.hidden)
  }
}

function normalizeRecord (r) {
  if (!isObj(r) || !isRecordId(r.id) || !isObj(r.doc)) return null
  const out = {
    id: r.id,
    title: typeof r.title === 'string' && r.title ? r.title : recordTitle(r.doc, r.id),
    doc: r.doc,
    source: typeof r.source === 'string' && r.source ? r.source : 'manager'
  }
  if (r.sourceId != null) out.sourceId = String(r.sourceId)
  if (r.sourceUpdatedAt != null) out.sourceUpdatedAt = r.sourceUpdatedAt
  if (r.updatedAt) out.updatedAt = r.updatedAt
  return out
}

function normalizeMidl (midl) {
  const m = isObj(midl) ? midl : {}
  const seen = new Set()
  const records = []
  for (const r of (Array.isArray(m.records) ? m.records : [])) {
    const n = normalizeRecord(r)
    if (!n || seen.has(n.id)) continue
    seen.add(n.id)
    records.push(n)
  }
  return { records, index: normalizeIndex(m.index) }
}

// Every record a display of `className` has for this profile, in carousel
// order: embedded records for the class, overridden by profile records of the
// same id, plus the profile's own. Order: index.order, then the rest
// embedded-first, then by id. Each entry: { id, title, source, doc, hash,
// screens, hidden, embedded, overridesEmbedded }. `source` is 'embedded' for
// a built-in the profile only references; `doc` is null for a built-in DM has
// no copy of (the device still has it).
function effectiveRecords (midl, className) {
  const m = normalizeMidl(midl)
  const builtins = loadBuiltins()
  const byId = new Map()
  for (const id of builtinIdsForClass(className)) {
    const b = builtins.get(id)
    byId.set(id, {
      id,
      title: b ? b.title : id,
      source: 'embedded',
      doc: b ? b.doc : null,
      hash: b ? b.hash : null,
      embedded: true,
      overridesEmbedded: false
    })
  }
  for (const r of m.records) {
    const base = byId.get(r.id)
    byId.set(r.id, {
      id: r.id,
      title: r.title,
      source: 'manager',
      origin: r.source,
      doc: r.doc,
      hash: docHash(r.doc),
      embedded: false,
      overridesEmbedded: Boolean(base && base.embedded)
    })
  }
  const listed = m.index.order.filter((id) => byId.has(id))
  const rest = [...byId.keys()].filter((id) => !listed.includes(id))
  const builtinOrder = builtinIdsForClass(className)
  rest.sort((a, b) => {
    const ea = builtinOrder.indexOf(a)
    const eb = builtinOrder.indexOf(b)
    if (ea >= 0 && eb >= 0) return ea - eb
    if (ea >= 0) return -1
    if (eb >= 0) return 1
    return a < b ? -1 : (a > b ? 1 : 0)
  })
  const hidden = new Set(m.index.hidden)
  return [...listed, ...rest].map((id) => {
    const r = byId.get(id)
    return Object.assign(r, { screens: screensOf(r.doc, id), hidden: hidden.has(id) })
  })
}

// Screens across the visible records, in carousel order: [{ id, title, record }].
function screenList (midl, className) {
  const out = []
  for (const r of effectiveRecords(midl, className)) {
    if (r.hidden) continue
    for (const s of r.screens) out.push({ id: s.id, title: s.title, record: r.id })
  }
  return out
}

// The index a display of `className` is sent: the full carousel order, the
// hidden records, and a default screen that exists (the stored one, else the
// settings' defaultScreen, else the first screen of the first visible record).
function effectiveIndex (midl, className, settingsDefault) {
  const m = normalizeMidl(midl)
  const records = effectiveRecords(m, className)
  const screens = screenList(m, className)
  const has = (sid) => sid && screens.some((s) => s.id === sid)
  const defaultScreen = has(m.index.defaultScreen) ? m.index.defaultScreen
    : (has(settingsDefault) ? settingsDefault : ((screens[0] && screens[0].id) || ''))
  return {
    order: records.map((r) => r.id),
    defaultScreen,
    hidden: records.filter((r) => r.hidden).map((r) => r.id)
  }
}

function recordUrl (deviceId, recordId) {
  return `/devices/${encodeURIComponent(deviceId)}/midl/records/${encodeURIComponent(recordId)}`
}

// The `midl` block of GET /devices/:id/config (pull). Only the profile's own
// records are listed: embedded records are on the device already.
function configBlock (midl, className, deviceId, settingsDefault) {
  const m = normalizeMidl(midl)
  return {
    index: effectiveIndex(m, className, settingsDefault),
    records: m.records.map((r) => ({ id: r.id, title: r.title, hash: docHash(r.doc), url: recordUrl(deviceId, r.id) }))
  }
}

// The record JSON the device stores and GET .../midl/records/:rid returns.
function recordJson (record) {
  return { id: record.id, title: record.title, source: 'manager', hash: docHash(record.doc), doc: record.doc }
}

// Screen ids must be unique across the records a display holds. Returns
// [{ screen, records: [a, b] }] for each screen id two records both use.
function screenConflicts (midl, className) {
  const owner = new Map()
  const out = []
  for (const r of effectiveRecords(midl, className)) {
    for (const s of r.screens) {
      const prev = owner.get(s.id)
      if (prev && prev !== r.id) out.push({ screen: s.id, records: [prev, r.id] })
      else owner.set(s.id, r.id)
    }
  }
  return out
}

// Put `record` into a profile's midl (replacing a record of the same id).
function upsertRecord (midl, record) {
  const m = normalizeMidl(midl)
  const n = normalizeRecord(record)
  if (!n) throw new Error('invalid MIDL record')
  const i = m.records.findIndex((r) => r.id === n.id)
  // An edit of an imported record keeps which yey.boats dashboard it came
  // from, so a re-import of that dashboard still finds it (#85).
  if (i >= 0 && m.records[i].sourceId !== undefined && n.sourceId === undefined) {
    n.sourceId = m.records[i].sourceId
    if (m.records[i].sourceUpdatedAt !== undefined && n.sourceUpdatedAt === undefined) n.sourceUpdatedAt = m.records[i].sourceUpdatedAt
  }
  if (i >= 0) m.records[i] = n
  else m.records.push(n)
  return m
}

module.exports = {
  RECORD_ID,
  RECT_BUILTINS,
  ROUND_BUILTINS,
  ALL_BUILTINS,
  BUILTIN_DIRS,
  docText,
  docHash,
  screensOf,
  recordTitle,
  isRecordId,
  toRecordId,
  uniqueRecordId,
  loadBuiltins,
  builtinIdsForClass,
  isBuiltinId,
  emptyIndex,
  emptyMidl,
  normalizeIndex,
  normalizeRecord,
  normalizeMidl,
  effectiveRecords,
  screenList,
  effectiveIndex,
  recordUrl,
  configBlock,
  recordJson,
  screenConflicts,
  upsertRecord
}
