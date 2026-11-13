'use strict'

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
  return el
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
    return { id, elements, layout: { rows, cols, cells } }
  })
  return { midl: MIDL_VERSION, screens }
}

// Translate a MIDL config document back into a v2 dashboard object.
function midlToV2 (doc) {
  const widgets = { items: {} }
  const screens = (Array.isArray(doc.screens) ? doc.screens : []).filter((s) => s && typeof s === 'object').map((s) => {
    const tiles = []
    const cols = (s.layout && s.layout.cols) || 1
    const cells = (s.layout && Array.isArray(s.layout.cells)) ? s.layout.cells : []
    const elements = s.elements && typeof s.elements === 'object' ? s.elements : {}
    cells.forEach((cell, i) => {
      if (!cell || !cell.element || !SAFE_ID.test(cell.element) || !has(elements, cell.element)) return
      const el = elements[cell.element]
      if (!el) return
      const b = el.bindings || {}
      const item = {
        type: MIDL_TO_V2[el.type] || 'numeric',
        path: b.value ? b.value.path : undefined,
        unit: el.format ? el.format.unit : undefined,
        title: el.name,
      }
      if (item.path) item.paths = { value: item.path }
      if (item.path && b.dir && b.dir.path) item.paths.dir = b.dir.path
      widgets.items[cell.element] = item
      tiles.push({ widget: cell.element, area: { col: i % cols, row: Math.floor(i / cols) } })
    })
    const out = { id: s.id, type: 'grid', tiles }
    if (s.layout && Number.isInteger(s.layout.rows) && Number.isInteger(s.layout.cols)) {
      out.grid = { rows: s.layout.rows, cols: s.layout.cols }
    }
    return out
  })
  return { widgets, layout: { screens } }
}

module.exports = { v2ToMidl, midlToV2, V2_TO_MIDL, MIDL_TO_V2 }
