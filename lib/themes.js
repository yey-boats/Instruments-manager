'use strict'

// Display themes the yey-boats firmware renders (instruments ui_theme.cpp
// k_themes). day / night / high-contrast mirror the MIDL catalog; red-night,
// classic and sun are firmware skins. Order is the picker order: the owner's
// day choice (Sun) and night choice (Red night) lead their pairs.
const THEMES = Object.freeze([
  Object.freeze({ id: 'sun', label: 'Sun' }),
  Object.freeze({ id: 'day', label: 'Day' }),
  Object.freeze({ id: 'night', label: 'Night' }),
  Object.freeze({ id: 'red-night', label: 'Red night' }),
  Object.freeze({ id: 'high-contrast', label: 'High contrast' }),
  Object.freeze({ id: 'classic', label: 'Classic' })
])

const THEME_IDS = Object.freeze(THEMES.map((t) => t.id))

function isTheme (id) {
  return typeof id === 'string' && THEME_IDS.includes(id)
}

function themeLabel (id) {
  const t = THEMES.find((x) => x.id === id)
  return t ? t.label : String(id || '')
}

module.exports = { THEMES, THEME_IDS, isTheme, themeLabel }
