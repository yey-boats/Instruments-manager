/* Device-page live preview: renders an authored screen layout (widgets.items +
 * layout.screens) bound to LIVE SignalK data, so the operator sees what the
 * screen resembles with real values before switching/saving. Self-contained;
 * reads window.__yeyboatsPreview = { screens:[{id,title,tiles:[...]}], current }.
 * Tiles are flattened server-side to {widget,title,path,unit,precision}. */
(function () {
  'use strict'
  const cfg = window.__yeyboatsPreview || {}
  const root = document.getElementById('lp-root')
  const sel = document.getElementById('lp-screen')
  if (!root) return

  const values = Object.create(null) // signalk path -> latest value
  // initialScreen (carried through a save redirect) wins over the device's
  // current screen, so a reload after Save-to-view/Save-as-new keeps the
  // operator's pick instead of snapping back.
  let currentScreenId = cfg.initialScreen || cfg.current || (cfg.screens && cfg.screens[0] && cfg.screens[0].id)
  const editChk = document.getElementById('lp-edit')
  // stable tile-edit key -> { path, screenId, tileIndex, widgetId, widget, color, ... }
  const editsMap = Object.create(null)
  let editMode = false

  // --- rich edit-mode manifest (Slice: rich edit fields) -------------------
  // Injected by the server from lib/field-schema.js: the KINDs the device
  // manifest supports, the unit families (for path-compatibility filtering),
  // and the per-kind color elements. Falls back to a sane built-in set so the
  // editor still works if the payload predates this slice.
  const MANIFEST = cfg.manifest || {}
  const MANIFEST_KINDS = Array.isArray(MANIFEST.viewTypes) && MANIFEST.viewTypes.length
    ? MANIFEST.viewTypes
    : ['numeric', 'compass', 'windCircle', 'gauge', 'bar', 'trend', 'text']
  const COLOR_ELEMENTS = MANIFEST.colorElements || {
    numeric: ['value', 'label'], text: ['value', 'label'], trend: ['value', 'label', 'line'],
    gauge: ['value', 'label', 'needle', 'arc'], bar: ['value', 'label', 'fill'],
    compass: ['value', 'label', 'needle'], windCircle: ['value', 'label', 'needle', 'dir'],
    control: ['value', 'label']
  }
  // KIND -> renderable preview widget name. The manifest speaks field-schema's
  // vocabulary (windCircle/gauge/control); the preview renderer speaks the
  // firmware grid vocabulary (windRose/numeric). Map so a chosen KIND both
  // round-trips its manifest name to the device AND renders live here.
  const KIND_TO_WIDGET = { windCircle: 'windRose', gauge: 'numeric', control: 'text' }
  function kindToWidget (kind) { return KIND_TO_WIDGET[kind] || kind || 'numeric' }
  // KINDs we can actually render a live preview for (intersect with manifest).
  const RENDERABLE = ['numeric', 'compass', 'windCircle', 'gauge', 'bar', 'trend', 'text']
  function editableKinds () {
    const ks = MANIFEST_KINDS.filter((k) => RENDERABLE.indexOf(k) >= 0)
    return ks.length ? ks : RENDERABLE.slice()
  }

  // Physical-quantity inference (mirrors quantityForPath in lib/field-schema.js)
  // so the path picker can filter candidates to those compatible with the KIND.
  function quantityForPath (p) {
    p = String(p || '')
    if (!p) return null
    const leaf = p.split('.').pop() || ''
    if (/crossTrackError|distance/i.test(leaf)) return 'length'
    if (/speed|drift|velocity|sog|stw|tws|aws/i.test(p)) return 'speed'
    if (/angle|heading|course|bearing|direction|setTrue|cog|track/i.test(p)) return 'angle'
    if (/depth/i.test(p)) return 'depth'
    if (/temperature|temp/i.test(p)) return 'temp'
    if (/stateOfCharge|currentLevel|relativeHumidity|ratio/i.test(p)) return 'ratio'
    if (/voltage/i.test(p)) return 'voltage'
    return null
  }
  // Is a path COMPATIBLE with a KIND? compass/windCircle want angle paths;
  // gauge/bar/numeric/trend/text accept any scalar path.
  function pathFitsKind (path, kind) {
    if (kind === 'compass' || kind === 'windCircle') return quantityForPath(path) === 'angle'
    return true
  }
  // Candidate path catalogue: the curated datalist (cfg.previewPaths) unioned
  // with every path the live SignalK stream has actually delivered, so the
  // operator can bind anything the boat is publishing right now.
  function candidatePaths () {
    const set = new Set()
    ;(cfg.previewPaths || []).forEach((p) => { if (p) set.add(p) })
    Object.keys(values).forEach((p) => set.add(p))
    return Array.from(set).sort()
  }
  // Live value preview string for an arbitrary path (uses the same conversion
  // as a tile so the operator sees what they'd be binding).
  function liveValueFor (path) {
    if (!path) return ''
    const v = values[path]
    if (v === undefined || v === null) return '—'
    if (typeof v === 'object') {
      if (typeof v.latitude === 'number' && typeof v.longitude === 'number') {
        return v.latitude.toFixed(3) + ',' + v.longitude.toFixed(3)
      }
      return '—'
    }
    const u = unitFor({ path: path })
    return valueFor({ path: path }) + (u ? ' ' + u : '')
  }
  const THEME_SWATCHES = ['#4fc3f7', '#36d399', '#ffb84d', '#ff5252', '#288cff', '#8fa7bd', '#eef4fa']

  // --- unit + value formatting (mirror the device's conventions) -----------
  // Preset tiles often carry no unit, so infer one from the SignalK path:
  // speeds -> kn, angles/headings/bearings -> deg, depth -> m, temp -> °C,
  // ratios -> %, voltage -> V. tile.unit (if set) overrides the inference.
  function unitFor (tile) {
    if (tile.unit) return tile.unit
    const p = tile.path || ''
    // Classify by the LEAF segment, not the whole path: every route metric
    // lives under navigation.courseRhumbline.*, so a naive /course/ test made
    // XTE / VMG / DTW all read as degrees (XTE 23 m -> "1318°"). The length +
    // speed leaves must be matched BEFORE the angle leaf (crossTrackError /
    // bearingTrackTrue both contain "track").
    const leaf = (p.split('.').pop() || '')
    if (/crossTrackError/i.test(leaf)) return 'm'
    if (/distance/i.test(leaf)) return 'nm'
    if (/speed|drift|velocityMadeGood/i.test(leaf)) return 'kn'
    if (/angle|heading|bearing|direction|course|cog|track|setTrue/i.test(leaf)) return '°'
    if (/depth/i.test(p)) return 'm'
    if (/temperature/i.test(leaf)) return '°C'
    if (/stateOfCharge|currentLevel|relativeHumidity/i.test(leaf)) return '%'
    if (/voltage/i.test(leaf)) return 'V'
    return ''
  }
  function valueFor (tile) {
    if (!tile.path) return '--'
    const v = values[tile.path]
    if (v === undefined || v === null) return '--'
    if (typeof v === 'object') {
      if (typeof v.latitude === 'number' && typeof v.longitude === 'number') {
        return v.latitude.toFixed(4) + ', ' + v.longitude.toFixed(4)
      }
      return '--'
    }
    if (typeof v !== 'number') return String(v)
    const unit = unitFor(tile)
    let x = v
    if (unit === 'kn') x = v * 1.94384
    else if (unit === '°' || unit === 'deg') x = v * 180 / Math.PI
    else if (unit === '%') x = v <= 1.0001 ? v * 100 : v
    else if (unit === '°C') x = v - 273.15
    else if (unit === 'nm') x = v / 1852 // SK distance is metres
    // 'm' (XTE / depth) and 'V' are already in display units — no conversion.
    const p = tile.precision != null ? tile.precision : (unit === '°' ? 0 : 1)
    return x.toFixed(p)
  }
  function percent (tile) {
    const v = values[tile.path]
    if (typeof v !== 'number') return 0
    const x = v <= 1.0001 ? v * 100 : v
    return Math.max(0, Math.min(100, x))
  }

  // --- compass / wind-rose marker rings (device-mirrored) ------------------
  // A dial tile may carry markers:[{path,glyph,filled,color}]. We paint each
  // glyph around a round ring at its live bearing. Glyph token set + fill/hollow
  // unicode + theme->CSS color map mirror the firmware.
  const GLYPH_CHARS = {
    triangle:       ['▲', '△'],
    diamond:        ['◆', '◇'],
    circle:         ['●', '○'],
    bar:            ['▮', '▯'],
    cross:          ['✚', '✛'],
    chevron_in:     ['▼', '▽'],
    chevron_out:    ['▲', '△'],
    chevron_left:   ['◀', '◁'],
    chevron_right:  ['▶', '▷'],
    chevron_double: ['«', '‹']
  }
  const MARKER_COLORS = {
    accent: '#4fc3f7', good: '#36d399', warn: '#ffb84d', alarm: '#ff5252'
  }
  function glyphChar (glyph, filled) {
    const pair = GLYPH_CHARS[glyph]
    if (!pair) return '●'
    return filled ? pair[0] : pair[1]
  }
  // Read a marker's live bearing from SignalK (RADIANS) -> degrees [0,360).
  // null when the path has no numeric value (skip the marker).
  function markerDeg (marker) {
    if (!marker || typeof marker.path !== 'string') return null
    const v = values[marker.path]
    if (typeof v !== 'number' || !isFinite(v)) return null
    let deg = v * 180 / Math.PI
    deg = ((deg % 360) + 360) % 360
    return deg
  }

  // --- rich per-tile editor (KIND + scrollable VALUE picker + COLORS) ------
  // Stable edit key: authored tiles rebind their own widget in place; preset/
  // managed tiles get a synthetic screenId+index key the server materializes.
  function editKeyFor (scr, tile, tileIndex) {
    return (tile.widgetId && tile.editable) ? ('w:' + tile.widgetId) : ('t:' + scr.id + ':' + tileIndex)
  }
  // Capture the tile's full current state into editsMap so KIND/path/color all
  // round-trip together (a later edit of one attr must not drop the others).
  function commitEdit (scr, tile, tileIndex) {
    editsMap[editKeyFor(scr, tile, tileIndex)] = {
      widgetId: (tile.widgetId && tile.editable) ? tile.widgetId : null,
      screenId: scr.id,
      tileIndex: tileIndex,
      widget: tile.kind || tile.widget || 'numeric', // KIND (manifest vocabulary)
      title: tile.title || '',
      unit: tile.unit || '',
      precision: tile.precision != null ? tile.precision : null,
      path: tile.path || '',
      color: (tile.color && Object.keys(tile.color).length) ? tile.color : null
    }
    dirty = true
  }
  function buildTileEditor (cell, scr, tile, tileIndex) {
    // tile.kind is the manifest KIND (windCircle/gauge/...); tile.widget is the
    // renderable preview widget. Initialise kind from the existing widget.
    if (!tile.kind) {
      const inv = { windRose: 'windCircle' }
      tile.kind = inv[tile.widget] || tile.widget || 'numeric'
    }
    const panel = document.createElement('div')
    panel.className = 'lp-edit'

    // KIND selector ---------------------------------------------------------
    const kindRow = document.createElement('label'); kindRow.className = 'lp-edit-row'
    kindRow.appendChild(document.createTextNode('kind'))
    const kindSel = document.createElement('select'); kindSel.className = 'lp-edit-sel'
    editableKinds().forEach((k) => {
      const o = document.createElement('option'); o.value = k; o.textContent = k
      if (k === tile.kind) o.selected = true
      kindSel.appendChild(o)
    })
    kindSel.addEventListener('change', () => {
      tile.kind = kindSel.value
      tile.widget = kindToWidget(tile.kind)
      // Re-render the tile in the new kind; prune color elements not in the new
      // kind so we don't persist stale swatches.
      if (tile.color) {
        const allow = new Set(COLOR_ELEMENTS[tile.kind] || ['value', 'label'])
        Object.keys(tile.color).forEach((e) => { if (!allow.has(e)) delete tile.color[e] })
      }
      commitEdit(scr, tile, tileIndex)
      renderScreen()
    })
    kindRow.appendChild(kindSel)
    panel.appendChild(kindRow)

    // VALUE (path) picker: scrollable, filtered to kind-compatible paths, each
    // option shows the live current value. A free-text box (datalist) lets the
    // operator type any path; the list below previews + binds on click. -------
    const pathRow = document.createElement('div'); pathRow.className = 'lp-edit-row lp-edit-col'
    const pathLab = document.createElement('div'); pathLab.className = 'lp-edit-lab'
    pathLab.textContent = 'value (path)'
    pathRow.appendChild(pathLab)
    const pathInp = document.createElement('input')
    pathInp.className = 'lp-edit-path'
    pathInp.value = tile.path || ''
    pathInp.setAttribute('list', 'lp-paths')
    pathInp.placeholder = 'signalk path'
    pathInp.addEventListener('change', () => {
      tile.path = pathInp.value.trim()
      commitEdit(scr, tile, tileIndex)
      dirty = true
    })
    pathRow.appendChild(pathInp)
    // current bound value readout
    const cur = document.createElement('div'); cur.className = 'lp-edit-cur'
    cur.textContent = tile.path ? (tile.path + ' = ' + liveValueFor(tile.path)) : 'no path bound'
    pathRow.appendChild(cur)
    // scrollable candidate list, filtered by kind compatibility
    const list = document.createElement('div'); list.className = 'lp-edit-paths'
    candidatePaths().filter((p) => pathFitsKind(p, tile.kind)).forEach((p) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'lp-edit-prow' + (p === tile.path ? ' active' : '')
      const name = document.createElement('span'); name.className = 'lp-edit-pname'; name.textContent = p
      const lv = document.createElement('span'); lv.className = 'lp-edit-plv'; lv.textContent = liveValueFor(p)
      row.appendChild(name); row.appendChild(lv)
      row.addEventListener('click', () => {
        tile.path = p
        pathInp.value = p
        commitEdit(scr, tile, tileIndex)
        renderScreen()
      })
      list.appendChild(row)
    })
    pathRow.appendChild(list)
    panel.appendChild(pathRow)

    // COLORS: one swatch row per color element of the KIND. Default = theme
    // (unset). Only persists the elements the operator actually changes. ------
    const elems = COLOR_ELEMENTS[tile.kind] || ['value', 'label']
    elems.forEach((elm) => {
      const row = document.createElement('div'); row.className = 'lp-edit-row lp-edit-color'
      const lab = document.createElement('span'); lab.className = 'lp-edit-clab'; lab.textContent = elm
      row.appendChild(lab)
      const sw = document.createElement('div'); sw.className = 'lp-edit-sw'
      const cur = (tile.color && tile.color[elm]) || null
      function pick (hex) {
        tile.color = tile.color || {}
        if (hex == null) delete tile.color[elm]
        else tile.color[elm] = hex
        if (!Object.keys(tile.color).length) tile.color = null
        commitEdit(scr, tile, tileIndex)
        renderScreen()
      }
      THEME_SWATCHES.forEach((hex) => {
        const s = document.createElement('span')
        s.className = 'lp-sw' + (cur === hex ? ' active' : '')
        s.style.background = hex
        s.title = hex
        s.addEventListener('click', () => pick(hex))
        sw.appendChild(s)
      })
      const custom = document.createElement('input')
      custom.type = 'color'; custom.className = 'lp-sw-custom'; custom.value = cur || '#4fc3f7'; custom.title = 'custom'
      custom.addEventListener('change', () => pick(custom.value))
      sw.appendChild(custom)
      const clr = document.createElement('button')
      clr.type = 'button'; clr.className = 'lp-sw-theme' + (cur ? '' : ' active'); clr.textContent = 'theme'
      clr.title = 'use theme default (unset)'
      clr.addEventListener('click', () => pick(null))
      sw.appendChild(clr)
      row.appendChild(sw)
      panel.appendChild(row)
    })

    cell.appendChild(panel)
  }

  // --- render one screen's tiles into the grid -----------------------------
  function screenById (id) {
    const scr = (cfg.screens || []).find((s) => s.id === id)
    return scr || (cfg.screens || [])[0] || null
  }
  // A fullscreen HUD screen is one whose device id maps to a built-in HUD
  // (autopilot / wind / wind_steer / wind_classic), or whose single tile is a
  // fullscreen widget. Rendered faithfully (compass band, no-go sectors, etc.)
  // by DeviceHud, bound to live SignalK values.
  function fullscreenKind (scr) {
    const Hud = window.DeviceHud
    if (!Hud || !scr) return null
    const byId = Hud.fullscreenForScreen(scr.id)
    if (byId) return byId
    const t = scr.tiles && scr.tiles[0]
    if (scr.tiles && scr.tiles.length === 1 && t && Hud.isFullscreenWidget(t.widget)) return t.widget
    return null
  }
  function renderScreen () {
    root.replaceChildren()
    root.classList.toggle('lp-editing', editMode)
    const scr = screenById(currentScreenId)
    const Hud = window.DeviceHud
    // The built-in System/status panel: the device renders a diagnostics list,
    // not a tile grid. Render it faithfully from live SignalK + the device's
    // reported telemetry (cfg.telemetry), not the generic preset grid.
    if (scr && Hud && Hud.isSystemScreen(scr.id)) {
      const stage = document.createElement('div')
      stage.className = 'lp-hud'
      stage.innerHTML = Hud.systemPanel(Hud.accessor(values), cfg.telemetry || {})
      root.appendChild(stage)
      return
    }
    // The built-in Trip screen: the device renders a bespoke odometer (distance
    // hero + time/avg/max stat cards + live SOG), not a metric grid. Render it
    // faithfully from live SignalK + device telemetry (the odometer
    // accumulators are device-side state; absent ones show "--").
    if (scr && Hud && Hud.isTripScreen(scr.id) && Hud.tripHud) {
      const stage = document.createElement('div')
      stage.className = 'lp-hud'
      stage.innerHTML = Hud.tripHud(Hud.accessor(values), cfg.telemetry || {})
      root.appendChild(stage)
      return
    }
    const kind = fullscreenKind(scr)
    if (kind && Hud) {
      const stage = document.createElement('div')
      stage.className = 'lp-hud'
      stage.innerHTML = Hud.fullscreen(kind, Hud.accessor(values))
      root.appendChild(stage)
      return
    }
    if (!scr || !Array.isArray(scr.tiles) || !scr.tiles.length) {
      const m = document.createElement('div')
      m.className = 'lp-empty'
      m.textContent = 'No managed layout for this view (firmware built-in screen).'
      root.appendChild(m)
      return
    }
    const grid = document.createElement('div')
    grid.className = 'lp-grid' + (editMode ? ' lp-grid-edit' : '')
    scr.tiles.forEach((tile, tileIndex) => {
      const cell = document.createElement('div')
      cell.className = 'lp-tile lp-w-' + (tile.widget || 'numeric')
      // Per-element color overrides round-tripped from the editor (element ->
      // #rrggbb). Unset elements fall back to the stylesheet's theme defaults.
      const col = (tile.color && typeof tile.color === 'object') ? tile.color : null
      const cap = document.createElement('div')
      cap.className = 'lp-cap'
      cap.textContent = (tile.title || (tile.path || '').split('.').pop() || '').toUpperCase()
      if (col && col.label) cap.style.color = col.label
      cell.appendChild(cap)
      const Hud = window.DeviceHud
      const isPos = /position/i.test(tile.path || '')
      const hasMarkers = Array.isArray(tile.markers) && tile.markers.length
      if ((tile.widget === 'compass' || tile.widget === 'windRose') && hasMarkers) {
        // Device-mirrored marker ring. North-up compass / bow-up windRose:
        // center value, N/E/S/W cardinals (compass only), one glyph per live
        // marker (skip markers whose bearing is null). center=65, glyph
        // radius = 65-14 = 51.
        const isRose = tile.widget === 'windRose'
        const ring = document.createElement('div')
        ring.className = 'lp-ring' + (isRose ? ' lp-rose' : '')
        const ctr = document.createElement('div')
        ctr.className = 'lp-val lp-val-sm'
        ctr.textContent = valueFor(tile)
        if (col && col.value) ctr.style.color = col.value
        ring.appendChild(ctr)
        if (!isRose) {
          for (const [lab, cls] of [['N', 'lp-card-n'], ['E', 'lp-card-e'], ['S', 'lp-card-s'], ['W', 'lp-card-w']]) {
            const c = document.createElement('div')
            c.className = 'lp-card ' + cls
            c.textContent = lab
            ring.appendChild(c)
          }
        }
        const CENTER = 65, RAD = 65 - 14
        tile.markers.forEach((m) => {
          const deg = markerDeg(m)
          if (deg == null) return
          const angleRad = (deg - 90) * Math.PI / 180
          const x = CENTER + RAD * Math.cos(angleRad)
          const y = CENTER + RAD * Math.sin(angleRad)
          const span = document.createElement('span')
          span.className = 'lp-rmark'
          span.style.left = x.toFixed(1) + 'px'
          span.style.top = y.toFixed(1) + 'px'
          span.style.transform = 'translate(-50%,-50%)'
          span.style.color = MARKER_COLORS[m.color] || '#4fc3f7'
          span.textContent = glyphChar(m.glyph, m.filled)
          ring.appendChild(span)
        })
        cell.appendChild(ring)
      } else if (tile.widget === 'compass' && Hud) {
        // Faithful mini compass dial (heading-up ring + COG) instead of a
        // bare number, matching the device's grid compass tile.
        const holder = document.createElement('div'); holder.className = 'lp-compass'
        holder.innerHTML = Hud.compassTileSVG(Hud.accessor(values), tile)
        cell.appendChild(holder)
      } else if (tile.widget === 'bar') {
        const bar = document.createElement('div'); bar.className = 'lp-bar'
        const fill = document.createElement('div'); fill.className = 'lp-bar-fill'
        fill.style.height = percent(tile) + '%'
        if (col && col.fill) fill.style.background = col.fill
        bar.appendChild(fill); cell.appendChild(bar)
        const val = document.createElement('div'); val.className = 'lp-val lp-val-sm'
        const u = unitFor(tile)
        val.textContent = valueFor(tile) + (u ? ' ' + u : '')
        if (col && col.value) val.style.color = col.value
        cell.appendChild(val)
      } else if (tile.widget === 'text' || isPos) {
        // Position / text tile: format lat-lon as DMS (two lines), like device.
        const pos = Hud && Hud.accessor(values).position()
        const val = document.createElement('div'); val.className = 'lp-val lp-val-pos'
        if (pos && isPos) {
          const [la, lo] = Hud.dms(pos)
          val.textContent = la + '\n' + lo
        } else {
          val.textContent = valueFor(tile)
        }
        if (col && col.value) val.style.color = col.value
        cell.appendChild(val)
      } else {
        const val = document.createElement('div'); val.className = 'lp-val'
        val.textContent = valueFor(tile)
        if (col && col.value) val.style.color = col.value
        const unit = document.createElement('span'); unit.className = 'lp-unit'
        unit.textContent = unitFor(tile)
        val.appendChild(unit); cell.appendChild(val)
      }
      if (editMode) buildTileEditor(cell, scr, tile, tileIndex)
      grid.appendChild(cell)
    })
    root.appendChild(grid)
  }

  // throttle re-render to ~5 Hz (matches the device refresh cadence)
  let dirty = false
  setInterval(() => {
    // Don't rebuild the DOM while the operator is interacting with the rich
    // editor (path box, kind select, color picker) — a re-render would steal
    // focus / collapse an open dropdown mid-edit.
    const ae = document.activeElement
    const editing = ae && ((ae.classList && ae.classList.contains('lp-edit-path')) ||
      (ae.closest && ae.closest('.lp-edit')))
    if (dirty && !editing) {
      dirty = false
      renderScreen()
    }
  }, 200)

  // --- live SignalK stream (same-origin; uses the logged-in session) -------
  function connect () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws
    try { ws = new WebSocket(proto + '//' + location.host + '/signalk/v1/stream?subscribe=all') } catch (e) { return }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch (_) { return }
      if (!msg.updates) return
      msg.updates.forEach((u) => (u.values || []).forEach((val) => {
        if (val && typeof val.path === 'string') values[val.path] = val.value
      }))
      dirty = true
    }
    ws.onclose = () => setTimeout(connect, 3000)
    ws.onerror = () => { try { ws.close() } catch (_) {} }
  }

  // Treat a redirect-carried initialScreen as a user pick so the device-views
  // poll won't override it back to the device's current screen.
  let userPicked = !!cfg.initialScreen
  if (sel) {
    sel.addEventListener('change', () => { userPicked = true; currentScreenId = sel.value; renderScreen() })
  }
  if (editChk) {
    editChk.addEventListener('change', () => { editMode = editChk.checked; renderScreen() })
  }
  // Serialize the pending edits as the server's rich edit objects (carries the
  // synthetic screenId+tileIndex for preset tiles so a rebind round-trips).
  function editsPayload () {
    return JSON.stringify(Object.keys(editsMap).map((k) => editsMap[k]))
  }
  // Submit buttons: switch (screen.set) / update (save+reload) / create (new view).
  const form = document.getElementById('lp-form')
  if (form) {
    document.querySelectorAll('#lp-form button[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode
        if (mode === 'switch') {
          // AJAX so the page does NOT reload and the selected preview screen
          // stays put; just tell the device to switch + update the indicator.
          userPicked = true
          const fd = new URLSearchParams()
          fd.set('mode', 'switch')
          fd.set('screenId', currentScreenId || '')
          fd.set('edits', '[]')
          fd.set('ajax', '1')
          fetch(form.getAttribute('action'), {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
            body: fd.toString()
          })
            .then((r) => r.ok ? r.json() : null)
            .then((d) => { if (d && d.screenId && nowEl) nowEl.textContent = titleOf(d.screenId) })
            .catch(() => {})
          return
        }
        // update / create still persist server-side via the form post; the
        // selected screen is carried back through the redirect (?screen=).
        const mEl = document.getElementById('lp-f-mode')
        const sEl = document.getElementById('lp-f-screen')
        const eEl = document.getElementById('lp-f-edits')
        if (mEl) mEl.value = mode
        if (sEl) sEl.value = currentScreenId || ''
        if (eEl) eEl.value = editsPayload()
        form.requestSubmit()
      })
    })
  }
  // Keep the preview's current screen synced with what the device is actually
  // showing: poll the device-views projection; when the device's reported
  // current screen changes (and the user isn't mid-edit), follow it.
  const nowEl = document.getElementById('lp-now-screen')
  function titleOf (idv) {
    const s = (cfg.screens || []).find((x) => x.id === idv)
    return (s && s.title) || idv || '—'
  }
  if (nowEl) nowEl.textContent = titleOf(cfg.current)
  const deviceId = window.__yeyboatsDeviceId
  if (deviceId) {
    setInterval(() => {
      fetch('/plugins/yey-boats-display-manager/devices/' + encodeURIComponent(deviceId) + '/views',
        { credentials: 'include' })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => {
          if (!d || !d.current) return
          if (nowEl) nowEl.textContent = titleOf(d.current) // indicator always tracks the device
          if (editMode || userPicked || d.current === currentScreenId) return
          currentScreenId = d.current
          if (sel) {
            if (![...sel.options].some((o) => o.value === currentScreenId)) {
              const o = document.createElement('option'); o.value = currentScreenId; o.textContent = currentScreenId; sel.appendChild(o)
            }
            sel.value = currentScreenId
          }
          renderScreen()
        })
        .catch(() => {})
    }, 5000)
  }
  renderScreen()
  connect()
}())
