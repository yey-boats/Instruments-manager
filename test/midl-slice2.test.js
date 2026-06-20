'use strict'
const { test, before } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.join(__dirname, '..')

before(() => {
  if (!fs.existsSync(path.join(root, 'midl', 'ts', 'dist', 'index.cjs'))) {
    execSync('npm run midl:build', { cwd: root, stdio: 'inherit' })
  }
})

const v2 = {
  settings: { defaultScreen: 'dashboard' },
  widgets: { items: { sog: { type: 'numeric', path: 'navigation.speedOverGround', unit: 'kn' } } },
  layout: { screens: [{ id: 'dashboard', type: 'grid', tiles: [{ widget: 'sog', area: { col: 0, row: 0 } }] }] },
}

test('validateV2AsMidl returns ok:true for a valid v2 dashboard', () => {
  const { validateV2AsMidl } = require('../lib/midl')
  const r = validateV2AsMidl(v2)
  assert.strictEqual(r.ok, true, JSON.stringify(r.issues))
  assert.ok(Array.isArray(r.issues))
})

test('validateV2AsMidl never throws on garbage input and returns an object with ok boolean', () => {
  const { validateV2AsMidl } = require('../lib/midl')
  const r = validateV2AsMidl({})
  assert.strictEqual(typeof r, 'object')
  assert.strictEqual(typeof r.ok, 'boolean')
})

test('validateV2AsMidl never throws on null/undefined input', () => {
  const { validateV2AsMidl } = require('../lib/midl')
  const r = validateV2AsMidl(null)
  assert.strictEqual(typeof r, 'object')
  assert.strictEqual(typeof r.ok, 'boolean')
})
