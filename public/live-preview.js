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
  // stable tile-edit key -> { path, screenId, tileIndex, widgetId, widget, ... }
  const editsMap = Object.create(null)
  let editMode = false

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
    grid.className = 'lp-grid'
    scr.tiles.forEach((tile, tileIndex) => {
      const cell = document.createElement('div')
      cell.className = 'lp-tile lp-w-' + (tile.widget || 'numeric')
      const cap = document.createElement('div')
      cap.className = 'lp-cap'
      cap.textContent = (tile.title || (tile.path || '').split('.').pop() || '').toUpperCase()
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
        bar.appendChild(fill); cell.appendChild(bar)
        const val = document.createElement('div'); val.className = 'lp-val lp-val-sm'
        const u = unitFor(tile)
        val.textContent = valueFor(tile) + (u ? ' ' + u : '')
        cell.appendChild(val)
      } else if (tile.widget === 'text' || isPos) {
        // Position / text tile: format lat-lon as DMS (two lines), like device.
        const pos = Hud && Hud.accessor(values).position()
        const val = document.createElement('div'); val.className = 'lp-val lp-val-pos'
        if (pos) {
          const [la, lo] = Hud.dms(pos)
          val.textContent = la + '\n' + lo
        } else {
          val.textContent = valueFor(tile)
        }
        cell.appendChild(val)
      } else {
        const val = document.createElement('div'); val.className = 'lp-val'
        val.textContent = valueFor(tile)
        const unit = document.createElement('span'); unit.className = 'lp-unit'
        unit.textContent = unitFor(tile)
        val.appendChild(unit); cell.appendChild(val)
      }
      if (editMode) {
        // EVERY tile gets a path-binding field in edit mode — authored tiles
        // (with a real widgetId) rebind in place; preset/managed tiles with no
        // widgetId get a synthetic, stable key (screenId + tile index) so the
        // server can materialize the binding into the authored layout.
        const editKey = (tile.widgetId && tile.editable)
          ? ('w:' + tile.widgetId)
          : ('t:' + scr.id + ':' + tileIndex)
        const inp = document.createElement('input')
        inp.className = 'lp-edit-path'
        inp.value = tile.path || ''
        inp.setAttribute('list', 'lp-paths')
        inp.placeholder = 'signalk path'
        // 'change' (blur/enter) so the throttled re-render never steals focus
        // mid-keystroke; rebinding updates the tile's path so format() reads
        // the new path's live value immediately.
        inp.addEventListener('change', () => {
          tile.path = inp.value.trim()
          editsMap[editKey] = {
            widgetId: (tile.widgetId && tile.editable) ? tile.widgetId : null,
            screenId: scr.id,
            tileIndex: tileIndex,
            widget: tile.widget || 'numeric',
            title: tile.title || '',
            unit: tile.unit || '',
            precision: tile.precision != null ? tile.precision : null,
            path: tile.path
          }
          dirty = true
        })
        cell.appendChild(inp)
      }
      grid.appendChild(cell)
    })
    root.appendChild(grid)
  }

  // throttle re-render to ~5 Hz (matches the device refresh cadence)
  let dirty = false
  setInterval(() => {
    // don't re-render (which rebuilds the DOM) while a path input is focused
    const ae = document.activeElement
    if (dirty && !(ae && ae.classList && ae.classList.contains('lp-edit-path'))) {
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
