const assert = require('assert')
const plugin = require('..')

const { formatFromForm, normalizeFormat, FORMAT_UNIT_CLASSES, configOverridesFromForm } = plugin._test

// --- defaults: an empty form yields the firmware defaults for all 7 classes ---
const defaults = formatFromForm({})
assert.deepStrictEqual(Object.keys(defaults).sort(), [
  'angle', 'depth', 'distance', 'percent', 'speed', 'temperature', 'voltage'
])
assert.deepStrictEqual(defaults.distance, { decimals: 2, si_prefix: true })
assert.deepStrictEqual(defaults.depth, { decimals: 1, si_prefix: true })
assert.deepStrictEqual(defaults.speed, { decimals: 1, si_prefix: false })
assert.deepStrictEqual(defaults.angle, { decimals: 0, si_prefix: false })
assert.deepStrictEqual(defaults.temperature, { decimals: 1, si_prefix: false })
assert.deepStrictEqual(defaults.voltage, { decimals: 2, si_prefix: false })
assert.deepStrictEqual(defaults.percent, { decimals: 0, si_prefix: false })

// the constant table must stay in sync with the firmware contract
assert.strictEqual(FORMAT_UNIT_CLASSES.length, 7)

// --- good values round-trip from the form ---
const good = formatFromForm({
  format_distance_decimals: '3',
  format_distance_si: '1',
  format_speed_decimals: '2',
  // speed si checkbox unchecked -> absent key -> false
  format_angle_decimals: '0',
  format_angle_si: '1'
})
assert.deepStrictEqual(good.distance, { decimals: 3, si_prefix: true })
assert.strictEqual(good.speed.decimals, 2)
assert.strictEqual(good.speed.si_prefix, false)
assert.deepStrictEqual(good.angle, { decimals: 0, si_prefix: true })
// untouched class falls back to its default
assert.deepStrictEqual(good.voltage, { decimals: 2, si_prefix: false })

// --- bad values: decimals out of range are clamped, not rejected ---
const bad = formatFromForm({
  format_distance_decimals: '9', // > 4 -> 4
  format_depth_decimals: '-3', // < 0 -> 0
  format_speed_decimals: 'abc' // NaN -> default (1)
})
assert.strictEqual(bad.distance.decimals, 4)
assert.strictEqual(bad.depth.decimals, 0)
assert.strictEqual(bad.speed.decimals, 1)

// --- normalizeFormat: validate-on-load fills + clamps a partial/legacy config ---
const norm = normalizeFormat({
  distance: { decimals: 99, si_prefix: false }, // clamp 99 -> 4
  speed: { decimals: 1 }, // missing si_prefix -> default false
  bogus: { decimals: 2 } // unknown class dropped
})
assert.strictEqual(norm.distance.decimals, 4)
assert.strictEqual(norm.distance.si_prefix, false)
assert.deepStrictEqual(norm.speed, { decimals: 1, si_prefix: false })
assert.strictEqual(norm.bogus, undefined)
// every canonical class is present after normalize
for (const cls of FORMAT_UNIT_CLASSES) {
  assert.ok(norm[cls.key], `normalizeFormat must include ${cls.key}`)
}

// normalize is idempotent: normalizing defaults yields defaults
assert.deepStrictEqual(normalizeFormat(normalizeFormat(defaults)), defaults)
// non-object input degrades to full defaults
assert.deepStrictEqual(normalizeFormat(null), defaults)

// --- end-to-end: format lands under settings.format in the pushed config ---
const overrides = configOverridesFromForm({
  defaultScreen: 'dashboard',
  theme: 'day',
  brightness: '0.8',
  format_temperature_decimals: '2',
  format_temperature_si: '1'
})
assert.ok(overrides.settings.format, 'settings.format must be present')
assert.deepStrictEqual(overrides.settings.format.temperature, { decimals: 2, si_prefix: true })
assert.deepStrictEqual(overrides.settings.format.distance, { decimals: 2, si_prefix: true })

console.log('number-format.test.js OK')
