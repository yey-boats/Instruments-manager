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

// Resolution classes the generated manifests cover, and the class a display
// renders as. `maxTiles` mirrors the class's generated capability manifest
// (midl/schemas/gen/yb-midl-capabilities.<id>.json; a test pins it) so the
// tile cap holds in installs that do not ship the midl submodule (#41).
const MIDL_CLASSES = [
  { id: 'landscape-1024x600', w: 1024, h: 600, maxTiles: 6 },
  { id: 'landscape-800x480', w: 800, h: 480, maxTiles: 6 },
  { id: 'square-480', w: 480, h: 480, maxTiles: 9 },
  { id: 'round-360', w: 360, h: 360, maxTiles: 4 }
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

function httpError (status, code, message, details) {
  const err = new Error(message)
  err.status = status
  err.payload = { error: { code, message, details: details || {} } }
  return err
}

// The validator is "unavailable" only when the built midl bundle is missing
// from this install (the npm package and the board image do not carry the
// midl submodule). Any other failure is a real error and is rethrown.
function isMissingBuild (e) {
  return !!(e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').includes(DIST))
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

// #53: element attributes the v2 dashboard item has no slot for. The v2 item
// carries name, the value/dir bindings, format.unit, style.range/size/color
// and marker glyph/color/kind/dir; anything else in a placed element would be
// dropped on save, so it is refused (422 midl_unsupported) with the field
// named. Values that mean "the default" (Color "default", Scale "fixed", an
// empty zones/sectors list) lose nothing and pass. Carrying these to the
// device is the follow-up to #53.
const CARRIED_STYLE = new Set(['range', 'size', 'color'])
const STYLE_DEFAULT = {
  colorRole: (v) => v === 'default',
  scale: (v) => v === 'fixed',
  zones: (v) => Array.isArray(v) && v.length === 0,
  sectors: (v) => Array.isArray(v) && v.length === 0
}
const STYLE_HINT = {
  colorRole: 'the Color role (style.colorRole) cannot be saved to a device dashboard yet; set Color to "default" (a #rrggbb style.color is carried)',
  zones: 'Limits zones (style.zones) cannot be saved to a device dashboard yet; remove the zones (the range is carried)',
  sectors: 'dial sectors (style.sectors) cannot be saved to a device dashboard yet; remove style.sectors in the Source view',
  scale: 'Scale (style.scale) cannot be saved to a device dashboard yet; set Scale to "fixed"'
}
const FORMAT_HINT = {
  decimals: 'Decimals (format.decimals) cannot be saved to a device dashboard yet; clear Decimals',
  precision: 'format.precision cannot be saved to a device dashboard yet; remove it in the Source view',
  side: 'Sided (format.side) cannot be saved to a device dashboard yet; turn Sided off'
}
const CARRIED_MARKER = new Set(['glyph', 'color', 'kind', 'dir'])
const isEmptyVal = (v) => v === undefined || v === null
function uncarried (el, path) {
  const out = []
  const style = el.style && typeof el.style === 'object' && !Array.isArray(el.style) ? el.style : {}
  for (const [k, v] of Object.entries(style)) {
    if (CARRIED_STYLE.has(k) || isEmptyVal(v) || (STYLE_DEFAULT[k] && STYLE_DEFAULT[k](v))) continue
    out.push({ path: `${path}/style/${k}`, message: STYLE_HINT[k] || `style.${k} cannot be saved to a device dashboard yet; remove it in the Source view` })
  }
  const format = el.format && typeof el.format === 'object' && !Array.isArray(el.format) ? el.format : {}
  for (const [k, v] of Object.entries(format)) {
    if (k === 'unit' || isEmptyVal(v) || (k === 'side' && v === false)) continue
    out.push({ path: `${path}/format/${k}`, message: FORMAT_HINT[k] || `format.${k} cannot be saved to a device dashboard yet; remove it in the Source view` })
  }
  const bindings = el.bindings && typeof el.bindings === 'object' ? el.bindings : {}
  for (const k of Object.keys(bindings)) {
    if (k === 'value' || k === 'dir') continue
    out.push({ path: `${path}/bindings/${k}`, message: `the "${k}" binding cannot be saved to a device dashboard yet; only value and dir bindings are carried` })
  }
  if (!isEmptyVal(el.action)) out.push({ path: `${path}/action`, message: 'a tap action (action) cannot be saved to a device dashboard yet; remove the action' })
  if (!isEmptyVal(el.zoom)) out.push({ path: `${path}/zoom`, message: 'zoom cannot be saved to a device dashboard yet; remove it in the Source view' })
  if (Array.isArray(el.markers)) {
    el.markers.forEach((m, mi) => {
      if (!m || typeof m !== 'object') return
      for (const [k, v] of Object.entries(m)) {
        if (CARRIED_MARKER.has(k) || isEmptyVal(v)) continue
        out.push({ path: `${path}/markers/${mi}/${k}`, message: `marker.${k} cannot be saved to a device dashboard yet; only glyph, color, kind and dir are carried` })
      }
    })
  }
  return out
}

// What a MIDL document loses on the way through the v2 dashboard model
// (midlToV2 -> v2ToMidl), as validator-style issues. The v2 model only holds
// one top-level grid of single cells per screen, signalk value/dir bindings,
// and globally unique widget ids, so anything else would be silently dropped
// or rewritten on save.
function roundTripLoss (doc) {
  const { v2ToMidl, midlToV2 } = require('./midl-adapter')
  const issues = []
  if (!doc || !Array.isArray(doc.screens)) return [{ path: '/screens', message: 'screens must be an array' }]
  const screens = doc.screens
  screens.forEach((s, si) => {
    if (!s || typeof s !== 'object' || !s.elements || typeof s.elements !== 'object') {
      issues.push({ path: `/screens/${si}`, message: 'each screen needs an elements object' })
    }
  })
  if (issues.length) return issues
  const seen = new Map()
  screens.forEach((s, si) => {
    if (Array.isArray(s.variants) && s.variants.length) {
      issues.push({ path: `/screens/${si}/variants`, message: 'per-class layout variants cannot be saved to a device dashboard' })
    }
    const cells = s && s.layout && Array.isArray(s.layout.cells) ? s.layout.cells : null
    if (!cells) issues.push({ path: `/screens/${si}/layout`, message: 'only a top-level grid layout can be saved to a device dashboard' })
    ;(cells || []).forEach((c, ci) => {
      if (c && (Number(c.colSpan) > 1 || Number(c.rowSpan) > 1)) {
        issues.push({ path: `/screens/${si}/layout/cells/${ci}`, message: 'spanning cells cannot be saved to a device dashboard' })
      }
      if (c && !('element' in c) && Object.keys(c).some((k) => k !== 'colSpan' && k !== 'rowSpan')) {
        issues.push({ path: `/screens/${si}/layout/cells/${ci}`, message: 'nested layouts cannot be saved to a device dashboard' })
      }
    })
    const placedIds = new Set()
    ;(cells || []).forEach((c, ci) => {
      if (!c || !c.element) return
      if (placedIds.has(c.element)) issues.push({ path: `/screens/${si}/layout/cells/${ci}`, message: `element "${c.element}" is placed in more than one cell` })
      placedIds.add(c.element)
    })
    for (const [id, el] of Object.entries(s.elements)) {
      const prev = seen.get(id)
      if (prev && JSON.stringify(prev.el) !== JSON.stringify(el)) {
        issues.push({ path: `/screens/${si}/elements/${id}`, message: `element id "${id}" is used on screen ${prev.si} for a different element; ids must be unique across screens` })
      } else if (!prev) seen.set(id, { si, el })
    }
  })
  if (issues.length) return issues
  const back = v2ToMidl(midlToV2(doc))
  screens.forEach((s, si) => {
    const after = (back.screens[si] && back.screens[si].elements) || {}
    for (const [id, el] of Object.entries((s && s.elements) || {})) {
      const placed = s.layout.cells.some((c) => c && c.element === id)
      if (!placed) continue // never shown; dropping it changes nothing on the device
      const a = after[id]
      const path = `/screens/${si}/elements/${id}`
      const norm = (b) => (b && b.kind === 'signalk' && typeof b.path === 'string') ? { kind: 'signalk', path: b.path.trim() } : (b || null)
      const bv = (e) => norm(e && e.bindings && e.bindings.value)
      const bd = (e) => norm(e && e.bindings && e.bindings.dir)
      if (!a) {
        issues.push({ path, message: 'element cannot be represented on a device dashboard (it needs a signalk value binding)' })
      } else if (a.type !== el.type) {
        issues.push({ path: `${path}/type`, message: `element type "${el.type}" would be saved as "${a.type}"` })
      } else if (JSON.stringify(bv(a)) !== JSON.stringify(bv(el))) {
        issues.push({ path: `${path}/bindings/value`, message: 'only signalk value bindings can be saved to a device dashboard' })
      } else if (JSON.stringify(bd(a)) !== JSON.stringify(bd(el))) {
        issues.push({ path: `${path}/bindings/dir`, message: 'only signalk dir bindings can be saved to a device dashboard' })
      } else {
        // #38: range, size, colour and markers must come back unchanged;
        // what a device dashboard cannot hold of these is refused, not
        // dropped.
        const st = (e, k) => (e && e.style && typeof e.style === 'object' ? e.style[k] : undefined)
        const hex = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{3}$/.test(c) ? '#' + c.slice(1).split('').map((x) => x + x).join('') : c)
        const canon = (v) => JSON.stringify(v === undefined ? null : v)
        // range only means something on gauge/bar, markers only on dials.
        if ((el.type === 'gauge' || el.type === 'bar') && canon(st(a, 'range')) !== canon(st(el, 'range'))) {
          issues.push({ path: `${path}/style/range`, message: 'range must be [low, high] with low < high' })
        }
        if (canon(st(a, 'size')) !== canon(st(el, 'size'))) {
          issues.push({ path: `${path}/style/size`, message: 'style.size: size role tokens (S/M/L/XL/Fill) cannot be saved to a device dashboard yet; set Size to "unset" (or remove style.size, or set a pixel size such as 28, in the Source view)' })
        }
        const ca = st(a, 'color')
        const ce = st(el, 'color')
        if (canon(ca) !== canon(typeof ce === 'string' ? hex(ce).toLowerCase() === (ca || '').toLowerCase() ? ca : ce : ce)) {
          issues.push({ path: `${path}/style/color`, message: 'style.color: only a #rrggbb colour can be saved to a device dashboard (not a theme token)' })
        }
        const mk = (m) => ({ glyph: m && m.glyph, color: m && m.color, kind: m && m.kind, dir: m && m.dir ? { kind: m.dir.kind, path: m.dir.path } : null })
        const ma = Array.isArray(a.markers) ? a.markers.map(mk) : []
        const me = Array.isArray(el.markers) ? el.markers.map(mk) : []
        if ((el.type === 'compass' || el.type === 'windrose') && canon(ma) !== canon(me)) {
          issues.push({ path: `${path}/markers`, message: 'markers need a known glyph, a valid colour and a signalk dir binding (at most 12 per dial) to be saved to a device dashboard' })
        }
        // #53: everything else the v2 item has no slot for is refused by
        // name, never dropped on save.
        issues.push(...uncarried(el, path))
      }
    }
    // The grid must come back with the same shape and the same cell order.
    const bl = back.screens[si] && back.screens[si].layout
    const shape = (l) => JSON.stringify([l.rows, l.cols, l.cells.map((c) => (c && c.element) || null)])
    if (!bl || shape(bl) !== shape(s.layout)) {
      issues.push({ path: `/screens/${si}/layout`, message: 'this grid cannot be saved to a device dashboard with the same arrangement' })
    }
  })
  return issues
}

// #33: the single way a v2 dashboard leaves the manager as MIDL. Translates
// and validates; returns { doc, ok, className, issues[, unavailable] }.
function midlDocumentFor (v2dashboard, className) {
  const { v2ToMidl } = require('./midl-adapter')
  const doc = v2ToMidl(v2dashboard)
  return Object.assign({ doc }, checkMidlDoc(doc, className))
}

// Throwing form for anything that sends a MIDL document to a device: a doc
// the validator rejects is a 422 (`midl_invalid`, with the issues), and with
// no validator available the push fails closed (503).
function assertValid (r) {
  if (r.unavailable) {
    throw httpError(503, 'midl_validator_unavailable', 'the MIDL validator is not available in this install', {})
  }
  if (!r.ok) {
    throw httpError(422, 'midl_invalid', `MIDL document fails validation for ${r.className}`, { className: r.className, issues: r.issues })
  }
}
function requireValidMidlDoc (doc, className) {
  assertValid(checkMidlDoc(doc, className))
  return doc
}
function requireValidMidl (v2dashboard, className) {
  const { v2ToMidl } = require('./midl-adapter')
  return requireValidMidlDoc(v2ToMidl(v2dashboard), className)
}

module.exports = {
  lib,
  manifestForClass,
  validateMidl,
  validateV2AsMidl,
  MIDL_CLASSES,
  classForDisplay,
  checkMidlDoc,
  roundTripLoss,
  httpError,
  midlDocumentFor,
  requireValidMidl,
  requireValidMidlDoc
}
