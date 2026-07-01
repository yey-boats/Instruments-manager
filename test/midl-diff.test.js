'use strict'
const { test } = require('node:test')
const assert = require('node:assert')

// midl-diff.js uses a UMD wrapper; in Node it exports via module.exports
const { diffDashboards } = require('../public/midl-diff')

// --- fixtures ---

function makeDoc (elements) {
  // Build a minimal MIDL doc with screens[0] containing the given elements map.
  // Each value is { type, path, unit, label }.
  const midlElements = {}
  const cells = []
  Object.keys(elements).forEach(function (id) {
    const e = elements[id]
    const midlEl = { type: e.type || 'single-value' }
    if (e.label) midlEl.name = e.label
    if (e.path) midlEl.bindings = { value: { kind: 'signalk', path: e.path } }
    if (e.unit) midlEl.format = { unit: e.unit }
    midlElements[id] = midlEl
    cells.push({ element: id })
  })
  return {
    midl: '1.0.0',
    screens: [{
      id: 'dashboard',
      elements: midlElements,
      layout: { rows: 1, cols: cells.length || 1, cells }
    }]
  }
}

// --- added ---

test('diffDashboards: element in proposed but not in current → added', () => {
  const current = makeDoc({})
  const proposed = makeDoc({ sog: { type: 'single-value', path: 'navigation.speedOverGround', unit: 'kn' } })
  const d = diffDashboards(current, proposed)
  assert.deepStrictEqual(d.added, ['sog'])
  assert.deepStrictEqual(d.removed, [])
  assert.deepStrictEqual(d.changed, [])
})

test('diffDashboards: null current doc → all proposed elements added', () => {
  const proposed = makeDoc({
    sog: { type: 'single-value', path: 'navigation.speedOverGround' },
    hdg: { type: 'compass', path: 'navigation.headingTrue' }
  })
  const d = diffDashboards(null, proposed)
  assert.ok(d.added.includes('sog'), 'sog should be added')
  assert.ok(d.added.includes('hdg'), 'hdg should be added')
  assert.strictEqual(d.removed.length, 0)
  assert.strictEqual(d.changed.length, 0)
})

// --- removed ---

test('diffDashboards: element in current but not in proposed → removed', () => {
  const current = makeDoc({ sog: { type: 'single-value', path: 'navigation.speedOverGround' } })
  const proposed = makeDoc({})
  const d = diffDashboards(current, proposed)
  assert.deepStrictEqual(d.removed, ['sog'])
  assert.deepStrictEqual(d.added, [])
  assert.deepStrictEqual(d.changed, [])
})

// --- changed ---

test('diffDashboards: changed type → one changed entry for field "type"', () => {
  const current = makeDoc({ tile0: { type: 'single-value', path: 'navigation.speedOverGround' } })
  const proposed = makeDoc({ tile0: { type: 'gauge', path: 'navigation.speedOverGround' } })
  const d = diffDashboards(current, proposed)
  assert.deepStrictEqual(d.added, [])
  assert.deepStrictEqual(d.removed, [])
  assert.strictEqual(d.changed.length, 1)
  assert.strictEqual(d.changed[0].id, 'tile0')
  assert.strictEqual(d.changed[0].field, 'type')
  assert.strictEqual(d.changed[0].was, 'single-value')
  assert.strictEqual(d.changed[0].now, 'gauge')
})

test('diffDashboards: changed path → one changed entry for field "path"', () => {
  const current = makeDoc({ w1: { type: 'single-value', path: 'navigation.speedThroughWater', unit: 'kn' } })
  const proposed = makeDoc({ w1: { type: 'single-value', path: 'navigation.speedOverGround', unit: 'kn' } })
  const d = diffDashboards(current, proposed)
  assert.strictEqual(d.changed.length, 1)
  assert.strictEqual(d.changed[0].field, 'path')
  assert.strictEqual(d.changed[0].was, 'navigation.speedThroughWater')
  assert.strictEqual(d.changed[0].now, 'navigation.speedOverGround')
})

test('diffDashboards: changed unit → one changed entry for field "unit"', () => {
  const current = makeDoc({ w1: { type: 'single-value', path: 'environment.wind.angleApparent', unit: 'deg' } })
  const proposed = makeDoc({ w1: { type: 'single-value', path: 'environment.wind.angleApparent', unit: 'rad' } })
  const d = diffDashboards(current, proposed)
  assert.strictEqual(d.changed.length, 1)
  assert.strictEqual(d.changed[0].field, 'unit')
  assert.strictEqual(d.changed[0].was, 'deg')
  assert.strictEqual(d.changed[0].now, 'rad')
})

test('diffDashboards: changed label → one changed entry for field "label"', () => {
  const current = makeDoc({ w1: { type: 'single-value', path: 'navigation.speedOverGround', label: 'SOG' } })
  const proposed = makeDoc({ w1: { type: 'single-value', path: 'navigation.speedOverGround', label: 'Speed' } })
  const d = diffDashboards(current, proposed)
  assert.strictEqual(d.changed.length, 1)
  assert.strictEqual(d.changed[0].field, 'label')
  assert.strictEqual(d.changed[0].was, 'SOG')
  assert.strictEqual(d.changed[0].now, 'Speed')
})

// --- mixed ---

test('diffDashboards: mixed added + removed + changed', () => {
  const current = makeDoc({
    sog: { type: 'single-value', path: 'navigation.speedOverGround', unit: 'kn' },
    hdg: { type: 'compass', path: 'navigation.headingTrue' },
    old: { type: 'text', path: 'navigation.position' }
  })
  const proposed = makeDoc({
    sog: { type: 'gauge', path: 'navigation.speedOverGround', unit: 'kn' }, // changed type
    hdg: { type: 'compass', path: 'navigation.headingTrue' },                // unchanged
    newEl: { type: 'windrose', path: 'environment.wind.angleApparent' }      // added
    // old → removed
  })
  const d = diffDashboards(current, proposed)
  assert.deepStrictEqual(d.added, ['newEl'])
  assert.deepStrictEqual(d.removed, ['old'])
  assert.strictEqual(d.changed.length, 1)
  assert.strictEqual(d.changed[0].id, 'sog')
  assert.strictEqual(d.changed[0].field, 'type')
})

// --- no-op ---

test('diffDashboards: identical docs → empty result', () => {
  const doc = makeDoc({ sog: { type: 'single-value', path: 'navigation.speedOverGround', unit: 'kn' } })
  const d = diffDashboards(doc, doc)
  assert.deepStrictEqual(d.added, [])
  assert.deepStrictEqual(d.removed, [])
  assert.deepStrictEqual(d.changed, [])
})

// --- edge: empty docs ---

test('diffDashboards: both docs empty → all empty', () => {
  const d = diffDashboards(makeDoc({}), makeDoc({}))
  assert.deepStrictEqual(d.added, [])
  assert.deepStrictEqual(d.removed, [])
  assert.deepStrictEqual(d.changed, [])
})

test('diffDashboards: undefined current and proposed → empty result', () => {
  const d = diffDashboards(undefined, undefined)
  assert.deepStrictEqual(d.added, [])
  assert.deepStrictEqual(d.removed, [])
  assert.deepStrictEqual(d.changed, [])
})
