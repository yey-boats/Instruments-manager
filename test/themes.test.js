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
const { MockFirmware } = require('./mock-firmware')
const { THEMES, THEME_IDS, isTheme } = require('../lib/themes')

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

// #71: the per-device Theme setting (settings.theme) is stored and delivered
// in the generated config, but the firmware never reads settings.theme — it
// applies only cfg.ui.theme (src/manager.cpp in yey-boats/instruments). With
// day/night switching off, generateConfig must emit ui.theme from
// settings.theme, so a loaded config actually changes the display's theme.
test('#71: a per-device Theme setting reaches the firmware as ui.theme', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-theme71'
  const fw = new MockFirmware(manager, { deviceId: id, auth })
  fw.register()
  manager.assignProfile(id, { profileId: 'default', overrides: { settings: { theme: 'classic' } } })
  const cfg = manager.generateConfig(id)
  assert.strictEqual(cfg.settings.theme, 'classic', 'settings.theme carries the per-device setting')
  assert.strictEqual(cfg.ui && cfg.ui.theme, 'classic', 'ui.theme mirrors settings.theme -- the field the firmware applies')
  fw.fetchConfig()
  assert.strictEqual(fw.theme, 'classic', 'the mock firmware (applyConfig reads cfg.ui.theme) actually changed theme')
})

test('#71: every firmware theme round-trips settings.theme -> ui.theme -> the display', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  for (const t of THEME_IDS) {
    const id = `yey-d-theme71-${t}`
    const fw = new MockFirmware(manager, { deviceId: id, auth })
    fw.register()
    manager.assignProfile(id, { profileId: 'default', overrides: { settings: { theme: t } } })
    fw.fetchConfig()
    assert.strictEqual(fw.theme, t, `${t} reaches the display`)
  }
})
