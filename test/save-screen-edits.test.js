'use strict'

// Rich edit-fields round-trip: the live-preview "Save to view"/"Save as new"
// edits must persist KIND (widget type) + per-element COLOR — not just `path` —
// for BOTH authored-widget tiles (rebind in place) and preset grid tiles
// (steering/route/trip/dashboard) materialized into a synthetic widget. Backs
// applyScreenEdits() (extracted from the save-screen route) and the device-page
// projection (tilesFor) that surfaces color back to the preview.

const { test } = require('node:test')
const assert = require('node:assert')
const indexPlugin = require('../index')
const { applyScreenEdits } = indexPlugin._test
const renderDevicePage = indexPlugin.__renderDevicePage
const { makeManager } = require('./test-utils')

test('applyScreenEdits rebinds an authored widget: path + kind + color round-trip', () => {
  const cfg = {
    widgets: { items: { w_nav_1: { type: 'numeric', title: 'SOG', path: 'navigation.speedThroughWater' } } },
    layout: { screens: [{ id: 'nav', tiles: [{ widget: 'w_nav_1' }] }] }
  }
  applyScreenEdits(cfg, [{
    widgetId: 'w_nav_1', screenId: 'nav', tileIndex: 0,
    widget: 'gauge', title: 'SOG', unit: 'kn', path: 'navigation.speedOverGround',
    color: { value: '#36d399', label: '#8fa7bd' }
  }])
  const it = cfg.widgets.items.w_nav_1
  assert.strictEqual(it.path, 'navigation.speedOverGround', 'path rebound')
  assert.strictEqual(it.type, 'gauge', 'KIND (widget type) round-trips')
  assert.deepStrictEqual(it.color, { value: '#36d399', label: '#8fa7bd' }, 'colors round-trip')
})

test('applyScreenEdits clears color when every element is unset (theme default)', () => {
  const cfg = {
    widgets: { items: { w_nav_1: { type: 'numeric', path: 'x', color: { value: '#ff0000' } } } },
    layout: { screens: [{ id: 'nav', tiles: [{ widget: 'w_nav_1' }] }] }
  }
  applyScreenEdits(cfg, [{ widgetId: 'w_nav_1', screenId: 'nav', tileIndex: 0, widget: 'numeric', path: 'x', color: null }])
  assert.ok(!('color' in cfg.widgets.items.w_nav_1), 'color dropped -> reverts to theme')
})

test('applyScreenEdits drops invalid hex / pollution keys from color', () => {
  const cfg = { widgets: { items: { w_a_0: { type: 'numeric', path: 'p' } } }, layout: { screens: [{ id: 'a', tiles: [{ widget: 'w_a_0' }] }] } }
  applyScreenEdits(cfg, [{
    widgetId: 'w_a_0', screenId: 'a', tileIndex: 0, widget: 'numeric', path: 'p',
    color: { value: '#abcdef', label: 'red', __proto__: '#000000' }
  }])
  assert.deepStrictEqual(cfg.widgets.items.w_a_0.color, { value: '#abcdef' }, 'only valid hex kept')
})

test('applyScreenEdits materializes a synthetic widget for a preset grid tile (steering) with kind+color', () => {
  // A steering screen seeded with full inline tiles (preset projection); the
  // operator rebinds tile 1 with a new KIND + color. The other tiles must be
  // preserved and the synthetic widget must carry kind + color.
  const cfg = {
    widgets: { items: {} },
    layout: {
      screens: [{
        id: 'steering',
        tiles: [
          { widget: 'compass', primary: 'navigation.headingTrue' },
          { widget: 'numeric', primary: 'navigation.courseRhumbline.crossTrackError' },
          { widget: 'numeric', primary: 'navigation.courseRhumbline.velocityMadeGood' },
          { widget: 'numeric', primary: 'navigation.courseRhumbline.nextPoint.bearingTrue' }
        ]
      }]
    }
  }
  applyScreenEdits(cfg, [{
    widgetId: null, screenId: 'steering', tileIndex: 1,
    widget: 'bar', title: 'XTE', unit: 'm', path: 'navigation.courseRhumbline.crossTrackError',
    color: { value: '#4fc3f7', fill: '#ffb84d' }
  }])
  const w = cfg.widgets.items.w_steering_1
  assert.ok(w, 'synthetic widget materialized')
  assert.strictEqual(w.type, 'bar', 'KIND persisted on synthetic widget')
  assert.deepStrictEqual(w.color, { value: '#4fc3f7', fill: '#ffb84d' }, 'color persisted on synthetic widget')
  const steering = cfg.layout.screens.find((s) => s.id === 'steering')
  assert.strictEqual(steering.tiles.length, 4, 'all four steering tiles preserved')
  assert.strictEqual(steering.tiles[1].widget, 'w_steering_1', 'tile 1 references the synthetic widget')
  assert.ok(!steering.tiles[1].primary, 'stale inline primary dropped on the edited tile')
  // Tiles 0/2/3 keep their seeded inline bindings (so editing one tile does not
  // blank the rest of the screen).
  assert.strictEqual(steering.tiles[0].primary, 'navigation.headingTrue')
  assert.strictEqual(steering.tiles[2].primary, 'navigation.courseRhumbline.velocityMadeGood')
})

test('device-page projection surfaces kind + color back to the preview', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-dddddddddddd'
  manager.registerDevice({
    device: { id, name: 'Bench', role: 'display', board: 'sunton_4848s040', display: { width: 480, height: 480, shape: 'square' } }
  }, auth)
  // Author a profile with a steering screen whose tile 1 is a managed widget
  // carrying a non-default KIND + color, and assign it.
  manager.upsertProfile({
    id: 'rich',
    name: 'Rich',
    config: {
      widgets: { version: 1, items: { w_steering_1: { type: 'bar', title: 'XTE', path: 'navigation.courseRhumbline.crossTrackError', color: { value: '#36d399', fill: '#ffb84d' } } } },
      layout: { version: 1, screens: [{ id: 'steering', type: 'grid', tiles: [{ widget: 'compass', primary: 'navigation.headingTrue' }, { widget: 'w_steering_1', title: 'XTE' }, { widget: 'numeric', primary: 'navigation.courseRhumbline.velocityMadeGood' }, { widget: 'numeric', primary: 'navigation.courseRhumbline.nextPoint.bearingTrue' }] }] }
    }
  })
  manager.assignProfile(id, { profileId: 'rich' })
  // Make the device report a steering screen so deviceViews surfaces it.
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { screen: 'steering', screens: [{ id: 'steering', title: 'Steering' }] } }, auth)

  const html = renderDevicePage(manager, id)
  const m = html.match(/window\.__yeyboatsPreview=(.*?);window\.__yeyboatsDeviceId/)
  assert.ok(m, 'preview JSON injected')
  const preview = JSON.parse(m[1].replace(/\\u003c/g, '<'))
  const steering = preview.screens.find((s) => s.id === 'steering')
  assert.ok(steering, 'steering screen projected')
  const xte = steering.tiles[1]
  assert.strictEqual(xte.widget, 'bar', 'projected tile carries the managed KIND')
  assert.deepStrictEqual(xte.color, { value: '#36d399', fill: '#ffb84d' }, 'projected tile carries color overrides')
  assert.strictEqual(xte.editable, true, 'managed steering tile is editable')
  // The manifest the rich editor gates KINDs to is shipped in the payload.
  assert.ok(preview.manifest && Array.isArray(preview.manifest.viewTypes) && preview.manifest.viewTypes.length, 'manifest viewTypes shipped')
  assert.ok(preview.manifest.colorElements && preview.manifest.colorElements.bar, 'color elements shipped')
})

// --- Fullscreen HUD field overrides --------------------------------------
// A radial/HUD screen (autopilot/wind/wind_steer/wind_classic) has no per-tile
// slots — it reads a fixed set of LOGICAL fields each bindable to a SignalK
// path (+ optional colour). The save handler persists them under the authored
// screen's `hud.fields[key]={path,color}`; the projection surfaces them back.

test('applyScreenEdits persists HUD field overrides under the authored screen', () => {
  const cfg = { widgets: { items: {} }, layout: { screens: [] } }
  applyScreenEdits(cfg, [{
    hud: true, screenId: 'wind', kind: 'windDial',
    fields: {
      awa: { path: 'environment.wind.angleApparent', color: '#ff8800' },
      aws: { path: 'environment.wind.speedApparent' },
      tws: { color: '#36d399' }
    }
  }])
  const scr = cfg.layout.screens.find((s) => s.id === 'wind')
  assert.ok(scr && scr.hud, 'authored wind screen carries an hud block')
  assert.strictEqual(scr.hud.kind, 'windDial')
  assert.deepStrictEqual(scr.hud.fields.awa, { path: 'environment.wind.angleApparent', color: '#ff8800' }, 'path + colour round-trip')
  assert.deepStrictEqual(scr.hud.fields.aws, { path: 'environment.wind.speedApparent' }, 'path-only field')
  assert.deepStrictEqual(scr.hud.fields.tws, { color: '#36d399' }, 'colour-only field')
})

test('applyScreenEdits drops invalid hex + pollution keys from HUD overrides', () => {
  const cfg = { widgets: { items: {} }, layout: { screens: [] } }
  // Parse from JSON so __proto__ is an OWN enumerable key (the real attack
  // shape from a posted edits payload), not a literal prototype assignment.
  const fields = JSON.parse('{"apTarget":{"path":"steering.autopilot.target.headingTrue","color":"red"},"heading":{"path":"  "},"__proto__":{"path":"x"}}')
  applyScreenEdits(cfg, [{ hud: true, screenId: 'autopilot', kind: 'autopilotHud', fields }])
  const scr = cfg.layout.screens.find((s) => s.id === 'autopilot')
  assert.ok(scr && scr.hud, 'hud block created')
  assert.deepStrictEqual(scr.hud.fields.apTarget, { path: 'steering.autopilot.target.headingTrue' }, 'bad hex dropped, path kept')
  assert.ok(!Object.prototype.hasOwnProperty.call(scr.hud.fields, 'heading'), 'blank path -> field dropped')
  assert.ok(!Object.prototype.hasOwnProperty.call(scr.hud.fields, '__proto__'), 'pollution key rejected')
})

test('applyScreenEdits removes the HUD block when every field reverts to default', () => {
  const cfg = { widgets: { items: {} }, layout: { screens: [{ id: 'wind', tiles: [], hud: { kind: 'windDial', fields: { awa: { path: 'p' } } } }] } }
  applyScreenEdits(cfg, [{ hud: true, screenId: 'wind', kind: 'windDial', fields: {} }])
  const scr = cfg.layout.screens.find((s) => s.id === 'wind')
  assert.ok(scr && !scr.hud, 'empty override clears the hud block -> reverts to defaults')
})

test('device-page projection surfaces stored HUD overrides back to the preview', () => {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const id = 'yey-d-eeeeeeeeeeee'
  manager.registerDevice({
    device: { id, name: 'Bench', role: 'display', board: 'sunton_4848s040', display: { width: 480, height: 480, shape: 'square' } }
  }, auth)
  manager.upsertProfile({
    id: 'hud',
    name: 'Hud',
    config: {
      widgets: { version: 1, items: {} },
      layout: { version: 1, screens: [{ id: 'wind', type: 'grid', tiles: [], hud: { kind: 'windDial', fields: { awa: { path: 'environment.wind.angleApparent', color: '#ff8800' } } } }] }
    }
  })
  manager.assignProfile(id, { profileId: 'hud' })
  manager.updateStatus(id, { time: new Date().toISOString(), ui: { screen: 'wind', screens: [{ id: 'wind', title: 'Wind' }] } }, auth)

  const html = renderDevicePage(manager, id)
  const m = html.match(/window\.__yeyboatsPreview=(.*?);window\.__yeyboatsDeviceId/)
  assert.ok(m, 'preview JSON injected')
  const preview = JSON.parse(m[1].replace(/\\u003c/g, '<'))
  const wind = preview.screens.find((s) => s.id === 'wind')
  assert.ok(wind && wind.hud, 'wind screen projects its hud overrides')
  assert.strictEqual(wind.hud.kind, 'windDial')
  assert.deepStrictEqual(wind.hud.fields.awa, { path: 'environment.wind.angleApparent', color: '#ff8800' }, 'stored override surfaced for the editor')
})
