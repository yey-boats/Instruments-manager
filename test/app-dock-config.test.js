// App-dock deployment contract.
//
// Verifies the SignalK `signalk-app-dock` plugin config carries the
// manager's launcher tile (label "ESP Displays", the plugin's icon). By
// default this runs against a committed fixture (test/fixtures/); set
// SIGNALK_APP_DOCK_CONFIG to a live server's
// `config/plugin-config-data/signalk-app-dock.json` to check a real install
// for drift.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { readJson } = require('../lib/store')
const { skip } = require('./test-utils')

const liveConfig = process.env.SIGNALK_APP_DOCK_CONFIG
const configPath = liveConfig || path.join(__dirname, 'fixtures', 'signalk-app-dock.json')

if (liveConfig && !fs.existsSync(liveConfig)) {
  skip('app-dock-config', `SIGNALK_APP_DOCK_CONFIG points at a missing file: ${liveConfig}`)
} else {
  const config = readJson(configPath, null)

  assert.ok(config, `app-dock config not readable at ${configPath}`)
  const apps = config.configuration && config.configuration.apps
  assert.ok(Array.isArray(apps))
  const tile = apps.find((app) => app.url === '/yey-boats-display-manager/')
  assert.ok(tile, 'app-dock must contain the yey-boats-display-manager tile')
  assert.strictEqual(tile.enabled, true)
  assert.strictEqual(tile.label, 'ESP Displays')
  assert.strictEqual(tile.icon, '/yey-boats-display-manager/icon.svg')
  console.log('app-dock-config: tile contract verified (%s)', liveConfig ? 'live' : 'fixture')
}
