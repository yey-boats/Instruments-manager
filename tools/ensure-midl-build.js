'use strict'
// Ensure the MIDL submodule's CJS bundle is built before tests run.
//
// lib/midl.js requires midl/ts/dist/index.cjs; several suites (midl-adapter,
// midl-slice2, ...) need it. Building is idempotent and cheap once done, so we
// build only when the bundle is missing. If the submodule isn't checked out at
// all we warn and continue — suites that need it skip-with-reason (MGR-1).
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'midl', 'ts', 'dist', 'index.cjs')
const tsDir = path.join(root, 'midl', 'ts')

if (fs.existsSync(dist)) process.exit(0)

if (!fs.existsSync(tsDir)) {
  console.warn('[ensure-midl-build] midl submodule not initialized ' +
    '(run `git submodule update --init midl`); MIDL suites will skip.')
  process.exit(0)
}

console.log('[ensure-midl-build] building MIDL bundle (midl/ts/dist/index.cjs)...')
const res = spawnSync('npm', ['run', 'midl:build'], {
  cwd: root,
  stdio: 'inherit'
})
if (res.status !== 0) {
  console.warn('[ensure-midl-build] midl:build failed; MIDL suites will skip.')
}
process.exit(0)
