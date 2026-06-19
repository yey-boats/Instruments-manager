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

module.exports = { lib, manifestForClass, validateMidl }
