'use strict'
// One-time migration of stored v2 dashboards to MIDL records (MIDL-only
// screens contract, 2026-11-15). Display Manager no longer reads, edits or
// delivers v2 screens; this module only converts a profile that still holds
// `config.layout` / `config.widgets` (an old profiles.json, an old export, an
// old client) into MIDL records, once. It is the v2 -> MIDL direction of the
// former lib/midl-adapter.js, cut down to what that conversion needs.
//
// The v2 model: `layout.screens[*].tiles[*].widget` names a key of
// `widgets.items` (a field: type, path/paths, title, unit, range, size,
// color, markers), or is a widget TYPE with the bindings on the tile itself
// (the shape the old screen presets wrote: primary/secondary, or the
// fullscreen HUD keys aws/awa/tws/twa/heading).
const crypto = require('crypto')
const midlRecords = require('./midl-records')

const MIDL_VERSION = '1.0.0'

// v2 field / tile type -> MIDL element type.
const ELEMENT_TYPE = {
  numeric: 'single-value',
  text: 'text',
  gauge: 'gauge',
  bar: 'bar',
  compass: 'compass',
  windRose: 'windrose',
  windCircle: 'windrose',
  trend: 'trend',
  control: 'autopilot',
  button: 'button',
  // Fullscreen HUD tiles of the old presets.
  windDial: 'windrose',
  windClassic: 'windrose',
  windSteer: 'windrose',
  autopilotHud: 'compass'
}
const HUD_WIND = new Set(['windDial', 'windClassic', 'windSteer'])
// MIDL element types that render without a data binding; every other type
// needs a `value` binding or the device refuses the document.
const UNBOUND_TYPES = new Set(['button'])
const RANGED = new Set(['gauge', 'bar'])
const DIALS = new Set(['compass', 'windrose'])

// Element ids that are safe as plain object keys.
const SAFE_ID = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_.:-]{1,128}$/
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const HEX6 = /^#[0-9a-fA-F]{6}$/

// Dial markers (#32): only markers whose colour, glyph and path pass are
// carried, at most 12 per dial, so a stored hostile value never reaches a
// MIDL document. Colours follow the MIDL $defs/color allowlist.
const MARKER_GLYPHS = ['triangle', 'diamond', 'circle', 'bar', 'cross', 'chevron_in', 'chevron_out',
  'chevron_left', 'chevron_right', 'chevron_double']
const MAX_MARKERS = 12
const MARKER_COLOR_TOKENS = ['panel', 'panel2', 'edge', 'fg', 'dim', 'accent', 'accent2', 'good', 'warn',
  'bad', 'alarm', 'danger', 'port', 'starboard', 'tide', 'stale', 'bg']
const MARKER_COLOR_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const MARKER_PATH = /^(?=.{1,200}$)[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
const MARKER_KINDS = ['rim', 'vector']
const MARKER_ID = /^[A-Za-z0-9_.-]{1,64}$/

function isMarkerColor (v) {
  return typeof v === 'string' && (MARKER_COLOR_HEX.test(v) || MARKER_COLOR_TOKENS.includes(v))
}

function markersFor (src, type) {
  if (!DIALS.has(type) || !Array.isArray(src.markers)) return null
  const out = src.markers
    .filter((m) => isObj(m) && typeof m.path === 'string' && MARKER_PATH.test(m.path) &&
      MARKER_GLYPHS.includes(m.glyph) && (m.color == null || isMarkerColor(m.color)) &&
      (m.kind == null || MARKER_KINDS.includes(m.kind)) && (m.filled == null || typeof m.filled === 'boolean') &&
      (m.id == null || (typeof m.id === 'string' && MARKER_ID.test(m.id))))
    .slice(0, MAX_MARKERS)
    .map((m) => {
      const o = { glyph: m.glyph }
      if (m.color != null) o.color = m.color
      if (m.kind != null) o.kind = m.kind
      o.dir = { kind: 'signalk', path: m.path }
      return o
    })
  return out.length ? out : null
}

// v2 range {min,max} / size / color.value -> MIDL element style.
function styleFor (src, type) {
  const style = {}
  const r = src.range
  if (RANGED.has(type) && r && isNum(r.min) && isNum(r.max) && r.min < r.max) style.range = [r.min, r.max]
  if (isNum(src.size) && src.size > 0) style.size = src.size
  const c = isObj(src.color) ? src.color.value : null
  if (typeof c === 'string' && HEX6.test(c)) style.color = c
  return Object.keys(style).length ? style : null
}

// A MIDL element of `type` with value / dir bindings and the attributes of
// `src` MIDL can hold, or null when it cannot render (a type that needs a
// binding but has none: the device would refuse the whole document).
function element (type, value, dir, src) {
  if (!value && !UNBOUND_TYPES.has(type)) return null
  const el = { type }
  if (nonEmpty(src.title)) el.name = src.title
  if (value) {
    el.bindings = { value: { kind: 'signalk', path: value } }
    if (dir) el.bindings.dir = { kind: 'signalk', path: dir }
  }
  if (nonEmpty(src.unit)) el.format = { unit: src.unit }
  const style = styleFor(src, type)
  if (style) el.style = style
  const markers = markersFor(src, type)
  if (markers) el.markers = markers
  return el
}

// A `widgets.items` field -> element. The typed `paths` map wins over the
// legacy flat `path`.
function itemToElement (w) {
  const type = ELEMENT_TYPE[w.type] || 'single-value'
  const paths = isObj(w.paths) ? w.paths : {}
  const value = nonEmpty(paths.value) ? paths.value.trim() : (nonEmpty(w.path) ? w.path.trim() : null)
  const dir = nonEmpty(paths.dir) ? paths.dir.trim() : null
  return element(type, value, dir, w)
}

// A preset-shaped tile (`widget` is a type, bindings on the tile) -> element.
// windrose: `value` is the wind SPEED and `dir` the angle; presets bind the
// angle as primary, so a rose with a secondary swaps them.
function inlineTileToElement (t) {
  const type = has(ELEMENT_TYPE, t.widget) ? ELEMENT_TYPE[t.widget] : null
  if (!type) return null
  const p = (k) => (nonEmpty(t[k]) ? t[k].trim() : null)
  let value = null
  let dir = null
  if (HUD_WIND.has(t.widget)) {
    // Speed and angle from the same pair (apparent, else true).
    if (p('aws') && p('awa')) { value = p('aws'); dir = p('awa') } else if (p('tws') && p('twa')) { value = p('tws'); dir = p('twa') } else { value = p('aws') || p('tws'); dir = p('awa') || p('twa') }
    return element(type, value, dir, { title: t.title, markers: t.markers })
  }
  if (t.widget === 'autopilotHud') return element(type, p('heading'), null, { title: t.title, markers: t.markers })
  const primary = p('primary') || p('path')
  const secondary = p('secondary')
  if (type === 'windrose') {
    value = secondary || primary
    dir = secondary ? primary : null
  } else {
    value = primary
    dir = type === 'compass' ? secondary : null
  }
  return element(type, value, dir, t)
}

// A short (firmware ids are <= 31 chars), safe, unused element id for the
// `ti`th inline tile of screen `screenId`.
function inlineElementId (screenId, ti, taken) {
  const base = String(screenId).replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 24) || 'screen'
  let id = `${base}-t${ti + 1}`
  for (let n = 2; taken.has(id) || !SAFE_ID.test(id); n++) id = `${base}-t${ti + 1}-${n}`
  taken.add(id)
  return id
}

// Largest grid coordinate honoured from a stored `area`.
const MAX_AREA = 12
const isCell = (a) => a && Number.isInteger(a.col) && Number.isInteger(a.row) &&
  a.col >= 0 && a.row >= 0 && a.col < MAX_AREA && a.row < MAX_AREA
// Grid columns for N auto-placed tiles.
const autoCols = (n) => (n <= 1 ? 1 : (n <= 4 ? 2 : 3))

// A v2 dashboard ({ layout: { screens }, widgets: { items } }) -> a MIDL
// document with one grid screen per v2 screen. Each element is placed in
// exactly one cell and unused cells are spacers `{}`. Tiles keep their `area`
// when it is a free, valid cell; the rest flow into the next free cell in
// row-major order.
function v2ToMidl (v2) {
  const items = (v2 && v2.widgets && isObj(v2.widgets.items)) ? v2.widgets.items : {}
  const usedIds = new Set()
  const takenElementIds = new Set(Object.keys(items))
  const screens = ((v2 && v2.layout && Array.isArray(v2.layout.screens)) ? v2.layout.screens : []).map((s, si) => {
    const base = nonEmpty(s && s.id) ? String(s.id) : `screen-${si + 1}`
    let id = base
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`
    usedIds.add(id)

    const elements = {}
    const placed = []
    ;(s && Array.isArray(s.tiles) ? s.tiles : []).forEach((t, ti) => {
      if (!t || typeof t.widget !== 'string' || !t.widget) return
      if (!has(items, t.widget)) {
        const el = inlineTileToElement(t)
        if (!el) return
        const eid = inlineElementId(id, ti, takenElementIds)
        elements[eid] = el
        placed.push({ widget: eid, area: isCell(t.area) ? t.area : null })
        return
      }
      if (has(elements, t.widget) || !isObj(items[t.widget])) return
      const el = itemToElement(items[t.widget])
      if (!el) return
      elements[t.widget] = el
      placed.push({ widget: t.widget, area: isCell(t.area) ? t.area : null })
    })

    const anchored = placed.filter((p) => p.area)
    let cols = anchored.length ? Math.max(...anchored.map((p) => p.area.col)) + 1 : autoCols(placed.length)
    let rows = anchored.length ? Math.max(...anchored.map((p) => p.area.row)) + 1 : 1
    // A screen that remembers its grid size keeps its shape.
    const g = s && s.grid
    if (g && Number.isInteger(g.cols) && Number.isInteger(g.rows) && g.cols >= cols && g.rows >= rows &&
        g.cols <= MAX_AREA && g.rows <= MAX_AREA) {
      cols = g.cols
      rows = g.rows
    }
    rows = Math.max(rows, 1)
    cols = Math.max(cols, 1)
    const grid = new Map() // "row,col" -> element id
    const queue = []
    for (const p of placed) {
      const key = p.area ? `${p.area.row},${p.area.col}` : null
      if (key && !grid.has(key)) grid.set(key, p.widget)
      else queue.push(p.widget)
    }
    for (let r = 0, c = 0; queue.length;) {
      if (r >= rows) rows++
      const key = `${r},${c}`
      if (!grid.has(key)) grid.set(key, queue.shift())
      if (++c >= cols) { c = 0; r++ }
    }
    const cells = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const w = grid.get(`${r},${c}`)
        cells.push(w ? { element: w } : {})
      }
    }
    const out = { id }
    if (s && nonEmpty(s.title)) out.title = s.title
    return Object.assign(out, { elements, layout: { rows, cols, cells } })
  })
  return { midl: MIDL_VERSION, screens }
}

// sha256 (first 16 hex) of JSON.stringify(screen) for every screen the old
// manager's v2 presets (lib/screen-presets.js, removed) seeded into profiles,
// across its display classes. A migrated screen identical to one of them is
// the built-in, not an edit, and is dropped: the embedded records cover it.
const V2_PRESET_SCREEN_HASHES = new Set([
  '711b3c69f2af00bc', 'f2b4c0771625b899', '396efc4e3c373a9f', 'b8fd2e4934cb741f', 'c62e796dc23095a0',
  '9c8004b46499b718', '374c3d5720007408', '0d5921dc937277fc', 'd8e797e5943b1791', '9699f2f0d1428e0e',
  '748df92c852a24e3', '3f8973a8377517c3', '821717b8902228c2', 'bf931a2dba295db5', '927fc767cc07ef59',
  '33d6f9ee2f6d30ec', '29fbbde3c7862e70', '185564b5222bd1a9', '256b31ce17f383cb', 'abb27d1c7bc13ee1',
  'bc4b2dc37a1aafc0', '3381d4507b41d9c2', '81247341daae6923', '92cbbf7b70ac41a9', '8b7dffca87a70d1e'
])
function isV2PresetScreen (screen) {
  const h = crypto.createHash('sha256').update(JSON.stringify(screen)).digest('hex').slice(0, 16)
  return V2_PRESET_SCREEN_HASHES.has(h)
}

function hasV2Screens (config) {
  return isObj(config) && (config.layout !== undefined || config.widgets !== undefined)
}

// A v2 dashboard (`config.layout` + `config.widgets`) -> MIDL records. Each
// v2 screen becomes one record (id from the screen id); seeded preset screens
// are dropped. Returns { records, index, dropped }.
function migrateV2Config (config) {
  const layout = isObj(config && config.layout) ? config.layout : {}
  let screens = Array.isArray(layout.screens) ? layout.screens : []
  if (!screens.length && Array.isArray(layout.variants)) {
    const v = layout.variants.find((x) => isObj(x) && Array.isArray(x.screens) && x.screens.length)
    if (v) screens = v.screens
  }
  const kept = screens.filter((s) => isObj(s) && !isV2PresetScreen(s))
  const result = { records: [], index: midlRecords.emptyIndex(), dropped: screens.length - kept.length }
  if (!kept.length) return result
  const doc = v2ToMidl({ layout: { screens: kept }, widgets: isObj(config.widgets) ? config.widgets : {} })
  const taken = new Set()
  for (const sc of doc.screens) {
    if (!sc.elements || !Object.keys(sc.elements).length) continue
    const id = midlRecords.uniqueRecordId(sc.id, taken)
    taken.add(id)
    result.records.push({ id, title: sc.title || sc.id, doc: { midl: doc.midl, screens: [sc] }, source: 'migrated' })
  }
  result.index.order = result.records.map((r) => r.id)
  const settingsDefault = config.settings && config.settings.defaultScreen
  if (typeof settingsDefault === 'string' && result.records.some((r) => midlRecords.screensOf(r.doc).some((s) => s.id === settingsDefault))) {
    result.index.defaultScreen = settingsDefault
  }
  return result
}

// Strip the v2 screen keys from a config, returning the migrated midl
// (merged over `existing` records) when it had any.
function splitV2Config (config, existing) {
  if (!hasV2Screens(config)) return { config, midl: null }
  const rest = Object.assign({}, config)
  const migrated = migrateV2Config(config)
  delete rest.layout
  delete rest.widgets
  let midl = midlRecords.normalizeMidl(existing)
  for (const r of migrated.records) midl = midlRecords.upsertRecord(midl, r)
  if (migrated.records.length) {
    midl.index.order = [...new Set([...migrated.index.order, ...midl.index.order])]
    if (migrated.index.defaultScreen) midl.index.defaultScreen = migrated.index.defaultScreen
  }
  return { config: rest, midl, migrated }
}

module.exports = { v2ToMidl, isV2PresetScreen, hasV2Screens, migrateV2Config, splitV2Config }
