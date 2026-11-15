const assert = require('assert')
const plugin = require('..')

const overrides = plugin._test.configOverridesFromForm({
  defaultScreen: 'dashboard',
  theme: 'day',
  brightness: '0.75',
  fontSize: '18',
  labelFontSize: '12',
  valueFontSize: '36',
  unitFontSize: '14',
  widgetId: ['sog', 'awa', 'draft widget'],
  widgetTitle: ['SOG', 'AWA', 'Draft'],
  widgetType: ['numeric', 'numeric', 'bar'],
  widgetPath: [
    'navigation.speedOverGround',
    'environment.wind.angleApparent',
    'environment.depth.belowTransducer'
  ],
  widgetUnit: ['kn', 'deg', 'm'],
  widgetPrecision: ['1', '0', '1'],
  widgetValueFontSize: ['48', '', '28'],
  removeWidget: ['awa'],
  screenId: ['dashboard'],
  screenType: ['grid'],
  tileScreen: ['dashboard', 'dashboard', 'dashboard'],
  tileWidget: ['sog', 'awa', 'draft-widget'],
  tileCol: ['0', '1', '0'],
  tileRow: ['0', '0', '1']
})

assert.strictEqual(overrides.settings.defaultScreen, 'dashboard')
assert.strictEqual(overrides.settings.brightness, 0.75)
// MIDL-only screens: the form carries non-screen settings only; v2
// widgets/layout fields are ignored.
assert.strictEqual(overrides.widgets, undefined)
assert.strictEqual(overrides.layout, undefined)
assert.strictEqual(overrides.debug.logLevel, 'info')
