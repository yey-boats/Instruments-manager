'use strict'

// Theme picker offers every firmware theme (instruments: day, night,
// high-contrast, red-night, classic, sun) with readable labels, and every
// editor-side theme list agrees with the shared catalog in lib/themes.js.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const indexPlugin = require('../index')
const { makeManager } = require('./test-utils')
const { THEMES, THEME_IDS, isTheme } = require('../lib/themes')
const { DEFAULT_MANIFEST } = require('../lib/field-schema')

const EXPECTED = [
  ['sun', 'Sun'],
  ['day', 'Day'],
  ['night', 'Night'],
  ['red-night', 'Red night'],
  ['high-contrast', 'High contrast'],
  ['classic', 'Classic']
]

test('lib/themes lists all six firmware themes with readable labels', () => {
  assert.deepStrictEqual(THEMES.map((t) => [t.id, t.label]), EXPECTED)
  assert.deepStrictEqual(THEME_IDS, EXPECTED.map((e) => e[0]))
  assert.strictEqual(isTheme('red-night'), true)
  assert.strictEqual(isTheme('auto'), false)
  assert.strictEqual(isTheme(''), false)
})

test('field-schema fallback manifest offers all six themes', () => {
  assert.deepStrictEqual(DEFAULT_MANIFEST.themes, THEME_IDS)
})

test('device config form Theme select offers all six themes', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-themetheme01'
  manager.registerDevice({
    device: { id, name: 'Bench', role: 'display', board: 'sunton_4848s040', display: { width: 480, height: 480, shape: 'square' } }
  }, auth)
  manager.assignProfile(id, { profileId: 'default', overrides: { settings: { theme: 'red-night' } } })
  const html = indexPlugin.__renderDevicePage(manager, id)
  const m = html.match(/<select name="theme"[^>]*>([\s\S]*?)<\/select>/)
  assert.ok(m, 'theme select rendered')
  const opts = [...m[1].matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g)]
  assert.deepStrictEqual(opts.map((o) => [o[1], o[3]]), EXPECTED)
  const selected = opts.find((o) => /selected/.test(o[2]))
  assert.ok(selected && selected[1] === 'red-night', 'current theme is preselected')
})

test('browser-side editor manifests list all six themes', () => {
  const files = [
    'public/midl-editor.js',
    'public/midl-preview.js',
    'public/field-editor.js',
    'e2e/editor-demo/harness.js'
  ]
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    const lists = [...src.matchAll(/themes:\s*\[([^\]]*)\]/g)]
    assert.ok(lists.length > 0, `${f} declares a themes list`)
    for (const l of lists) {
      const ids = [...l[1].matchAll(/['"]([a-z-]+)['"]/g)].map((x) => x[1])
      assert.deepStrictEqual(ids, THEME_IDS, `${f} themes list`)
    }
  }
})

test('field-editor has a colour scheme preset for every theme', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/field-editor.js'), 'utf8')
  const block = src.match(/var SCHEMES = \{([\s\S]*?)\n {2}\};/)
  assert.ok(block, 'SCHEMES block found')
  for (const id of THEME_IDS) {
    const key = id.includes('-') ? `'${id}'` : id
    assert.ok(block[1].includes(`${key}: {`), `scheme for ${id}`)
  }
})

// Firmware palettes (instruments include/ui_palette.h, after the #67 AA
// contrast pass): value/line = accent, label = fg_dim, needle = warn.
test('firmware-only scheme presets match the firmware palettes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/field-editor.js'), 'utf8')
  const scheme = (key) => {
    const m = src.match(new RegExp(`${key}: \\{([^}]*)\\}`))
    assert.ok(m, `scheme ${key}`)
    return Object.fromEntries([...m[1].matchAll(/(\w+): '(#[0-9a-f]{6})'/g)].map((x) => [x[1], x[2]]))
  }
  const want = {
    sun: { value: '#0050a0', label: '#3a3a3a', needle: '#a05a00', line: '#0050a0' },
    "'red-night'": { value: '#ff7a29', label: '#d84a3a', needle: '#ffa028', line: '#ff7a29' },
    classic: { value: '#7a5a10', label: '#685d4e', needle: '#8a5500', line: '#7a5a10' }
  }
  for (const [key, colours] of Object.entries(want)) {
    const got = scheme(key)
    for (const [k, v] of Object.entries(colours)) assert.strictEqual(got[k], v, `${key}.${k}`)
  }
})

test('#69: a current theme the picker does not know stays selected', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-themetheme02'
  manager.registerDevice({
    device: { id, name: 'Bench', role: 'display', board: 'sunton_4848s040', display: { width: 480, height: 480, shape: 'square' } }
  }, auth)
  manager.assignProfile(id, { profileId: 'default', overrides: { settings: { theme: 'auto' } } })
  const html = indexPlugin.__renderDevicePage(manager, id)
  const m = html.match(/<select name="theme"[^>]*>([\s\S]*?)<\/select>/)
  const opts = [...m[1].matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g)]
  const selected = opts.filter((o) => /selected/.test(o[2]))
  assert.strictEqual(selected.length, 1)
  assert.strictEqual(selected[0][1], 'auto', 'unknown current theme kept, not defaulted to Day')
  assert.deepStrictEqual(opts.slice(0, 6).map((o) => o[1]), THEME_IDS)
})

test('#69: saving the device form keeps the submitted theme', () => {
  const { configOverridesFromForm } = indexPlugin._test
  for (const t of [...THEME_IDS, 'auto']) {
    assert.strictEqual(configOverridesFromForm({ theme: t }).settings.theme, t)
  }
})
