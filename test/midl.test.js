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

test('validateMidl accepts a valid doc for square-480', () => {
  const { validateMidl } = require('../lib/midl')
  const doc = JSON.stringify({
    midl: '1.0.0',
    screens: [{ id: 'd', elements: { a: { type: 'single-value' } }, layout: { element: 'a' } }],
  })
  const r = validateMidl(doc, 'square-480')
  assert.strictEqual(r.ok, true, JSON.stringify(r.issues))
})

test('validateMidl rejects an unsupported element', () => {
  const { validateMidl } = require('../lib/midl')
  const doc = JSON.stringify({
    midl: '1.0.0',
    screens: [{ id: 'd', elements: { a: { type: 'no-such-widget' } }, layout: { element: 'a' } }],
  })
  const r = validateMidl(doc, 'square-480')
  assert.strictEqual(r.ok, false)
  assert.ok(r.issues.some((i) => /not supported/.test(i.message)))
})
