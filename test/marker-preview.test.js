// Compass / wind-rose marker-ring contract.
//
// Asserts the device-mirrored marker model the manager paints in previews and
// the device-page live view: the MARKER_GLYPHS token set + cap, and the
// default marker arrays wired into the screen presets. Markers are an ADDITIVE
// field on dial tiles — existing primary/secondary bindings must be unchanged.
//
// Pure (no process.exit) so it can be required into test/run.js.

const assert = require('assert')
const presets = require('../lib/screen-presets')
const { SK } = presets

// --- Glyph token set + cap ----------------------------------------------
const EXPECTED_GLYPHS = [
  'triangle', 'diamond', 'circle', 'bar', 'cross',
  'chevron_in', 'chevron_out', 'chevron_left', 'chevron_right', 'chevron_double'
]
assert.ok(Array.isArray(presets.MARKER_GLYPHS), 'MARKER_GLYPHS must be exported as an array')
assert.strictEqual(presets.MARKER_GLYPHS.length, 10, 'MARKER_GLYPHS must have 10 entries')
assert.deepStrictEqual(presets.MARKER_GLYPHS, EXPECTED_GLYPHS,
  'MARKER_GLYPHS must be in firmware order')
assert.strictEqual(presets.MAX_MARKERS_PER_DIAL, 12, 'MAX_MARKERS_PER_DIAL must be 12')

// WIDGET_TYPES.compass + windRose advertise the glyph set + cap to the editor.
for (const w of ['compass', 'windRose']) {
  assert.deepStrictEqual(presets.WIDGET_TYPES[w].markerGlyphs, EXPECTED_GLYPHS,
    `WIDGET_TYPES.${w}.markerGlyphs must be MARKER_GLYPHS`)
  assert.strictEqual(presets.WIDGET_TYPES[w].maxMarkers, 12,
    `WIDGET_TYPES.${w}.maxMarkers must be 12`)
}

// --- Helper: find a tile by widget within a screen ----------------------
function tileOf (screens, screenId, widget) {
  const scr = screens.find((s) => s.id === screenId)
  assert.ok(scr, `screen '${screenId}' must exist`)
  const tile = scr.tiles.find((t) => t.widget === widget)
  assert.ok(tile, `screen '${screenId}' must have a '${widget}' tile`)
  return tile
}

const screens = presets.getPresetsForClass('sunton-480')

// --- Steering compass markers + back-compat -----------------------------
const steer = tileOf(screens, 'steering', 'compass')
assert.deepStrictEqual(steer.markers, [
  { path: SK.heading, glyph: 'triangle', filled: true,  color: 'accent' },
  { path: SK.cog,     glyph: 'triangle', filled: false, color: 'good' },
  { path: SK.cts,     glyph: 'diamond',  filled: true,  color: 'alarm' }
], 'steering compass markers = HDG triangle/accent, COG triangle-hollow/good, CTS diamond/alarm')
// Back-compat: the canonical primary/secondary bindings are untouched. The
// canonical steering compass binds primary=heading and secondary=cts.
assert.strictEqual(steer.primary, SK.heading, 'steering compass primary must stay heading')
assert.strictEqual(steer.secondary, SK.cts, 'steering compass secondary must stay cts (unchanged)')

// --- Autopilot compass markers include the AP target --------------------
const ap = tileOf(screens, 'autopilot', 'autopilotHud')
assert.ok(Array.isArray(ap.markers), 'autopilot tile must carry a markers array')
const apTargetMarker = ap.markers.find((m) => m.path === SK.apTarget)
assert.ok(apTargetMarker, 'autopilot markers must include the AP target')
assert.deepStrictEqual(apTargetMarker, { path: SK.apTarget, glyph: 'diamond', filled: true, color: 'warn' },
  'autopilot AP-target marker = diamond/filled/warn')

// --- Dashboard wind-rose markers ----------------------------------------
const rose = tileOf(screens, 'dashboard', 'windRose')
assert.deepStrictEqual(rose.markers, [
  { path: SK.awa, glyph: 'chevron_in',  filled: true,  color: 'warn' },
  { path: SK.twa, glyph: 'chevron_out', filled: false, color: 'good' }
], 'dashboard windRose markers = apparent AWA chevron_in/warn, true TWA chevron_out/good')
// Back-compat: rose primary/secondary bindings untouched.
assert.strictEqual(rose.primary, SK.awa, 'windRose primary must stay apparent angle')
assert.strictEqual(rose.secondary, SK.aws, 'windRose secondary must stay apparent speed')

console.log('marker-preview: glyphs, cap, and steering/autopilot/windRose marker sets validated')
