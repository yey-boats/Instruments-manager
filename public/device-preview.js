// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
/* Device-page live preview (#14, roadmap S7: one renderer; MIDL-only
 * screens). Every screen — the profile's records and the embedded built-ins
 * alike — is drawn from its stored MIDL record doc (narrowed to that screen by
 * the server, nothing flattened) by the shared MIDL device bundle
 * (public/midl-device.global.js, global `MidlWeb`) — the renderer the
 * firmware serves — bound to LIVE SignalK data and the display's telemetry
 * for `local` bindings.
 * Reads window.__yeyboatsPreview = { screens:[{id,title,record,doc}], current,
 * telemetry, midl:{className,viewport,manifest} }. */
(function () {
  'use strict'

  // --- pure helpers (exposed for tests as window.YeyDevicePreview) ---------
  const STALE_MS = 10000
  // Display unit for a tile in MIDL format tokens. tile.unit (the firmware's
  // symbols) wins; else inferred from the path LEAF like the device does (every
  // route metric lives under navigation.course*, so XTE/DTW must be matched
  // before the angle leaves).
  const UNIT_TOKENS = { '°': 'deg', '°C': 'degC', C: 'degC' }
  function displayUnitFor (tile) {
    if (tile.unit) return UNIT_TOKENS[tile.unit] || tile.unit
    const p = tile.path || ''
    const leaf = (p.split('.').pop() || '')
    if (/crossTrackError/i.test(leaf)) return 'm'
    if (/distance/i.test(leaf)) return 'nm'
    if (/speed|drift|velocityMadeGood/i.test(leaf)) return 'kn'
    if (/angle|heading|bearing|direction|course|cog|track|setTrue/i.test(leaf)) return 'deg'
    if (/depth/i.test(p)) return 'm'
    if (/temperature/i.test(leaf)) return 'degC'
    if (/stateOfCharge|currentLevel|relativeHumidity/i.test(leaf)) return '%'
    if (/voltage/i.test(leaf)) return 'V'
    return ''
  }
  function formatFor (tile) {
    const unit = displayUnitFor(tile)
    const f = { decimals: tile.precision != null ? tile.precision : (unit === 'deg' ? 0 : 1) }
    if (unit) f.unit = unit
    return f
  }
  // SignalK carries SI values; the display unit's family names the SI source
  // (as the old live-preview.js converted). The provider tags every value with
  // it, so the bundle converts correctly: its own path inference reads every
  // navigation.course* path (route DTW, VMG) as an angle (PR #31 review).
  const SI_FOR = { kn: 'm/s', 'km/h': 'm/s', deg: 'rad', degC: 'K', degF: 'K', nm: 'm', km: 'm', ft: 'm', m: 'm', '%': 'ratio', rpm: 'Hz', hPa: 'Pa', kPa: 'Pa', bar: 'Pa' }
  function sourceUnitFor (path) {
    return SI_FOR[displayUnitFor({ path })]
  }
  // MIDL DataProvider over the live SignalK value map. `history` (optional)
  // is the trend backfill, DataProvider.history(path, {window_s, step_s, agg})
  // (public/signalk-history.js: the SignalK History API, same origin).
  function makeProvider (values, stamps, telemetry, history) {
    const none = { value: undefined, stale: false, present: false }
    const p = {
      now () { return Date.now() },
      subscribe () { return function () {} },
      getValue (b) {
        if (!b) return none
        if (b.kind === 'const') return { value: b.value, stale: false, present: true }
        if (b.kind === 'local') {
          const t = telemetry || {}
          const v = typeof b.id === 'string' && Object.prototype.hasOwnProperty.call(t, b.id) ? t[b.id] : undefined
          return v === undefined || v === null ? none : { value: v, stale: false, present: true }
        }
        if (b.kind !== 'signalk' || !Object.prototype.hasOwnProperty.call(values, b.path)) return none
        const at = stamps && stamps[b.path]
        const r = { value: values[b.path], updatedAt: at, present: true, stale: !!at && Date.now() - at > STALE_MS }
        const su = sourceUnitFor(b.path)
        if (su) r.sourceUnit = su
        return r
      }
    }
    if (typeof history === 'function') p.history = history
    return p
  }
  // Whether a stored screen doc has a trend tile (the preview then repaints
  // every second so the chart scrolls even when no value changes).
  function hasTrend (doc) {
    return !!(doc && Array.isArray(doc.screens) && doc.screens.some((s) =>
      s && s.elements && Object.keys(s.elements).some((k) => s.elements[k] && s.elements[k].type === 'trend')))
  }
  // A path's live value as the device would show it on a numeric tile.
  function liveValueFor (values, path, stamps) {
    if (!path) return ''
    const v = values[path]
    if (v === undefined || v === null) return '—'
    const W = typeof window !== 'undefined' && window.MidlWeb
    if (!W || typeof W.resolveElement !== 'function') return typeof v === 'object' ? '—' : String(v)
    const el = { type: 'single-value', format: formatFor({ path }), bindings: { value: { kind: 'signalk', path } } }
    const m = W.resolveElement(el, makeProvider(values, stamps))
    return (m && m.text && m.text !== '--') ? m.text : '—'
  }
  // A delta belongs to this boat when it has no context (SignalK's default is
  // self), says 'vessels.self', or names the self URN from the hello message.
  // Everything else (AIS targets, other vessels) must not reach the preview:
  // their speedOverGround/position would overwrite the boat's own values.
  function isSelfDelta (msg, selfContext) {
    const c = msg && msg.context
    return !c || c === 'vessels.self' || (!!selfContext && c === selfContext)
  }
  window.YeyDevicePreview = { displayUnitFor, sourceUnitFor, formatFor, makeProvider, liveValueFor, isSelfDelta, hasTrend }

  const cfg = window.__yeyboatsPreview || {}
  const root = document.getElementById('lp-root')
  const sel = document.getElementById('lp-screen')
  if (!root) return

  const values = Object.create(null) // signalk path -> latest value
  const stamps = Object.create(null) // signalk path -> ms of last update
  const backfill = window.YeySignalkHistory && window.YeySignalkHistory.history
  const provider = makeProvider(values, stamps, cfg.telemetry || {}, backfill)
  // Trend history for the screen on display only (spec §4: switching screens
  // drops the old series and starts, and backfills, the new ones). One store
  // for the current screen, kept across repaints.
  let trendStore = null
  let trendScreenId = null
  // initialScreen (carried through a redirect) wins over the device's current
  // screen, so a reload keeps the operator's pick.
  let currentScreenId = cfg.initialScreen || cfg.current || (cfg.screens && cfg.screens[0] && cfg.screens[0].id)
  // The theme the display draws with; the device-views poll keeps it current.
  let themeName = typeof cfg.theme === 'string' ? cfg.theme : 'day'

  function screenById (id) {
    const scr = (cfg.screens || []).find((s) => s.id === id)
    return scr || (cfg.screens || [])[0] || null
  }
  function renderScreen () {
    root.replaceChildren()
    const scr = screenById(currentScreenId)
    if (!scr || !scr.doc) {
      trendStore = null
      trendScreenId = null
      const m = document.createElement('div')
      m.className = 'lp-empty'
      m.textContent = scr
        ? 'No preview for this screen: the manager has no copy of its MIDL record (it is built into the firmware).'
        : 'No screens.'
      root.appendChild(m)
      return
    }
    const W = window.MidlWeb
    const midl = cfg.midl || {}
    const stage = document.createElement('div')
    stage.className = 'lp-midl'
    if (!W || typeof W.renderDashboardSvg !== 'function' || !midl.manifest) {
      stage.className = 'lp-empty'
      stage.textContent = 'Preview unavailable: the MIDL renderer (midl-device.global.js) did not load.'
    } else {
      if (!trendStore || trendScreenId !== scr.id) {
        trendStore = new (W.HistoryStore || W.TrendBuffers)()
        trendStore.onUpdate = () => { dirty = true } // a backfill landed
        trendScreenId = scr.id
      }
      const trends = trendStore
      let r
      try {
        r = W.renderDashboardSvg(JSON.stringify(scr.doc), midl.manifest, midl.className,
          midl.viewport || { x: 0, y: 0, w: 480, h: 480 }, provider, { trends, theme: themeName })
      } catch (e) {
        r = { ok: false, issues: [{ message: String((e && e.message) || e) }] }
      }
      // The bundle escapes every string it puts into the SVG.
      if (r && r.svg) stage.innerHTML = r.svg
      else stage.textContent = 'Preview error: ' + ((r && r.issues && r.issues[0] && r.issues[0].message) || 'unknown')
    }
    root.appendChild(stage)
  }

  // throttle re-render to ~5 Hz (matches the device refresh cadence); a
  // screen with a trend also repaints once a second so its chart scrolls one
  // bucket per step even when the value is steady.
  let dirty = false
  let lastPaint = 0
  setInterval(() => {
    const now = Date.now()
    if (!dirty && now - lastPaint >= 1000) {
      const scr = screenById(currentScreenId)
      if (scr && hasTrend(scr.doc)) dirty = true
    }
    if (dirty) {
      dirty = false
      lastPaint = now
      renderScreen()
    }
  }, 200)

  // --- live SignalK stream (same-origin; uses the logged-in session) -------
  function connect () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let ws
    // subscribe=self: the device shows this boat only, so the preview must too.
    let selfContext = null
    try { ws = new WebSocket(proto + '//' + location.host + '/signalk/v1/stream?subscribe=self') } catch (e) { return }
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch (_) { return }
      if (msg && typeof msg.self === 'string') selfContext = msg.self.startsWith('vessels.') ? msg.self : 'vessels.' + msg.self
      if (!msg.updates || !isSelfDelta(msg, selfContext)) return
      msg.updates.forEach((u) => (u.values || []).forEach((val) => {
        if (val && typeof val.path === 'string') {
          values[val.path] = val.value
          stamps[val.path] = Date.now()
        }
      }))
      dirty = true
    }
    ws.onclose = () => setTimeout(connect, 3000)
    ws.onerror = () => { try { ws.close() } catch (_) {} }
  }

  let userPicked = !!cfg.initialScreen
  if (sel) {
    sel.addEventListener('change', () => { userPicked = true; currentScreenId = sel.value; renderScreen() })
  }
  const nowEl = document.getElementById('lp-now-screen')
  function titleOf (idv) {
    const s = (cfg.screens || []).find((x) => x.id === idv)
    return (s && s.title) || idv || '—'
  }
  // "Show on device": screen.set with the bare MIDL screen id (AJAX, so the
  // selected preview screen stays put).
  const form = document.getElementById('lp-form')
  if (form) {
    document.querySelectorAll('#lp-form button[data-mode="switch"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        userPicked = true
        const fd = new URLSearchParams()
        fd.set('mode', 'switch')
        fd.set('screenId', currentScreenId || '')
        fd.set('ajax', '1')
        fetch(form.getAttribute('action'), {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: fd.toString()
        })
          .then((r) => r.ok ? r.json() : null)
          .then((d) => { if (d && d.screenId && nowEl) nowEl.textContent = titleOf(d.screenId) })
          .catch(() => {})
      })
    })
  }
  // Keep the preview's current screen synced with what the device is actually
  // showing: poll the device-views projection.
  if (nowEl) nowEl.textContent = titleOf(cfg.current)
  const deviceId = window.__yeyboatsDeviceId
  if (deviceId) {
    setInterval(() => {
      fetch('/plugins/yey-boats-display-manager/devices/' + encodeURIComponent(deviceId) + '/views',
        { credentials: 'include' })
        .then((r) => r.ok ? r.json() : null)
        .then((d) => {
          if (!d) return
          // A day/night switch (or a theme.set) shows without a reload.
          if (typeof d.theme === 'string' && d.theme !== themeName) { themeName = d.theme; dirty = true }
          if (!d.current) return
          if (nowEl) nowEl.textContent = titleOf(d.current)
          if (userPicked || d.current === currentScreenId) return
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
