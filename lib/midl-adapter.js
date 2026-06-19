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

// Translate a v2 dashboard object into a MIDL config document.
function v2ToMidl(v2) {
  const items = (v2.widgets && v2.widgets.items) || {}
  const screens = ((v2.layout && v2.layout.screens) || []).map((s) => {
    const elements = {}
    let maxCol = 0
    let maxRow = 0
    const tiles = s.tiles || []
    for (const t of tiles) {
      const w = items[t.widget]
      if (!w) continue
      const el = { type: V2_TO_MIDL[w.type] || 'single-value' }
      if (w.title) el.name = w.title
      if (w.path) el.bindings = { value: { kind: 'signalk', path: w.path } }
      if (w.unit) el.format = { unit: w.unit }
      elements[t.widget] = el
      maxCol = Math.max(maxCol, (t.area && t.area.col) || 0)
      maxRow = Math.max(maxRow, (t.area && t.area.row) || 0)
    }
    const cols = maxCol + 1
    const rows = maxRow + 1
    const cells = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tile = tiles.find((t) => t.area && t.area.col === c && t.area.row === r)
        cells.push(tile ? { element: tile.widget } : { element: '' })
      }
    }
    return { id: s.id, elements, layout: { rows, cols, cells } }
  })
  return { midl: MIDL_VERSION, screens }
}

// Translate a MIDL config document back into a v2 dashboard object.
function midlToV2(doc) {
  const widgets = { items: {} }
  const screens = (doc.screens || []).map((s) => {
    const tiles = []
    const cols = (s.layout && s.layout.cols) || 1
    const cells = (s.layout && s.layout.cells) || []
    cells.forEach((cell, i) => {
      if (!cell || !cell.element) return
      const el = s.elements[cell.element]
      if (!el) return
      widgets.items[cell.element] = {
        type: MIDL_TO_V2[el.type] || 'numeric',
        path: el.bindings && el.bindings.value ? el.bindings.value.path : undefined,
        unit: el.format ? el.format.unit : undefined,
        title: el.name,
      }
      tiles.push({ widget: cell.element, area: { col: i % cols, row: Math.floor(i / cols) } })
    })
    return { id: s.id, type: 'grid', tiles }
  })
  return { widgets, layout: { screens } }
}

module.exports = { v2ToMidl, midlToV2, V2_TO_MIDL, MIDL_TO_V2 }
