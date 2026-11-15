'use strict'
const path = require('path')
const fs = require('fs')

// The MIDL runtime: the built validator and the generated capability
// manifests. A checkout reads them from the midl submodule (run
// `npm run midl:build` first). An installed package has no submodule, so
// `prepack` stages a copy in lib/midl-runtime (tools/stage-midl-runtime.js).
// The submodule wins when both exist, so a checkout never runs a stale copy.
const SOURCES = [
  { dist: path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs'), schemas: path.join(__dirname, '..', 'midl', 'schemas', 'gen') },
  { dist: path.join(__dirname, 'midl-runtime', 'index.cjs'), schemas: path.join(__dirname, 'midl-runtime', 'schemas') }
]

function firstExisting (paths) {
  return paths.find((p) => fs.existsSync(p)) || paths[0]
}

function lib() {
  // Lazy require so a missing build yields a clear error, not a load-time crash.
  // eslint-disable-next-line global-require
  return require(firstExisting(SOURCES.map((s) => s.dist)))
}

// Load a generated capability manifest for a resolution class.
function manifestForClass(className) {
  const name = `yb-midl-capabilities.${className}.json`
  return JSON.parse(fs.readFileSync(firstExisting(SOURCES.map((s) => path.join(s.schemas, name))), 'utf8'))
}

// Validate a MIDL document (text) against a class's generated manifest.
function validateMidl(docText, className) {
  return lib().validateDocument(docText, manifestForClass(className), className)
}

// Resolution classes the generated manifests cover, and the class a display
// renders as.
const MIDL_CLASSES = [
  { id: 'landscape-1024x600', w: 1024, h: 600 },
  { id: 'landscape-800x480', w: 800, h: 480 },
  { id: 'square-480', w: 480, h: 480 },
  { id: 'round-360', w: 360, h: 360 }
]
const classById = (id) => MIDL_CLASSES.find((c) => c.id === id)
// A round panel is round-360 whatever its pixel size; otherwise an exact
// long/short edge match, else the nearest class of the same aspect family
// (landscape vs square) by edge distance. Rotation does not matter.
function classForDisplay (display) {
  if (display && String(display.shape || '').toLowerCase() === 'round') return classById('round-360')
  const w = Number(display && display.width) || 480
  const h = Number(display && display.height) || 480
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  const exact = MIDL_CLASSES.find((c) => c.w === long && c.h === short)
  if (exact) return exact
  if (long === short) return classById('square-480')
  const landscape = MIDL_CLASSES.filter((c) => c.w > c.h)
  const dist = (c) => Math.abs(c.w - long) + Math.abs(c.h - short)
  return landscape.reduce((best, c) => (dist(c) < dist(best) ? c : best))
}

// The validator is "unavailable" only when the built midl bundle is missing
// from this install (the npm package and the board image do not carry the
// midl submodule). Any other failure is a real error and is rethrown.
function isMissingBuild (e) {
  return !!(e && e.code === 'MODULE_NOT_FOUND' && SOURCES.some((s) => String(e.message || '').includes(s.dist)))
}

// Validate a MIDL document OBJECT against a class with midl's validator (the
// same checks the device runs, instruments#37). Returns { ok, className,
// issues } — or, without the validator, { ok: null, unavailable: true,
// className, issues: [], error }.
function checkMidlDoc (doc, className) {
  let r
  try {
    r = module.exports.validateMidl(JSON.stringify(doc), className)
  } catch (e) {
    if (!isMissingBuild(e)) throw e
    return { ok: null, unavailable: true, className, issues: [], error: 'midl validator not built into this install' }
  }
  const issues = (r.issues || []).filter((i) => i.severity !== 'warning')
  return { ok: !!r.ok, className, issues }
}

module.exports = {
  lib,
  manifestForClass,
  validateMidl,
  MIDL_CLASSES,
  classForDisplay,
  checkMidlDoc
}
