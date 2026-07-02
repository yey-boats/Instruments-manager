// Widget visual parity contract.
//
// Asserts the editor's `widgetPreview()` CSS palette and font choices
// match the device's LVGL render (src/ui/ui_theme.cpp + ui_layouts.cpp).
// If either side drifts, this test fails - that's the whole point: the
// editor card pixels should be a faithful preview of what the device
// will actually paint.
//
// We don't compare rendered pixels here (that would need Playwright +
// a real-device screenshot fixture, see widget-parity.pw.js). Instead
// we cross-check the declarative bits: palette hex values, font family,
// and which slot uses which color.
//
// The editor HTML lives in this repo (public/layout-editor.html) so the
// editor-internal checks always run. The device C++ lives in the sibling
// `instruments` repo; point INSTRUMENTS_SRC at that checkout's root (the
// dir containing src/ui/) to run the cross-repo palette/font parity checks.
// Absent that, the device-side checks skip-with-reason so `npm test` stays
// green on a bare clone (MGR-1).

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { skip } = require('./test-utils')

const editorHtmlPath = process.env.LAYOUT_EDITOR_HTML ||
  path.join(__dirname, '..', 'public', 'layout-editor.html')
const editorHtml = fs.readFileSync(editorHtmlPath, 'utf8')

// --- Resolve optional device (instruments) source -----------------------
const instrumentsSrc = process.env.INSTRUMENTS_SRC
let themeCpp = null
let layoutsCpp = null
if (instrumentsSrc) {
  const themePath = path.join(instrumentsSrc, 'src', 'ui', 'ui_theme.cpp')
  const layoutsPath = path.join(instrumentsSrc, 'src', 'ui', 'ui_layouts.cpp')
  if (fs.existsSync(themePath) && fs.existsSync(layoutsPath)) {
    themeCpp = fs.readFileSync(themePath, 'utf8')
    layoutsCpp = fs.readFileSync(layoutsPath, 'utf8')
  }
}

// --- Extract device night palette from ui_theme.cpp ---------------------
// The default `theme = { ... }` block is hex-color literals; pull them out.
function deviceNightPalette () {
  // Match the first `Palette theme = { ... };` initializer.
  const m = themeCpp.match(/Palette theme = \{([\s\S]*?)\};/m)
  assert.ok(m, 'device ui_theme.cpp must declare Palette theme = { ... }')
  const hexes = [...m[1].matchAll(/0x([0-9a-fA-F]{6})/g)].map((x) => '#' + x[1].toLowerCase())
  // struct Palette order: bg, panel, panel_bot, panel_edge, badge, fg, fg_dim,
  // accent, warn, alarm, good, port, starboard, grid, arc_band (15 fields).
  assert.strictEqual(hexes.length, 15,
    'expected 15 palette colors in ui_theme.cpp, got ' + hexes.length)
  return {
    bg: hexes[0],
    panel: hexes[1],
    panelBot: hexes[2],
    panelEdge: hexes[3],
    badge: hexes[4],
    fg: hexes[5],
    fgDim: hexes[6],
    accent: hexes[7],
    warn: hexes[8],
    alarm: hexes[9],
    good: hexes[10],
    port: hexes[11],
    starboard: hexes[12],
    grid: hexes[13],
    arcBand: hexes[14]
  }
}

// --- Extract editor :root palette from layout-editor.html ---------------
function editorRootPalette () {
  const m = editorHtml.match(/:root \{([\s\S]*?)\}/m)
  assert.ok(m, 'editor layout-editor.html must declare :root { ... }')
  function v (name) {
    const re = new RegExp('--' + name + ':\\s*([#0-9a-fA-F]+)')
    const mm = m[1].match(re)
    assert.ok(mm, ':root must declare --' + name)
    return mm[1].toLowerCase()
  }
  return {
    bg: v('bg'),
    panel: v('panel'),
    panelEdge: v('panel-edge'),
    fg: v('fg'),
    fgDim: v('fg-dim'),
    accent: v('accent'),
    warn: v('warn'),
    port: v('port'),
    starboard: v('starboard')
  }
}

const editor = editorRootPalette()

// Match lv_conf.h's enabled Montserrat sizes. Adding a size here must
// also be matched by `#define LV_FONT_MONTSERRAT_<n> 1` in lv_conf.h.
const allowedFonts = [
  'lv_font_montserrat_14',
  'lv_font_montserrat_16',
  'lv_font_montserrat_18',
  'lv_font_montserrat_20',
  'lv_font_montserrat_28',
  'lv_font_montserrat_38',
  'lv_font_montserrat_48'
]

// --- Palette parity (cross-repo; requires device source) ----------------
if (themeCpp && layoutsCpp) {
  const device = deviceNightPalette()
  const overlap = ['bg', 'panel', 'panelEdge', 'fg', 'fgDim', 'accent', 'warn', 'port', 'starboard']
  for (const key of overlap) {
    assert.strictEqual(
      editor[key], device[key],
      `palette mismatch for ${key}: editor=${editor[key]} device=${device[key]} ` +
        '(both must agree; sync ui_theme.cpp use_night() with editor :root)'
    )
  }

  // The device's `build_tile` sets primary value color via the call right
  // before `lv_obj_align(t.value`. Confirm it's theme.accent.
  const buildTileBlock = layoutsCpp.match(/t\.value = lv_label_create[\s\S]*?lv_obj_align\(t\.value/m)
  assert.ok(buildTileBlock, 'ui_layouts.cpp must contain build_tile primary value block')
  assert.ok(/lv_obj_set_style_text_color\(t\.value,\s*lv_color_hex\(theme\.accent\)/.test(buildTileBlock[0]),
    'device build_tile primary value color must be theme.accent, ' +
      'matches editor .num-primary { color: var(--accent) }')

  // Hero plus primary value also accent.
  const heroPlusBlock = layoutsCpp.match(/st->primary_value = lv_label_create[\s\S]*?lv_obj_align\(st->primary_value/m)
  assert.ok(heroPlusBlock, 'ui_layouts.cpp must contain hero_plus primary_value block')
  assert.ok(/lv_obj_set_style_text_color\(st->primary_value,\s*lv_color_hex\(theme\.accent\)/.test(heroPlusBlock[0]),
    'device hero_plus primary_value color must be theme.accent')

  // The device build_tile + hero_plus + status_list use lv_font_montserrat_*.
  // Spot-check that no foreign font has snuck in.
  const fontRefs = [...layoutsCpp.matchAll(/&(lv_font_[a-z0-9_]+)/g)].map((m) => m[1])
  for (const f of fontRefs) {
    assert.ok(allowedFonts.includes(f),
      `ui_layouts.cpp uses font ${f}; only Montserrat variants are allowed (matches editor)`)
  }
  console.log('widget-parity: %d palette colors + device fonts cross-checked against %s',
    overlap.length, instrumentsSrc)
} else {
  skip('widget-parity (device cross-check)',
    'set INSTRUMENTS_SRC to a sibling instruments checkout (with src/ui/*.cpp) to run device parity')
}

// --- Numeric primary value color contract (editor-internal) -------------
// Editor .num-primary uses var(--accent); device build_tile must set
// primary value color to theme.accent (not theme.fg).
const editorNumPrimary = editorHtml.match(/\.wpreview \.num-primary[^{]*\{([^}]*)\}/)
assert.ok(editorNumPrimary, 'editor must declare .wpreview .num-primary CSS rule')
assert.ok(/color:\s*var\(--accent\)/.test(editorNumPrimary[1]),
  '.num-primary must use var(--accent); got: ' + editorNumPrimary[1].trim())

// --- Primary font-size parity (editor-internal) --------------------------
// Editor .num-primary px size must match a lv_font_montserrat_<N>
// variant that's actually enabled in lv_conf.h, otherwise the preview
// drifts from device pixels. Same for .compass .heading and .rose
// (windRose center) - both of which use the hero accent number.
function editorFontSize (selector) {
  const re = new RegExp(`\\.wpreview ${selector.replace(/\./g, '\\.')}[^{]*\\{([^}]*)\\}`)
  const m = editorHtml.match(re)
  assert.ok(m, `editor must declare ${selector} CSS rule`)
  const sz = m[1].match(/font-size:\s*([0-9]+)px/)
  assert.ok(sz, `${selector} must declare a px font-size; got: ${m[1].trim()}`)
  return parseInt(sz[1], 10)
}
const numPx = editorFontSize('.num-primary')
const compassPx = editorFontSize('.compass .heading')
const rosePx = editorFontSize('.rose')
for (const [name, px] of [['num-primary', numPx], ['compass.heading', compassPx], ['rose', rosePx]]) {
  assert.ok(allowedFonts.includes(`lv_font_montserrat_${px}`),
    `editor ${name} font-size ${px}px must match an enabled lv_font_montserrat_<N> ` +
      'variant in lv_conf.h. Allowed: ' + allowedFonts.join(', '))
}

// --- Font family parity (editor-internal) -------------------------------
// The editor must use Montserrat in body + .wpreview so its render
// approximates the device's lv_font_montserrat_*.
const bodyRule = editorHtml.match(/body\s*\{([^}]*)\}/)
assert.ok(bodyRule, 'editor must declare body { ... }')
assert.ok(/font:[^;]*Montserrat/i.test(bodyRule[1]),
  'editor body font must include Montserrat; got: ' + bodyRule[1].trim())

const wpreviewRule = editorHtml.match(/\.wpreview\s*\{([^}]*)\}/)
assert.ok(wpreviewRule, 'editor must declare .wpreview { ... }')
assert.ok(/font-family:[^;]*Montserrat/i.test(wpreviewRule[1]),
  'editor .wpreview font-family must include Montserrat; got: ' + wpreviewRule[1].trim())

// --- SVG embedded fonts in widgetPreview must be Montserrat -------------
// All widgetPreview SVG <text font-family="..."> should be Montserrat
// (Inter was the previous outlier; the layout-editor refactor sync'd it).
const svgFonts = [...editorHtml.matchAll(/font-family="([^"]+)"/g)].map((m) => m[1])
for (const f of svgFonts) {
  assert.strictEqual(f, 'Montserrat',
    `editor SVG font-family must be Montserrat (matches device LVGL); got: ${f}`)
}

console.log('widget-parity: editor-internal checks passed (%d SVG fonts, %d palette vars)',
  svgFonts.length, Object.keys(editor).length)
