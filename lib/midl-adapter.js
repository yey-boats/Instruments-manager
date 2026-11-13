'use strict'

const { sanitizeMarkers, DEFAULT_MANIFEST } = require('./field-schema')

const MIDL_VERSION = '1.0.0'

const V2_TO_MIDL = {
  numeric: 'single-value', text: 'text', gauge: 'gauge', bar: 'bar',
  compass: 'compass', windRose: 'windrose', windCircle: 'windrose',
  trend: 'trend', control: 'autopilot', button: 'button',
}
const MIDL_TO_V2 = {
  'single-value': 'numeric', text: 'text', gauge: 'gauge', bar: 'bar',
  compass: 'compass', windrose: 'windCircle', trend: 'trend',
  autopilot: 'control', button: 'button',
}

// MIDL element types that render without a data binding (midl semantic.ts
// ELEMENT_REQUIRED_BINDINGS). Every other type needs a `value` binding; the
// device rejects an element without one (instruments#37, 422).
const UNBOUND_TYPES = new Set(['button'])

// Element ids that are safe as plain object keys.
const SAFE_ID = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_.:-]{1,128}$/
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0

// A v2 widget's value / dir SignalK paths: the typed-tuple `paths` map (field
// editor) wins over the legacy flat `path`.
function widgetPaths (w) {
  const paths = w.paths && typeof w.paths === 'object' ? w.paths : {}
  const value = nonEmpty(paths.value) ? paths.value.trim() : (nonEmpty(w.path) ? w.path.trim() : null)
  const dir = nonEmpty(paths.dir) ? paths.dir.trim() : null
  return { value, dir }
}

// One v2 widget -> a MIDL element, or null when it cannot render (a type that
// needs a binding but has no path): the device would refuse the whole
// document for it, so it is dropped rather than emitted half-formed.
function widgetToElement (w) {
  const type = V2_TO_MIDL[w.type] || 'single-value'
  const { value, dir } = widgetPaths(w)
  if (!value && !UNBOUND_TYPES.has(type)) return null
  const el = { type }
  if (nonEmpty(w.title)) el.name = w.title
  if (value) {
    el.bindings = { value: { kind: 'signalk', path: value } }
    if (dir) el.bindings.dir = { kind: 'signalk', path: dir }
  }
  if (nonEmpty(w.unit)) el.format = { unit: w.unit }
  // #38: the field attributes MIDL can hold travel with the element so the
  // editor shows them and a save can carry them back.
  const style = styleFor(w, type)
  if (style) el.style = style
  const markers = markersFor(w, type)
  if (markers) el.markers = markers
  return el
}

const HEX6 = /^#[0-9a-fA-F]{6}$/
// #rrggbb, or #rgb expanded; anything else (theme tokens, #rrggbbaa) is not
// a v2 field colour.
function hex6 (c) {
  if (typeof c !== 'string') return null
  if (HEX6.test(c)) return c
  const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(c)
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null
}
// The v2 field model's font sizes (field-schema; a device may narrow them).
const FONT_SIZES = DEFAULT_MANIFEST.fontSizes
const RANGED = new Set(['gauge', 'bar'])
const DIALS = new Set(['compass', 'windrose'])
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

// v2 range {min,max} / size / color.value -> MIDL element style.
function styleFor (w, type) {
  const style = {}
  const r = w.range
  if (RANGED.has(type) && r && isNum(r.min) && isNum(r.max) && r.min < r.max) style.range = [r.min, r.max]
  if (isNum(w.size) || nonEmpty(w.size)) style.size = w.size
  const c = w.color && typeof w.color === 'object' ? w.color.value : null
  if (typeof c === 'string' && HEX6.test(c)) style.color = c
  return Object.keys(style).length ? style : null
}

// v2 dial markers [{path, glyph, color?, kind?, filled?, id?}] -> MIDL markers
// with a signalk `dir` binding. Only markers that pass the manager's marker
// checks are emitted (a stored config may predate them, #32).
function markersFor (w, type) {
  if (!DIALS.has(type) || !Array.isArray(w.markers) || !w.markers.length) return null
  const out = sanitizeMarkers(w.markers).map((m) => {
    const o = { glyph: m.glyph }
    if (m.color != null) o.color = m.color
    if (m.kind != null) o.kind = m.kind
    o.dir = { kind: 'signalk', path: m.path }
    return o
  })
  return out.length ? out : null
}

// Largest grid coordinate honoured from a stored `area`; anything beyond it
// flows like an unplaced tile (an absurd area must not size the grid).
const MAX_AREA = 12
const isCell = (a) => a && Number.isInteger(a.col) && Number.isInteger(a.row) &&
  a.col >= 0 && a.row >= 0 && a.col < MAX_AREA && a.row < MAX_AREA

// Grid columns for N auto-placed tiles (matches the device preview glue).
const autoCols = (n) => (n <= 1 ? 1 : (n <= 4 ? 2 : 3))

// Translate a v2 dashboard object into a MIDL config document.
//
// Every emitted document is structurally valid for midl's validator (and so
// the device's): each element is placed in exactly one cell, unused grid cells are
// the schema's spacer cell `{}` (never `{ element: '' }`), and an element that
// needs a binding but has none is dropped. Tiles keep their `area` when it is
// a free, valid cell; tiles without one (editor-authored), or whose cell is
// taken, flow into the next free cell in row-major order. Capacity is not
// enforced here: a screen with more tiles than the class's maxTiles still
// fails validation, which callers report (midlDocumentFor / requireValidMidl).
function v2ToMidl (v2) {
  const items = (v2 && v2.widgets && v2.widgets.items) || {}
  const usedIds = new Set()
  const screens = ((v2 && v2.layout && v2.layout.screens) || []).map((s, si) => {
    const base = nonEmpty(s && s.id) ? String(s.id) : `screen-${si + 1}`
    let id = base
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`
    usedIds.add(id)

    // Placeable tiles: a known widget that maps to a renderable element, each
    // widget once (an element can only occupy one cell).
    const elements = {}
    const placed = []
    for (const t of (s && Array.isArray(s.tiles) ? s.tiles : [])) {
      if (!t || typeof t.widget !== 'string' || !t.widget || has(elements, t.widget)) continue
      if (!has(items, t.widget) || !items[t.widget] || typeof items[t.widget] !== 'object') continue
      const el = widgetToElement(items[t.widget])
      if (!el) continue
      elements[t.widget] = el
      placed.push({ widget: t.widget, area: isCell(t.area) ? t.area : null })
    }

    const anchored = placed.filter((p) => p.area)
    let cols = anchored.length ? Math.max(...anchored.map((p) => p.area.col)) + 1 : autoCols(placed.length)
    let rows = anchored.length ? Math.max(...anchored.map((p) => p.area.row)) + 1 : 1
    // A screen saved from MIDL remembers its grid size (midlToV2), so a
    // half-filled grid keeps its shape instead of shrinking to the tiles.
    const g = s && s.grid
    if (g && Number.isInteger(g.cols) && Number.isInteger(g.rows) && g.cols >= cols && g.rows >= rows &&
        g.cols <= MAX_AREA && g.rows <= MAX_AREA) {
      cols = g.cols
      rows = g.rows
    }
    rows = Math.max(rows, 1)
    cols = Math.max(cols, 1)
    const grid = new Map() // "row,col" -> widget
    const queue = []
    for (const p of placed) {
      const key = p.area ? `${p.area.row},${p.area.col}` : null
      if (key && !grid.has(key)) grid.set(key, p.widget)
      else queue.push(p.widget)
    }
    // Flow the rest into free cells, growing the grid by rows when full.
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

// One MIDL element -> a fresh v2 widget item (what the element itself says).
function elementToItem (el) {
  const b = el.bindings || {}
  const item = {
    type: MIDL_TO_V2[el.type] || 'numeric',
    path: b.value ? b.value.path : undefined,
    unit: el.format ? el.format.unit : undefined,
    title: el.name
  }
  if (item.path) item.paths = { value: item.path }
  if (item.path && b.dir && b.dir.path) item.paths.dir = b.dir.path
  const st = el.style && typeof el.style === 'object' ? el.style : {}
  // Only what the v2 field model can hold is taken (#38 review); anything
  // else is reported by roundTripLoss (lib/midl.js) as a 422, not dropped.
  if (Array.isArray(st.range) && st.range.length === 2 && isNum(st.range[0]) && isNum(st.range[1]) &&
      st.range[0] < st.range[1]) {
    item.range = { min: st.range[0], max: st.range[1] }
  }
  if (isNum(st.size) && FONT_SIZES.includes(st.size)) item.size = st.size
  const hex = hex6(st.color)
  if (hex) item.color = { value: hex }
  if (Array.isArray(el.markers)) {
    const markers = sanitizeMarkers(el.markers
      .filter((m) => m && m.dir && m.dir.kind === 'signalk' && nonEmpty(m.dir.path))
      .map((m) => {
        const o = { path: m.dir.path, glyph: m.glyph }
        if (m.color != null) o.color = m.color
        if (m.kind != null) o.kind = m.kind
        return o
      }))
    if (markers.length) item.markers = markers
  }
  for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k]
  return item
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
const getStyle = (e, k) => (e && e.style ? e.style[k] : undefined)

// #38: merge a saved element into the widget item stored under the same id.
// The doc is authoritative for what MIDL expresses; where an attribute comes
// back exactly as GET served it, the stored form wins (it can hold more:
// marker filled/id, the other colour elements). Attributes MIDL cannot carry
// (zones, reference, zoom, precision, format, ...) are kept from the stored
// item, as far as the (possibly new) type allows them.
function mergeItem (el, prev) {
  const fresh = elementToItem(el)
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return fresh
  const served = widgetToElement(prev)
  if (served && same(served, el)) return clone(prev) // untouched in the editor
  const out = clone(prev)
  // Type: keep a stored alias (windRose, windCircle) while the MIDL type is unchanged.
  out.type = served && served.type === el.type ? prev.type : fresh.type
  // Bindings, title, unit: always from the doc.
  for (const k of ['path', 'paths', 'title', 'unit']) {
    if (fresh[k] === undefined) delete out[k]
    else out[k] = fresh[k]
  }
  if (served && same(served.bindings, el.bindings) && prev.paths && typeof prev.paths === 'object') {
    out.paths = clone(prev.paths) // same bindings: keep any extra named paths
  }
  const take = (key, unchanged) => {
    if (unchanged) return
    if (fresh[key] === undefined) delete out[key]
    else out[key] = fresh[key]
  }
  take('range', same(getStyle(served, 'range'), getStyle(el, 'range')))
  take('size', same(getStyle(served, 'size'), getStyle(el, 'size')))
  if (!same(served && served.markers, el.markers)) {
    // Carry per-marker details MIDL has no slot for (filled, id) onto the
    // markers that are still there (same path and glyph).
    const prevMarkers = Array.isArray(prev.markers) ? prev.markers : []
    if (fresh.markers) {
      out.markers = fresh.markers.map((m) => {
        const p = prevMarkers.find((q) => q && q.path === m.path && q.glyph === m.glyph)
        const o = Object.assign({}, m)
        if (p && p.filled != null) o.filled = p.filled
        if (p && p.id != null) o.id = p.id
        return o
      })
    } else delete out.markers
  }
  if (!same(getStyle(served, 'color'), getStyle(el, 'color'))) {
    const color = Object.assign({}, prev.color && typeof prev.color === 'object' ? prev.color : {})
    if (fresh.color) color.value = fresh.color.value
    else delete color.value
    if (Object.keys(color).length) out.color = color
    else delete out.color
  }
  // Type-specific attributes the new type cannot hold are dropped.
  if (!RANGED.has(V2_TO_MIDL[out.type])) { delete out.range; delete out.zones }
  if (!DIALS.has(V2_TO_MIDL[out.type])) { delete out.markers; delete out.reference }
  if (out.type !== prev.type) {
    const spec = DEFAULT_MANIFEST.viewTypes[out.type]
    const attrs = (spec && spec.attrs) || []
    const zooms = (spec && spec.zoom) || []
    if (!attrs.includes('format')) delete out.format
    if (out.zoom != null && !(out.zoom === 'auto' ? zooms.includes('auto') : zooms.includes('screenRef'))) delete out.zoom
    if (!zooms.length) delete out.zoomable
  }
  return out
}

// Keys of a stored tile that mirror its widget item (field editor, #38); they
// are refreshed from the merged item rather than copied stale.
const TILE_MIRRORS = { title: (it) => it.title, path: (it) => it.paths && it.paths.value, unit: (it) => it.unit }

// Translate a MIDL config document back into a v2 dashboard object. With
// `stored` (the current v2 dashboard: { widgets: { items }, layout: { screens } })
// the result keeps what the MIDL document cannot express (#38): each element
// is merged into the stored widget item of the same id, each screen keeps
// its other properties, and each tile its other keys.
function midlToV2 (doc, stored) {
  const prevItems = (stored && stored.widgets && stored.widgets.items) || {}
  const prevScreens = new Map()
  for (const s of ((stored && stored.layout && stored.layout.screens) || [])) {
    if (s && typeof s === 'object' && typeof s.id === 'string' && !prevScreens.has(s.id)) prevScreens.set(s.id, s)
  }
  const widgets = { items: {} }
  const screens = (Array.isArray(doc.screens) ? doc.screens : []).filter((s) => s && typeof s === 'object').map((s) => {
    const prev = typeof s.id === 'string' ? prevScreens.get(s.id) : null
    const prevTiles = new Map()
    for (const t of ((prev && Array.isArray(prev.tiles)) ? prev.tiles : [])) {
      if (t && typeof t.widget === 'string' && !prevTiles.has(t.widget)) prevTiles.set(t.widget, t)
    }
    const tiles = []
    const cols = (s.layout && s.layout.cols) || 1
    const cells = (s.layout && Array.isArray(s.layout.cells)) ? s.layout.cells : []
    const elements = s.elements && typeof s.elements === 'object' ? s.elements : {}
    cells.forEach((cell, i) => {
      if (!cell || !cell.element || !SAFE_ID.test(cell.element) || !has(elements, cell.element)) return
      const el = elements[cell.element]
      if (!el) return
      const item = mergeItem(el, has(prevItems, cell.element) ? prevItems[cell.element] : null)
      widgets.items[cell.element] = item
      const tile = Object.assign({}, prevTiles.get(cell.element) || {}, {
        widget: cell.element, area: { col: i % cols, row: Math.floor(i / cols) }
      })
      for (const [k, get] of Object.entries(TILE_MIRRORS)) {
        if (!has(tile, k)) continue
        const v = get(item)
        if (v === undefined || v === '') delete tile[k]
        else tile[k] = v
      }
      tiles.push(tile)
    })
    const out = Object.assign({}, prev || {}, { id: s.id, type: 'grid', tiles })
    delete out.grid
    if (nonEmpty(s.title)) out.title = s.title
    else delete out.title
    if (s.layout && Number.isInteger(s.layout.rows) && Number.isInteger(s.layout.cols)) {
      out.grid = { rows: s.layout.rows, cols: s.layout.cols }
    }
    return out
  })
  return { widgets, layout: { screens } }
}

const clone = (v) => JSON.parse(JSON.stringify(v))

module.exports = { v2ToMidl, midlToV2, V2_TO_MIDL, MIDL_TO_V2 }
