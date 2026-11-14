'use strict'
// Stage the MIDL runtime into lib/midl-runtime/ so `npm pack` ships it.
//
// lib/midl.js needs two things from the midl submodule at run time: the built
// validator (midl/ts/dist/index.cjs) and the generated capability manifests
// (midl/schemas/gen/*.json). The package's `files` list cannot reach them:
// the submodule's own .gitignore excludes dist/, and npm honours it. Without
// them an installed plugin has no device preview and fails every dashboard
// push closed (503). `prepack` runs this; it fails loudly rather than letting
// a tarball without the runtime go out.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'midl', 'ts', 'dist', 'index.cjs')
const gen = path.join(root, 'midl', 'schemas', 'gen')
const out = path.join(root, 'lib', 'midl-runtime')

function fail (msg) {
  console.error(`[stage-midl-runtime] ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(dist)) {
  spawnSync(process.execPath, [path.join(__dirname, 'ensure-midl-build.js')], { cwd: root, stdio: 'inherit' })
}
if (!fs.existsSync(dist)) fail('midl/ts/dist/index.cjs is missing (run `git submodule update --init midl && npm run midl:build`)')
const manifests = fs.existsSync(gen) ? fs.readdirSync(gen).filter((f) => /^yb-midl-capabilities\..+\.json$/.test(f)) : []
if (!manifests.length) fail('no capability manifests in midl/schemas/gen')

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'schemas'), { recursive: true })
fs.copyFileSync(dist, path.join(out, 'index.cjs'))
for (const f of manifests) fs.copyFileSync(path.join(gen, f), path.join(out, 'schemas', f))
console.log(`[stage-midl-runtime] staged the validator and ${manifests.length} manifests in lib/midl-runtime`)
