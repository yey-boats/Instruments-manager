'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { v2ToMidl, midlToV2 } = require('../lib/midl-adapter')

const v2 = {
  settings: { defaultScreen: 'dashboard' },
  widgets: { items: { sog: { type: 'numeric', path: 'navigation.speedOverGround', unit: 'kn' } } },
  layout: { screens: [{ id: 'dashboard', type: 'grid', tiles: [{ widget: 'sog', area: { col: 0, row: 0 } }] }] },
}

test('v2ToMidl maps a numeric widget to a single-value element with a signalk binding', () => {
  const m = v2ToMidl(v2)
  assert.strictEqual(m.midl.match(/^\d+\.\d+\.\d+$/) != null, true)
  const screen = m.screens[0]
  assert.strictEqual(screen.id, 'dashboard')
  const el = screen.elements.sog
  assert.strictEqual(el.type, 'single-value')
  assert.deepStrictEqual(el.bindings.value, { kind: 'signalk', path: 'navigation.speedOverGround' })
  assert.strictEqual(el.format.unit, 'kn')
})

test('a 1x1 grid maps to a single-cell grid node referencing the element', () => {
  const m = v2ToMidl(v2)
  const layout = m.screens[0].layout
  assert.strictEqual(layout.rows, 1)
  assert.strictEqual(layout.cols, 1)
  assert.deepStrictEqual(layout.cells, [{ element: 'sog' }])
})

test('midlToV2 round-trips the element type and path', () => {
  const back = midlToV2(v2ToMidl(v2))
  assert.strictEqual(back.widgets.items.sog.type, 'numeric')
  assert.strictEqual(back.widgets.items.sog.path, 'navigation.speedOverGround')
})

test('a translated v2 dashboard validates against the square-480 manifest', () => {
  const { validateMidl } = require('../lib/midl')
  const doc = JSON.stringify(v2ToMidl(v2))
  const r = validateMidl(doc, 'square-480')
  assert.strictEqual(r.ok, true, JSON.stringify(r.issues))
})
