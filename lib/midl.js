'use strict'
const path = require('path')
const fs = require('fs')

// Built CJS bundle from the MIDL submodule (run `npm run midl:build` first).
const DIST = path.join(__dirname, '..', 'midl', 'ts', 'dist', 'index.cjs')

function lib() {
  // Lazy require so a missing build yields a clear error, not a load-time crash.
  // eslint-disable-next-line global-require
  return require(DIST)
}

// Load a generated capability manifest for a resolution class from the submodule.
function manifestForClass(className) {
  const p = path.join(__dirname, '..', 'midl', 'schemas', 'gen', `yb-midl-capabilities.${className}.json`)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// Validate a MIDL document (text) against a class's generated manifest.
function validateMidl(docText, className) {
  return lib().validateDocument(docText, manifestForClass(className), className)
}

// Advisory: translate a v2 dashboard to MIDL and validate against a class manifest.
// Never throws on validation failure — returns { ok, issues }. Returns
// { ok: true, issues: [], skipped: true } if anything errors (e.g. build missing),
// so callers can stay non-fatal.
function validateV2AsMidl(v2dashboard, className) {
  try {
    const { v2ToMidl } = require('./midl-adapter')
    const cls = className || 'square-480'
    const doc = JSON.stringify(v2ToMidl(v2dashboard))
    return validateMidl(doc, cls)
  } catch (e) {
    return { ok: true, issues: [], skipped: true, error: String((e && e.message) || e) }
  }
}

module.exports = { lib, manifestForClass, validateMidl, validateV2AsMidl }
