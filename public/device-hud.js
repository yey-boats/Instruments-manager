/* Faithful in-browser renderers for the device's BUILT-IN screens, bound to
 * live SignalK values. These mirror the firmware's actual rendering
 * (src/ui/screen_autopilot.cpp, screen_wind.cpp, screen_wind_steer.cpp and the
 * grid screens) so the manager's live view matches what's on the panel.
 *
 * Everything is drawn into a 480x480 viewBox SVG (the sunton-480 reference
 * geometry) and scaled to fit the stage; larger panels keep the same layout.
 *
 * Exposes window.DeviceHud:
 *   - accessor(values)  -> typed live-value getter (deg/kn/raw + formatters)
 *   - fullscreen(id, a) -> SVG string for a fullscreen screen, or null
 *   - gridTile(tile, a) -> { svg } | { value, unit } for one grid tile
 */
(function () {
  'use strict'

  const PATHS = {
    heading: 'navigation.headingTrue',
    cog: 'navigation.courseOverGroundTrue',
    sog: 'navigation.speedOverGround',
    stw: 'navigation.speedThroughWater',
    awa: 'environment.wind.angleApparent',
    aws: 'environment.wind.speedApparent',
    twa: 'environment.wind.angleTrueWater',
    tws: 'environment.wind.speedTrue',
    twd: 'environment.wind.directionTrue',
    beatAngle: 'performance.beatAngle',
    gybeAngle: 'performance.gybeAngle',
    xte: 'navigation.courseRhumbline.crossTrackError',
    vmg: 'navigation.courseRhumbline.velocityMadeGood',
    btw: 'navigation.courseRhumbline.nextPoint.bearingTrue',
    dtw: 'navigation.courseRhumbline.nextPoint.distance',
    cts: 'navigation.courseRhumbline.bearingTrackTrue',
    apTarget: 'steering.autopilot.target.headingTrue',
    apState: 'steering.autopilot.state',
    position: 'navigation.position',
    depth: 'environment.depth.belowTransducer',
    depthKeel: 'environment.depth.belowKeel',
    waterTemp: 'environment.water.temperature',
    currentSet: 'environment.current.setTrue',
    currentDrift: 'environment.current.drift',
    battV: 'electrical.batteries.house.voltage',
    battSoc: 'electrical.batteries.house.stateOfCharge',
    fuel: 'tanks.fuel.0.currentLevel',
    freshwater: 'tanks.freshWater.0.currentLevel'
  }

  const RAD2DEG = 180 / Math.PI
  const MPS2KN = 1.94384
  function norm360 (d) { return ((d % 360) + 360) % 360 }

  // accessor(values): live-value getter. `values` is path -> raw SignalK value.
  function accessor (values) {
    const raw = (name) => {
      const p = PATHS[name]
      const v = p ? values[p] : values[name]
      return v
    }
    const num = (name) => { const v = raw(name); return (typeof v === 'number' && isFinite(v)) ? v : NaN }
    const deg = (name) => { const v = num(name); return isNaN(v) ? NaN : norm360(v * RAD2DEG) }
    const kn = (name) => { const v = num(name); return isNaN(v) ? NaN : v * MPS2KN }
    return {
      raw, num, deg, kn,
      has (name) { return !isNaN(num(name)) },
      // angle off the bow as magnitude + side (e.g. 42 -> {mag:42, side:'S'})
      side (name) {
        const v = num(name); if (isNaN(v)) return null
        let d = v * RAD2DEG
        // -180..180 (P negative / S positive) is the device convention
        d = ((d + 540) % 360) - 180
        return { mag: Math.round(Math.abs(d)), side: d >= 0 ? 'S' : 'P' }
      },
      position () {
        const v = raw('position')
        if (v && typeof v.latitude === 'number' && typeof v.longitude === 'number') return v
        return null
      }
    }
  }

  // --- formatting -----------------------------------------------------------
  function dms (pos) {
    if (!pos) return ['--', '--']
    const fmt = (val, pos, neg) => {
      const hemi = val >= 0 ? pos : neg
      const a = Math.abs(val)
      const d = Math.floor(a)
      const m = (a - d) * 60
      return d + '°' + m.toFixed(3) + "'" + hemi
    }
    return [fmt(pos.latitude, 'N', 'S'), fmt(pos.longitude, 'E', 'W')]
  }
  function fixed (v, p) { return isNaN(v) ? '--' : v.toFixed(p) }
  function sideStr (s) { return s ? (s.mag + s.side) : '--' }
  // Coerce an arbitrary value to a finite number, NaN otherwise (used for the
  // device-telemetry trip accumulators which may be absent or non-numeric).
  function num (v) { return (typeof v === 'number' && isFinite(v)) ? v : NaN }

  // --- shared svg helpers ---------------------------------------------------
  // Escape any value interpolated into the SVG string. The HUD numerics are
  // computed from numbers, but the System panel embeds DEVICE-reported strings
  // (ssid/hostname/ip/build/sk-state) — a hostile device must not be able to
  // break out of a <text> node and inject markup into the operator's page.
  function esc (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
  function svgWrap (inner) {
    return `<svg viewBox="0 0 480 480" preserveAspectRatio="xMidYMid meet" class="hud-svg">${inner}</svg>`
  }

  // ====================================================================== //
  //  Fullscreen: AUTOPILOT HUD  (screen_autopilot.cpp)                      //
  // ====================================================================== //
  function autopilotHud (a) {
    const CX = 240, CYc = 272, R = 214, RB = 200
    const hdg = a.has('heading') ? a.deg('heading') : 0
    const target = a.deg('apTarget')
    // apState is the only externally-sourced string drawn here; hard-limit it
    // to a short alphanumeric token so it can never inject markup into the SVG.
    const hasState = a.has('apState')
    const state = String(a.raw('apState') || 'standby').replace(/[^a-z0-9 _-]/gi, '').slice(0, 12)
    const engaged = /auto|track|wind|route|nav/i.test(state)
    // Mirror the device: left chip ON/STBY by engagement; center badge is the
    // live state (green engaged / dim disengaged), OFFLINE when no AP data.
    const chip = engaged ? 'ON' : 'STBY'
    const badge = hasState ? String(state).toUpperCase() : 'OFFLINE'
    const polar = (deg, r) => { const t = (deg - 90) * Math.PI / 180; return [CX + r * Math.cos(t), CYc + r * Math.sin(t)] }
    const ticks = []
    for (let d = -90; d <= 90; d += 15) {
      const major = ((((Math.round(d + hdg) % 30) + 30) % 30)) === 0
      const [x1, y1] = polar(d, RB + 12); const [x2, y2] = polar(d, RB + 12 - (major ? 12 : 7))
      ticks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#16222f" stroke-width="${major ? 3 : 2}"/>`)
    }
    const nums = []
    for (const dd of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
      const rel = ((dd - hdg + 540) % 360) - 180
      if (rel < -96 || rel > 96) continue
      const [x, y] = polar(rel, RB - 14)
      const card = (dd % 90) === 0
      const txt = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd)
      const f = card ? 20 : 16
      nums.push(`<text x="${x}" y="${y + f * 0.34}" font-family="Montserrat" font-weight="700" font-size="${f}" fill="${card ? '#ff5252' : '#16222f'}" text-anchor="middle">${txt}</text>`)
    }
    const railPath = `M ${polar(-90, R + 8).join(' ')} A ${R + 8} ${R + 8} 0 0 1 ${polar(90, R + 8).join(' ')}`
    const bandPath = `M ${polar(-90, RB).join(' ')} A ${RB} ${RB} 0 0 1 ${polar(90, RB).join(' ')}`
    let bug = ''
    if (!isNaN(target)) {
      const rel = ((target - hdg + 540) % 360) - 180
      if (rel >= -90 && rel <= 90) {
        const [bx, by] = polar(rel, R + 6)
        bug = `<path d="M ${bx - 8},${by - 8} L ${bx + 8},${by - 8} L ${bx},${by + 8} Z" fill="#ffb84d"/>`
      }
    }
    const cog = a.deg('cog'); const sog = a.kn('sog')
    const sub = `COG ${isNaN(cog) ? '---' : String(Math.round(cog)).padStart(3, '0')}°  |  SOG ${fixed(sog, 1)} kn`
    const xte = a.num('xte')
    let needle = ''
    if (!isNaN(xte)) {
      let nm = xte / 1852; nm = Math.max(-1, Math.min(1, nm))
      needle = `<rect x="${240 + nm * 200 - 1.5}" y="302" width="3" height="32" rx="1" fill="#ff5252"/>`
    }
    const tiles = gridRow([
      ['DEPTH', 'm', fixed(a.num('depth'), 1), '#eef4fa'],
      ['SPEED', 'kn', fixed(a.kn('sog'), 1), '#eef4fa'],
      ['AWS', 'kn', fixed(a.kn('aws'), 1), '#ffb84d'],
      ['AWA', '', sideStr(a.side('awa')), '#eef4fa']
    ])
    return svgWrap(`
      <rect x="10" y="10" width="110" height="40" rx="10" fill="#101b29" stroke="#1f2d3d"/>
      <text x="65" y="37" font-family="Montserrat" font-size="20" fill="${engaged ? '#36d399' : '#eef4fa'}" text-anchor="middle">${chip}</text>
      <text x="240" y="32" font-family="Montserrat" font-size="20" font-weight="700" fill="${engaged ? '#36d399' : '#5a6b78'}" text-anchor="middle">${esc(badge)}</text>
      <rect x="360" y="10" width="110" height="40" rx="10" fill="#101b29" stroke="#1f2d3d"/>
      <text x="415" y="37" font-family="Montserrat" font-size="20" fill="#eef4fa" text-anchor="middle">HOME</text>
      <path d="${railPath}" fill="none" stroke="#36d399" stroke-width="10"/>
      <path d="${bandPath}" fill="none" stroke="#f2f6fb" stroke-width="44"/>
      ${ticks.join('')}${nums.join('')}
      <path d="M ${CX - 9},${CYc - R - 2} L ${CX + 9},${CYc - R - 2} L ${CX},${CYc - R + 14} Z" fill="#ff5252"/>
      ${bug}
      <text x="${CX}" y="${CYc - R / 2 - 12}" font-family="Montserrat" font-size="20" fill="#8fa7bd" text-anchor="middle">HDG</text>
      <text x="${CX}" y="${CYc - R / 2 + 38}" font-family="Montserrat" font-size="64" font-weight="700" fill="#eef4fa" text-anchor="middle">${fixed(hdg, 1)}°</text>
      <text x="${CX}" y="${CYc - 2}" font-family="Montserrat" font-size="20" fill="#8fa7bd" text-anchor="middle">${sub}</text>
      <text x="16" y="306" font-family="Montserrat" font-size="14" fill="#8fa7bd">PORT</text>
      <text x="464" y="306" font-family="Montserrat" font-size="14" fill="#8fa7bd" text-anchor="end">STBD</text>
      <line x1="40" y1="318" x2="440" y2="318" stroke="#2a3a4c" stroke-width="2"/>
      ${needle}${tiles}`)
  }

  // ====================================================================== //
  //  Fullscreen: WIND DIAL  (screen_wind.cpp)                              //
  // ====================================================================== //
  function windDial (a) {
    const CX = 240, CY = 174, RB = 158, RW = 145, RM = 140, RF = 130
    const hdg = a.has('heading') ? a.deg('heading') : 0
    const awa = a.deg('awa'); const twa = a.deg('twa')
    const polar = (deg, r) => { const t = (deg - 90) * Math.PI / 180; return [CX + r * Math.cos(t), CY + r * Math.sin(t)] }
    const ticks = []
    for (let d = 22.5; d < 360; d += 45) {
      const [x1, y1] = polar(d - hdg, RB - 4); const [x2, y2] = polar(d - hdg, RB - 13)
      ticks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#5a6b78" stroke-width="2"/>`)
    }
    const cards = []
    for (const [lab, b, big] of [['N', 0, 1], ['NE', 45, 0], ['E', 90, 1], ['SE', 135, 0], ['S', 180, 1], ['SW', 225, 0], ['W', 270, 1], ['NW', 315, 0]]) {
      const [x, y] = polar(b - hdg, RW); const f = big ? 20 : 14
      const col = lab === 'N' ? '#ff5252' : (big ? '#16222f' : '#44546a')
      cards.push(`<text x="${x}" y="${y + f * 0.34}" font-family="Montserrat" font-weight="700" font-size="${f}" fill="${col}" text-anchor="middle">${lab}</text>`)
    }
    const wm = (deg, color, letter) => {
      if (isNaN(deg)) return ''
      const [ox, oy] = polar(deg, RM); const [ix, iy] = polar(deg, RM - 30); const [lx, ly] = polar(deg, RM - 46)
      return `<line x1="${ox}" y1="${oy}" x2="${ix}" y2="${iy}" stroke="${color}" stroke-width="6" stroke-linecap="round"/>`
        + `<circle cx="${ox}" cy="${oy}" r="7" fill="${color}"/>`
        + `<text x="${lx}" y="${ly + 6}" font-family="Montserrat" font-size="18" font-weight="700" fill="${color}" text-anchor="middle">${letter}</text>`
    }
    const tiles = gridRow([
      ['AWS', 'kn', fixed(a.kn('aws'), 1), '#ffb84d'],
      ['AWA', '', sideStr(a.side('awa')), '#eef4fa'],
      ['TWS', 'kn', fixed(a.kn('tws'), 1), '#eef4fa'],
      ['TWA', '', sideStr(a.side('twa')), '#eef4fa']
    ], 356, 116)
    return svgWrap(`
      <circle cx="${CX}" cy="${CY}" r="${RF}" fill="#101b29" stroke="#1f2d3d"/>
      <circle cx="${CX}" cy="${CY}" r="${RB}" fill="none" stroke="#f2f6fb" stroke-width="26" stroke-opacity="0.92"/>
      <circle cx="${CX}" cy="${CY}" r="${RB + 9}" fill="none" stroke="#36d399" stroke-width="6" stroke-opacity="0.85"/>
      ${ticks.join('')}${cards.join('')}
      <path d="M ${CX - 8},${CY - RB - 12} L ${CX + 8},${CY - RB - 12} L ${CX},${CY - RB + 2} Z" fill="#ff5252"/>
      <path d="M ${polar(-30, RF - 8).join(' ')} A ${RF - 8} ${RF - 8} 0 0 1 ${polar(0, RF - 8).join(' ')}" fill="none" stroke="#ff5252" stroke-width="6" opacity="0.7"/>
      <path d="M ${polar(0, RF - 8).join(' ')} A ${RF - 8} ${RF - 8} 0 0 1 ${polar(30, RF - 8).join(' ')}" fill="none" stroke="#36d399" stroke-width="6" opacity="0.7"/>
      <path d="M ${CX - 17},${CY + 34} L ${CX - 17},${CY - 3} L ${CX},${CY - 48} L ${CX + 17},${CY - 3} L ${CX + 17},${CY + 34}" fill="none" stroke="#eef4fa" stroke-opacity="0.3" stroke-width="3" stroke-linejoin="round"/>
      ${wm(twa, '#2bd4e8', 'T')}${wm(awa, '#ff8800', 'A')}
      <text x="${CX}" y="${CY - RF + 30}" font-family="Montserrat" font-size="14" fill="#8fa7bd" text-anchor="middle">HDG</text>
      <text x="${CX}" y="${CY - RF + 52}" font-family="Montserrat" font-size="22" font-weight="700" fill="#4fc3f7" text-anchor="middle">${isNaN(hdg) ? '---' : String(Math.round(hdg)).padStart(3, '0')}°</text>
      ${tiles}`)
  }

  // ====================================================================== //
  //  Fullscreen: WIND CLASSIC  (screen_wind_classic.cpp)                    //
  // ====================================================================== //
  // The CLASSICAL marine wind rose: a full-screen circular dial centred on the
  // panel (NOT the top-half dial of windDial). Distinct from windDial:
  //   - thick rim bezel (rim ring + outer shadow + inner highlight) that
  //     rotates heading-up, with 8 inward tick marks at the inter-cardinals
  //   - an UPRIGHT cardinal overlay (N/NE/E/... laid out at bearing-heading so
  //     the labels stay horizontal while the dial rotates)
  //   - a 30/60/90/120/150 wind-angle-off-bow numeric scale on BOTH sides
  //   - red/green close-hauled arcs at ~30° each side of the bow
  //   - a stylised boat-hull polyline + centreline down the middle
  //   - AWS (amber) + TWS (white) HERO readouts flanking the hull, each with a
  //     port/starboard wind-angle sub-line; HDG hero above the bow; a centred
  //     blue tide/current arrow (rotates to set-heading) with its drift text
  //   - A (amber) / T (white) wind index triangles orbiting the rim at AWA/TWA
  //   - SOG (green) + SOW (cyan) glass boxes in the bottom screen corners
  // Mirrors src/ui/screen_wind_classic.cpp geometry on the 480 viewBox.
  function windClassic (a) {
    const CX = 240, CY = 240
    const R_BEZEL = 218, R_FACE = R_BEZEL - 28, R_CLOSE = R_BEZEL - 43
    const R_MARKER = R_BEZEL - 18, R_CARD = R_BEZEL - 22, R_SCALE = R_FACE - 26
    const hdg = a.has('heading') ? a.deg('heading') : NaN
    const href = isNaN(hdg) ? 0 : hdg // marker reference (north-up when no hdg)
    const awa = a.deg('awa'); const twa = a.deg('twa')
    // bearing measured clockwise from bow/north (up); 0 = up (12 o'clock).
    const polar = (deg, r) => { const t = (deg - 90) * Math.PI / 180; return [CX + r * Math.cos(t), CY + r * Math.sin(t)] }

    // --- rim bezel (rotates -heading, heading-up) + inter-cardinal ticks ----
    const ticks = []
    for (let deg = 0; deg < 360; deg += 45) {
      const [x1, y1] = polar(deg + 22.5, R_BEZEL - 4)
      const [x2, y2] = polar(deg + 22.5, R_BEZEL - 14)
      ticks.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#5a6b78" stroke-width="2"/>`)
    }
    const bezel = `<g transform="rotate(${(-href).toFixed(1)} ${CX} ${CY})">
      <circle cx="${CX}" cy="${CY}" r="${R_BEZEL}" fill="none" stroke="#26384a" stroke-width="6"/>
      <circle cx="${CX}" cy="${CY}" r="${R_BEZEL + 5}" fill="none" stroke="#111a26" stroke-width="2"/>
      <circle cx="${CX}" cy="${CY}" r="${R_BEZEL - 7}" fill="none" stroke="#0c1828" stroke-width="1"/>
      ${ticks.join('')}
    </g>`

    // --- upright cardinal overlay (laid out at bearing - heading) -----------
    const CARD = [['N', 0, 1], ['NE', 45, 0], ['E', 90, 1], ['SE', 135, 0], ['S', 180, 1], ['SW', 225, 0], ['W', 270, 1], ['NW', 315, 0]]
    const cards = CARD.map(([lab, b, big]) => {
      const [x, y] = polar(b - href, R_CARD)
      const f = big ? 20 : 14
      return `<text x="${x.toFixed(1)}" y="${(y + f * 0.34).toFixed(1)}" font-family="Montserrat" font-weight="700" font-size="${f}" fill="${big ? '#eef4fa' : '#5a6b78'}" text-anchor="middle">${lab}</text>`
    }).join('')

    // --- wind-angle-off-bow numeric scale, both sides (bow-relative) --------
    const scale = []
    for (const ang of [30, 60, 90, 120, 150]) {
      for (const s of [-1, 1]) {
        const [x, y] = polar(s * ang, R_SCALE)
        scale.push(`<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" font-family="Montserrat" font-size="14" fill="#5a6b78" text-anchor="middle">${ang}</text>`)
      }
    }

    // --- close-hauled arcs (±30° of bow) ------------------------------------
    const arc = (t0, t1, r) => { const [x0, y0] = polar(t0, r); const [x1, y1] = polar(t1, r); return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}` }
    const closeHauled =
      `<path d="${arc(-30, 0, R_CLOSE)}" fill="none" stroke="#ff5252" stroke-width="6" opacity="0.7"/>` +
      `<path d="${arc(0, 30, R_CLOSE)}" fill="none" stroke="#36d399" stroke-width="6" opacity="0.7"/>`

    // --- stylised boat hull + centreline ------------------------------------
    const hull = `M ${CX - 28},${CY + 63} L ${CX - 28},${CY - 7} L ${CX - 22},${CY - 42} L ${CX},${CY - 92} L ${CX + 22},${CY - 42} L ${CX + 28},${CY - 7} L ${CX + 28},${CY + 63}`
    const boat =
      `<line x1="${CX}" y1="${CY - R_FACE / 2}" x2="${CX}" y2="${CY + R_FACE / 2}" stroke="#eef4fa" stroke-opacity="0.2" stroke-width="1"/>` +
      `<path d="${hull}" fill="none" stroke="#eef4fa" stroke-opacity="0.3" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`

    // --- tide / current arrow at centre (rotates set - heading) -------------
    const cset = a.deg('currentSet'); const cdrift = a.kn('currentDrift')
    let tide = ''
    if (!isNaN(cset) && !isNaN(cdrift) && !isNaN(hdg) && cdrift > 0.05 * MPS2KN) {
      const rel = norm360(cset - hdg)
      // The arrow is drawn pointing up (toward the bow at 12 o'clock) inside a
      // <g> rotated by (set - heading), so it ends up pointing toward the set.
      tide = `<g transform="rotate(${rel.toFixed(1)} ${CX} ${CY})">
        <line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - 54}" stroke="#288cff" stroke-width="5" stroke-linecap="round"/>
        <path d="M ${CX - 10},${CY - 46} L ${CX + 10},${CY - 46} L ${CX},${CY - 64} Z" fill="#288cff"/>
      </g>
      <text x="${CX - 22}" y="${CY + 4}" font-family="Montserrat" font-size="18" fill="#eef4fa">${fixed(cdrift, 1)}</text>`
    } else if (!isNaN(cset) && !isNaN(cdrift) && !isNaN(hdg)) {
      tide = `<circle cx="${CX}" cy="${CY}" r="13" fill="none" stroke="#288cff" stroke-width="3"/>`
    }

    // --- A / T wind index triangles orbiting the rim (point inward) ---------
    const windMark = (deg, color, letter) => {
      if (isNaN(deg)) return ''
      return `<g transform="rotate(${deg.toFixed(1)} ${CX} ${CY})">
        <path d="M ${CX - 11},${CY - R_MARKER} L ${CX + 11},${CY - R_MARKER} L ${CX},${CY - R_MARKER + 20} Z" fill="${color}"/>
        <text x="${CX}" y="${CY - R_MARKER + 40}" font-family="Montserrat" font-size="20" font-weight="700" fill="${color}" text-anchor="middle" transform="rotate(${(-deg).toFixed(1)} ${CX} ${CY - R_MARKER + 34})">${letter}</text>
      </g>`
    }
    const markers = windMark(twa, '#eef4fa', 'T') + windMark(awa, '#f6a21a', 'A')

    // --- hero readouts inside the face --------------------------------------
    const awsSide = a.side('awa'); const twsSide = a.side('twa')
    const hero = (cap, val, sub, dx, dy, vcol) =>
      `<text x="${CX + dx}" y="${CY + dy - 40}" font-family="Montserrat" font-size="20" fill="#8fa7bd" text-anchor="middle">${cap}</text>` +
      `<text x="${CX + dx}" y="${CY + dy + 16}" font-family="Montserrat" font-size="48" font-weight="700" fill="${vcol}" text-anchor="middle">${val}</text>` +
      (sub != null ? `<text x="${CX + dx}" y="${CY + dy + 56}" font-family="Montserrat" font-size="20" fill="#8fa7bd" text-anchor="middle">${sub}</text>` : '')
    const hdgTxt = isNaN(hdg) ? '--°' : String(Math.round(hdg)).padStart(3, '0') + '°'
    const heroes =
      hero('HDG', hdgTxt, null, 0, -96, '#4fc3f7') +
      hero('AWS', fixed(a.kn('aws'), 1), sideStr(awsSide), -96, 0, '#f6a21a') +
      hero('TWS', fixed(a.kn('tws'), 1), sideStr(twsSide), 96, 0, '#eef4fa')

    // --- SOG / SOW glass corner boxes (outside the ring) --------------------
    const cornerBox = (label, val, x, vcol) =>
      `<rect x="${x}" y="404" width="104" height="68" rx="8" fill="#101b29" stroke="#1f2d3d"/>` +
      `<text x="${x + 8}" y="424" font-family="Montserrat" font-size="14" fill="#8fa7bd">${label}</text>` +
      `<text x="${x + 96}" y="424" font-family="Montserrat" font-size="14" fill="#8fa7bd" text-anchor="end">kn</text>` +
      `<text x="${x + 52}" y="464" font-family="Montserrat" font-size="38" font-weight="700" fill="${vcol}" text-anchor="middle">${val}</text>`
    const corners = cornerBox('SOG', fixed(a.kn('sog'), 1), 8, '#36d399') +
      cornerBox('SOW', fixed(a.kn('stw'), 1), 368, '#4fc3f7')

    return svgWrap(`
      <circle cx="${CX}" cy="${CY}" r="${R_FACE}" fill="#101b29" stroke="#1f2d3d" stroke-opacity="0.6"/>
      ${closeHauled}
      ${scale.join('')}
      ${boat}
      ${tide}
      ${markers}
      ${bezel}
      ${cards}
      <path d="M ${CX - 4},${CY - R_BEZEL - 14} h 8 v 12 h -8 Z" fill="#eef4fa" fill-opacity="0.9"/>
      ${heroes}
      ${corners}`)
  }

  // ====================================================================== //
  //  Fullscreen: TRIP ODOMETER  (screen_trip.cpp)                           //
  // ====================================================================== //
  // The device Trip screen is a bespoke odometer, NOT a metric grid: a big
  // DISTANCE hero spanning the top, then TIME UNDERWAY / AVG SPEED / MAX SPEED
  // stat cards, then a live SOG strip. Distance / time / avg / max are device-
  // side NVS-integrated accumulators (the firmware integrates SOG locally and
  // persists across reboots); they are NOT in the SignalK stream, so we source
  // them from the device telemetry (`t`) when present, else show "--". The NOW
  // SOG reads live from SignalK.
  function tripHud (a, t) {
    t = t || {}
    const fmtDist = (nm) => isNaN(nm) ? '--' : (nm >= 10 ? nm.toFixed(1) : nm.toFixed(2))
    const fmtTime = (s) => {
      if (s == null || isNaN(s)) return '--'
      const hh = Math.floor(s / 3600); const mm = Math.floor(s / 60) % 60; const ss = Math.floor(s % 60)
      return hh + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
    }
    // Device telemetry odometer fields (absent today -> "--"). distM in metres,
    // underwayS in seconds, avg/max in m/s; tolerate a few likely key spellings.
    const trip = t.trip || {}
    const distM = num(trip.distM != null ? trip.distM : trip.distance_m)
    const distNm = isNaN(distM) ? num(trip.distNm) : distM / 1852
    const underwayS = num(trip.underwayS != null ? trip.underwayS : trip.underway_s)
    const avgMps = num(trip.avgMps != null ? trip.avgMps : trip.avg_mps)
    const maxMps = num(trip.maxMps != null ? trip.maxMps : trip.max_mps)
    const avgKn = isNaN(avgMps) ? num(trip.avgKn) : avgMps * MPS2KN
    const maxKn = isNaN(maxMps) ? num(trip.maxKn) : maxMps * MPS2KN
    const sogKn = a.kn('sog')

    const statCard = (cap, val, x, w, vcol) =>
      `<rect x="${x}" y="248" width="${w}" height="100" rx="8" fill="#101b29" stroke="#1f2d3d"/>` +
      `<text x="${x + 12}" y="274" font-family="Montserrat" font-size="14" fill="#8fa7bd">${cap}</text>` +
      `<text x="${x + 12}" y="330" font-family="Montserrat" font-size="28" font-weight="700" fill="${vcol}" text-anchor="start">${val}</text>`
    const colW = (480 - 32) / 3
    return svgWrap(`
      <text x="240" y="28" font-family="Montserrat" font-size="20" font-weight="700" fill="#4fc3f7" text-anchor="middle">TRIP</text>
      <rect x="8" y="40" width="464" height="200" rx="8" fill="#101b29" stroke="#1f2d3d"/>
      <text x="20" y="66" font-family="Montserrat" font-size="14" fill="#8fa7bd">DISTANCE</text>
      <text x="210" y="158" font-family="Montserrat" font-size="64" font-weight="700" fill="#eef4fa" text-anchor="end">${fmtDist(distNm)}</text>
      <text x="452" y="158" font-family="Montserrat" font-size="28" fill="#8fa7bd" text-anchor="end">nm</text>
      ${statCard('TIME UNDERWAY', fmtTime(underwayS), 8, colW, '#eef4fa')}
      ${statCard('AVG SPEED', isNaN(avgKn) ? '-.-- kn' : avgKn.toFixed(1) + ' kn', 8 + colW + 8, colW, '#eef4fa')}
      ${statCard('MAX SPEED', isNaN(maxKn) ? '-.-- kn' : maxKn.toFixed(1) + ' kn', 8 + (colW + 8) * 2, colW - 8, '#36d399')}
      <rect x="8" y="356" width="464" height="60" rx="8" fill="#101b29" stroke="#1f2d3d"/>
      <text x="24" y="392" font-family="Montserrat" font-size="14" fill="#8fa7bd">NOW</text>
      <text x="240" y="396" font-family="Montserrat" font-size="28" font-weight="700" fill="#4fc3f7" text-anchor="middle">${isNaN(sogKn) ? '-.- kn' : sogKn.toFixed(1) + ' kn'}</text>
      <text x="240" y="448" font-family="Montserrat" font-size="14" fill="#5a6b78" text-anchor="middle">console: trip-reset</text>`)
  }

  // ====================================================================== //
  //  Fullscreen: WIND STEER  (screen_wind_steer.cpp)                       //
  // ====================================================================== //
  function windSteer (a) {
    const CX = 240, CYc = 272, R = 214, RB = 200
    const hdg = a.has('heading') ? a.deg('heading') : 0
    const twd = a.deg('twd'); const tws = a.kn('tws')
    const twaSide = a.side('twa')
    const up = twaSide ? twaSide.mag <= 90 : true
    const beat = a.has('beatAngle') ? a.deg('beatAngle') : 42
    const gybe = a.has('gybeAngle') ? a.deg('gybeAngle') : 150
    const opt = up ? beat : gybe
    let tol = isNaN(tws) ? 10 : 16 - 0.6 * tws; tol = Math.max(4, Math.min(16, tol))
    const polar = (deg, r) => { const t = (deg - 90) * Math.PI / 180; return [CX + r * Math.cos(t), CYc + r * Math.sin(t)] }
    const arc = (t0, t1, r) => {
      const [x0, y0] = polar(t0, r); const [x1, y1] = polar(t1, r)
      return `M ${x0} ${y0} A ${r} ${r} 0 ${(t1 - t0) > 180 ? 1 : 0} 1 ${x1} ${y1}`
    }
    const ticks = []
    for (let d = -90; d <= 90; d += 15) {
      const major = ((((Math.round(d + hdg) % 30) + 30) % 30)) === 0
      const [x1, y1] = polar(d, RB + 12); const [x2, y2] = polar(d, RB + 12 - (major ? 12 : 7))
      ticks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#16222f" stroke-width="${major ? 3 : 2}"/>`)
    }
    const nums = []
    for (const dd of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
      const rel = ((dd - hdg + 540) % 360) - 180
      if (rel < -96 || rel > 96) continue
      const [x, y] = polar(rel, RB - 14); const card = (dd % 90) === 0
      const txt = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd)
      const f = card ? 20 : 16
      nums.push(`<text x="${x}" y="${y + f * 0.34}" font-family="Montserrat" font-weight="700" font-size="${f}" fill="${card ? '#ff5252' : '#16222f'}" text-anchor="middle">${txt}</text>`)
    }
    const railPath = `M ${polar(-90, R + 8).join(' ')} A ${R + 8} ${R + 8} 0 0 1 ${polar(90, R + 8).join(' ')}`
    const bandPath = `M ${polar(-90, RB).join(' ')} A ${RB} ${RB} 0 0 1 ${polar(90, RB).join(' ')}`
    let sectors = ''; let bug = ''
    if (!isNaN(twd)) {
      const twdRel = norm360(twd - hdg)
      const badc = up ? twdRel : norm360(twdRel + 180)
      let half = up ? opt : (180 - opt); half = Math.max(4, Math.min(88, half))
      const c = badc > 180 ? badc - 360 : badc
      sectors = `
        <path d="${arc(c - half, c + half, RB)}" fill="none" stroke="#ff5252" stroke-width="40" stroke-opacity="0.32"/>
        <path d="${arc(c + half, c + half + tol, RB + 8)}" fill="none" stroke="#36d399" stroke-width="12"/>
        <path d="${arc(c - half - tol, c - half, RB + 8)}" fill="none" stroke="#36d399" stroke-width="12"/>`
      const br = twdRel > 180 ? twdRel - 360 : twdRel
      if (br >= -90 && br <= 90) {
        const [bx, by] = polar(br, R + 6)
        bug = `<path d="M ${bx - 9},${by - 9} L ${bx + 9},${by - 9} L ${bx},${by + 9} Z" fill="#ffb84d"/>`
      }
    }
    const twdTxt = isNaN(twd) ? '--' : String(Math.round(twd)).padStart(3, '0') + '°'
    const sub = `TWA ${sideStr(twaSide)}  |  TWD ${twdTxt}`
    // Top-bar AP state, live (matches the device wind-steer header). See autopilotHud.
    const hasState = a.has('apState')
    const apSt = String(a.raw('apState') || 'standby').replace(/[^a-z0-9 _-]/gi, '').slice(0, 12)
    const engaged = /auto|track|wind|route|nav/i.test(apSt)
    const chip = engaged ? 'ON' : 'STBY'
    const badge = hasState ? apSt.toUpperCase() : 'OFFLINE'
    const xte = a.num('xte'); let needle = ''
    if (!isNaN(xte)) { let nm = xte / 1852; nm = Math.max(-1, Math.min(1, nm)); needle = `<rect x="${240 + nm * 200 - 1.5}" y="302" width="3" height="32" rx="1" fill="#ff5252"/>` }
    const tiles = gridRow([
      ['AWS', 'kn', fixed(a.kn('aws'), 1), '#ffb84d'],
      ['AWA', '', sideStr(a.side('awa')), '#eef4fa'],
      ['TWS', 'kn', fixed(a.kn('tws'), 1), '#eef4fa'],
      ['TWA', '', sideStr(twaSide), '#eef4fa']
    ])
    return svgWrap(`
      <rect x="10" y="10" width="110" height="40" rx="10" fill="#101b29" stroke="#1f2d3d"/>
      <text x="65" y="37" font-family="Montserrat" font-size="20" fill="${engaged ? '#36d399' : '#eef4fa'}" text-anchor="middle">${chip}</text>
      <text x="240" y="32" font-family="Montserrat" font-size="20" font-weight="700" fill="${engaged ? '#36d399' : '#5a6b78'}" text-anchor="middle">${esc(badge)}</text>
      <rect x="360" y="10" width="110" height="40" rx="10" fill="#101b29" stroke="#1f2d3d"/>
      <text x="415" y="37" font-family="Montserrat" font-size="20" fill="#eef4fa" text-anchor="middle">HOME</text>
      <path d="${railPath}" fill="none" stroke="#36d399" stroke-width="10"/>
      <path d="${bandPath}" fill="none" stroke="#f2f6fb" stroke-width="44"/>
      ${sectors}${ticks.join('')}${nums.join('')}
      <path d="M ${CX - 9},${CYc - R - 2} L ${CX + 9},${CYc - R - 2} L ${CX},${CYc - R + 14} Z" fill="#ff5252"/>
      ${bug}
      <text x="${CX}" y="${CYc - R / 2 - 12}" font-family="Montserrat" font-size="20" fill="#8fa7bd" text-anchor="middle">HDG</text>
      <text x="${CX}" y="${CYc - R / 2 + 38}" font-family="Montserrat" font-size="64" font-weight="700" fill="#eef4fa" text-anchor="middle">${fixed(hdg, 1)}°</text>
      <text x="${CX}" y="${CYc - 2}" font-family="Montserrat" font-size="20" fill="#8fa7bd" text-anchor="middle">${sub}</text>
      <text x="16" y="306" font-family="Montserrat" font-size="14" fill="#8fa7bd">PORT</text>
      <text x="464" y="306" font-family="Montserrat" font-size="14" fill="#8fa7bd" text-anchor="end">STBD</text>
      <line x1="40" y1="318" x2="440" y2="318" stroke="#2a3a4c" stroke-width="2"/>
      ${needle}${tiles}`)
  }

  // bottom 4-tile row used by the HUD screens.
  function gridRow (cells, y, h) {
    y = y || 362; h = h || 110
    const s = 110
    return cells.map((c, i) => {
      const x = 8 + i * 118
      const [cap, unit, val, col] = c
      return `<rect x="${x}" y="${y}" width="${s}" height="${h}" rx="10" fill="#101b29" stroke="#1f2d3d"/>`
        + `<text x="${x + 8}" y="${y + 22}" font-family="Montserrat" font-size="14" fill="#8fa7bd">${cap}</text>`
        + (unit ? `<text x="${x + s - 8}" y="${y + 22}" font-family="Montserrat" font-size="14" fill="#8fa7bd" text-anchor="end">${unit}</text>` : '')
        + `<text x="${x + s / 2}" y="${y + h - 18}" font-family="Montserrat" font-size="38" font-weight="700" fill="${col}" text-anchor="middle">${val}</text>`
    }).join('')
  }

  // ====================================================================== //
  //  Grid tile: compass widget (nav / steering)                            //
  // ====================================================================== //
  const SEC_LABELS = { cog: 'COG', cts: 'CTS', btw: 'BTW', heading: 'HDG', twd: 'TWD', apTarget: 'TGT' }
  function compassTileSVG (a, tile) {
    const hdg = a.has('heading') ? a.deg('heading') : 0
    // Secondary readout: honor the tile's configured secondary path (device
    // shows CTS on steering, COG on nav, ...), defaulting to COG when unset.
    let secKey = 'cog'
    const sp = tile && (tile.secondary || tile.secondaryPath)
    if (sp) { const k = Object.keys(PATHS).find((kk) => PATHS[kk] === sp); if (k && SEC_LABELS[k]) secKey = k }
    const secLabel = SEC_LABELS[secKey]
    const sec = a.deg(secKey)
    const CX = 100, CY = 100, R = 86
    const polar = (deg, r) => { const t = (deg - 90) * Math.PI / 180; return [CX + r * Math.cos(t), CY + r * Math.sin(t)] }
    const cards = []
    for (const [lab, b] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const [x, y] = polar(b - hdg, R - 16)
      cards.push(`<text x="${x}" y="${y + 5}" font-family="Montserrat" font-size="14" font-weight="700" fill="${lab === 'N' ? '#ff5252' : '#8fa7bd'}" text-anchor="middle">${lab}</text>`)
    }
    return `<svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" class="hud-tile-svg">
      <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="#26384a" stroke-width="4"/>
      <path d="M ${CX - 7},${CY - R - 2} L ${CX + 7},${CY - R - 2} L ${CX},${CY - R + 12} Z" fill="#ff5252"/>
      ${cards.join('')}
      <text x="${CX}" y="${CY + 4}" font-family="Montserrat" font-size="40" font-weight="700" fill="#4fc3f7" text-anchor="middle">${isNaN(hdg) ? '---' : String(Math.round(hdg)).padStart(3, '0')}</text>
      <text x="${CX}" y="${CY + 30}" font-family="Montserrat" font-size="13" fill="#8fa7bd" text-anchor="middle">${secLabel} ${isNaN(sec) ? '---' : String(Math.round(sec)).padStart(3, '0')}</text>
    </svg>`
  }

  // ====================================================================== //
  //  Fullscreen: SYSTEM / status diagnostics panel (screen_status.cpp)      //
  // ====================================================================== //
  // Two-column label:value list. Battery/SoC/Fuel/Water come from live
  // SignalK (`a`); the device telemetry (wifi/ip/rssi/ble/sk/heap/psram/
  // uptime/build) comes from the heartbeat-reported `t` object.
  function systemPanel (a, t) {
    t = t || {}
    const pct = (name) => {
      const v = a.num(name)
      return isNaN(v) ? NaN : (v <= 1.0001 ? v * 100 : v)
    }
    const soc = pct('battSoc')
    const fuel = pct('fuel')
    const water = pct('freshwater')
    const battV = a.num('battV')
    const upS = t.uptimeMs ? Math.floor(t.uptimeMs / 1000) : null
    const hhmmss = upS == null ? '--'
      : [Math.floor(upS / 3600), Math.floor(upS / 60) % 60, upS % 60]
        .map((n) => String(n).padStart(2, '0')).join(':')
    const rows = [
      ['BATTERY', isNaN(battV) ? '--' : battV.toFixed(2) + ' V', NaN],
      ['SoC', isNaN(soc) ? '--' : Math.round(soc) + '%', soc, '#36d399'],
      ['FUEL', isNaN(fuel) ? '--' : Math.round(fuel) + '%', fuel, '#ffb84d'],
      ['WATER', isNaN(water) ? '--' : Math.round(water) + '%', water, '#4fc3f7'],
      ['WIFI', t.wifiState || '--', NaN],
      ['SSID', t.ssid || '--', NaN],
      ['IP', t.ip || '--', NaN],
      ['RSSI', t.rssi ? t.rssi + ' dBm' : '--', NaN],
      ['BLE', t.ble || '--', NaN],
      ['SIGNALK', t.signalk || '--', NaN],
      ['HEAP', t.heapKb != null ? t.heapKb + ' kB' : '--', NaN],
      ['PSRAM', t.psramKb != null ? t.psramKb + ' kB' : '--', NaN],
      ['UPTIME', hhmmss, NaN],
      ['BUILD', t.build || '--', NaN]
    ]
    const ROW_H = 30
    let body = ''
    rows.forEach(([label, val, frac, color], i) => {
      const y = 64 + i * ROW_H
      body += `<text x="22" y="${y}" font-family="Montserrat" font-size="13" fill="#8fa7bd" letter-spacing="0.06em">${esc(label)}</text>`
      body += `<text x="150" y="${y}" font-family="Montserrat" font-size="18" font-weight="600" fill="#eef4fa">${esc(val)}</text>`
      if (!isNaN(frac)) {
        const w = 180, x = 282, f = Math.max(0, Math.min(100, frac)) / 100
        // color is a hard-coded literal from `rows` above (never device data).
        body += `<rect x="${x}" y="${y - 9}" width="${w}" height="8" rx="4" fill="#1f2d3d"/>`
        body += `<rect x="${x}" y="${y - 9}" width="${(w * f).toFixed(0)}" height="8" rx="4" fill="${color}"/>`
      }
    })
    return svgWrap(`
      <text x="240" y="34" font-family="Montserrat" font-size="26" font-weight="700" fill="#4fc3f7" text-anchor="middle">SYSTEM</text>
      <rect x="8" y="48" width="464" height="424" rx="12" fill="#101b29" stroke="#1f2d3d"/>
      ${body}`)
  }

  // ====================================================================== //
  //  Public surface                                                        //
  // ====================================================================== //
  const FULLSCREEN = { autopilotHud, windDial, windClassic, windSteer }
  // device built-in screen id -> fullscreen renderer (prefix-matched too).
  // wind_classic resolves to the CLASSICAL dial (windClassic), distinct from
  // the redesigned `wind` (windDial).
  const SCREEN_FULLSCREEN = {
    autopilot: autopilotHud,
    wind: windDial,
    wind_classic: windClassic,
    wind_steer: windSteer
  }

  window.DeviceHud = {
    PATHS,
    accessor,
    dms,
    // Render a fullscreen screen by its widget kind OR device screen id.
    fullscreen (key, a) {
      const fn = FULLSCREEN[key] || SCREEN_FULLSCREEN[key]
      return fn ? fn(a) : null
    },
    isFullscreenWidget (w) { return !!FULLSCREEN[w] },
    isFullscreenScreen (id) { return !!SCREEN_FULLSCREEN[id] },
    fullscreenForScreen (id) {
      if (SCREEN_FULLSCREEN[id]) return id
      const base = Object.keys(SCREEN_FULLSCREEN).find((k) => id === k || id.indexOf(k + '_') === 0)
      return base || null
    },
    // The device's built-in System/status diagnostics panel (its own renderer,
    // fed by live SignalK + the device's heartbeat telemetry `t`).
    isSystemScreen (id) { return id === 'status' || id === 'system' },
    systemPanel,
    // The device's bespoke Trip odometer screen (distance hero + time/avg/max
    // stat cards + live SOG), rendered from live SignalK (`a`) + device
    // telemetry (`t`) instead of the generic preset metric grid.
    isTripScreen (id) { return id === 'trip' },
    tripHud,
    compassTileSVG
  }
}())
