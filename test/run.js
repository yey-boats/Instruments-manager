// Aggregate test runner.
//
// Runs every suite and reports ALL failures at the end instead of aborting on
// the first one (fail-fast previously masked the back half of the suite,
// including the OTA tests — see MGR-1/MGR-2). Any failure sets a non-zero exit
// code so CI stays honest.
const path = require('path')
const { spawnSync } = require('child_process')

const failures = []

function record (name, err) {
  failures.push({ name, err })
  console.error(`\nFAIL ${name}:`)
  console.error(err && err.stack ? err.stack : err)
}

// --- Synchronous suites (top-level assert style) ------------------------
// Requiring them runs their assertions inline; a throw is one suite failing.
const SYNC_TESTS = [
  './plugin.test',
  './firmware-contract.test',
  './auth-token.test',
  './mock-firmware.test',
  './display-widgets.test',
  './ota-validate.test',
  './manifest.test',
  './settings.test',
  './provision-number.test',
  './provision-config.test',
  './ui-restructure.test',
  './marker-preview.test',
  './dashboard.test',
  './discovery.test',
  './discovery-claim-e2e.test',
  './mdns-discovery.test',
  './webapp-metadata.test',
  './app-dock-config.test',
  './ui-config-widget.test',
  './dashboard-import-export.test',
  './dashboard-editor-form.test',
  './number-format.test',
  './widget-parity.test',
  './preset-coverage.test',
  './device-projections.test'
]

for (const t of SYNC_TESTS) {
  try {
    require(t)
  } catch (err) {
    record(t, err)
  }
}

// --- node:test-style suites ---------------------------------------------
// These use `node:test` + `node:assert` rather than the synchronous top-level
// assert style above. They run via a spawned `node --test` so their failures
// set a non-zero exit code. Add new node:test files here.
const NODE_TEST_FILES = [
  'field-schema.test.js',
  'editor-crud.test.js',
  'midl-adapter.test.js',
  'midl-diff.test.js'
]
function runNodeTestSuites () {
  if (!NODE_TEST_FILES.length) return
  const args = ['--test', ...NODE_TEST_FILES.map((f) => path.join(__dirname, f))]
  const res = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (res.status !== 0) {
    record('node:test suites (field-schema and friends)',
      new Error(`node --test exited ${res.status}`))
  }
}

// --- Async suites -------------------------------------------------------
// proto-control runs first and sequentially (not in the Promise.all batch): it
// loads the ESM @yeyboats/proto lib and spins up mock HTTP targets, which would
// otherwise starve the event loop during the timing-sensitive UDP tests.
async function runAsync (name, load) {
  try {
    await load()
  } catch (err) {
    record(name, err)
  }
}

const ASYNC_BATCH = [
  ['knob-contract', './knob-contract.test'],
  ['github-firmware', './github-firmware.test'],
  ['firmware-source-kind', './firmware-source-kind.test'],
  ['tip-artifacts', './tip-artifacts.test'],
  ['udp-discovery', './udp-discovery.test'],
  ['device-udp-discovery', './device-udp-discovery.test'],
  ['discovery-scan', './discovery-scan.test'],
  ['signalk-register-device', './signalk-register-device.test'],
  ['live-device', './live-device.test'],
  ['device-resolution', './device-resolution.test']
]

async function main () {
  await runAsync('proto-control', () => require('./proto-control.test'))
  await Promise.all(ASYNC_BATCH.map(([name, mod]) => runAsync(name, () => require(mod))))
  runNodeTestSuites()

  if (failures.length) {
    console.error(`\n${failures.length} suite(s) failed: ${failures.map((f) => f.name).join(', ')}`)
    process.exit(1)
  }
  console.log('yey-boats-display-manager test suite passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
