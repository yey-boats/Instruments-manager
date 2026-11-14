'use strict'
// The packed plugin must carry everything lib/midl.js needs at run time.
// Before this, `npm pack` shipped neither the validator nor the capability
// manifests (both live in the midl submodule), so an installed plugin showed
// "Preview unavailable" on every device page and refused every dashboard push.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const midlBuilt = fs.existsSync(path.join(root, 'midl', 'ts', 'dist', 'index.cjs'))
const needsBuild = { skip: midlBuilt ? false : 'MIDL bundle not built (midl/ts/dist/index.cjs missing)' }
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('prepack stages the MIDL runtime, and `files` ships it', () => {
  assert.match(pkg.scripts.prepack, /stage-midl-runtime/)
  assert.ok(pkg.files.includes('lib'), 'lib/ (and so lib/midl-runtime) is in the package')
})

test('the validator bundle\'s own requires are plugin dependencies', needsBuild, () => {
  const src = fs.readFileSync(path.join(root, 'midl', 'ts', 'dist', 'index.cjs'), 'utf8')
  const wanted = [...new Set([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))]
    .filter((name) => !name.startsWith('.') && !name.startsWith('node:') && !require('module').builtinModules.includes(name))
  for (const name of wanted) assert.ok(pkg.dependencies[name], `${name} is required by the MIDL bundle but is not a dependency`)
})

test('an install without the submodule validates and finds every manifest', needsBuild, () => {
  // Build what a packed install looks like: lib/ with the staged runtime, no midl/.
  const stage = spawnSync(process.execPath, [path.join(root, 'tools', 'stage-midl-runtime.js')], { cwd: root, encoding: 'utf8' })
  assert.strictEqual(stage.status, 0, stage.stderr)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ybdm-pack-'))
  try {
    fs.cpSync(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true })
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'))
    const script = `
      const m = require(${JSON.stringify(path.join(tmp, 'lib', 'midl.js'))})
      for (const c of m.MIDL_CLASSES) {
        const manifest = m.manifestForClass(c.id)
        if (!manifest || typeof manifest !== 'object') throw new Error('no manifest for ' + c.id)
      }
      const r = m.validateMidl('midl: 1.0.0\\nscreens: []\\n', 'square-480')
      if (!r || !Array.isArray(r.issues)) throw new Error('validator did not run')
    `
    const run = spawnSync(process.execPath, ['-e', script], { cwd: tmp, encoding: 'utf8' })
    assert.strictEqual(run.status, 0, run.stderr)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
