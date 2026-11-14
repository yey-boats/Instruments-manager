'use strict'

// Automatic day/night theme switching: pure phase computation.
//
// mode 'off'      - no automatic switching (each display keeps its own theme)
// mode 'schedule' - day from dayStart to nightStart, local (server) time
// mode 'sun'      - day from sunrise to sunset at the boat's position; the
//                   schedule is used while no position is known
//
// A manual override ("Day now" / "Night now") holds until the underlying
// automatic phase next changes, i.e. until the next scheduled transition.
//
// The solar calculation is the standard sunrise equation (NOAA-style mean
// anomaly / equation of centre / declination, -0.833 deg for refraction and
// the solar disc), good to a minute or two away from the poles.

const { isTheme } = require('./themes')

const MODES = ['off', 'schedule', 'sun']
const PHASES = ['day', 'night']
const DAY_MS = 86400000
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

const DEFAULT_DAY_NIGHT = Object.freeze({
  mode: 'off',
  dayTheme: 'sun',
  nightTheme: 'red-night',
  dayStart: '07:00',
  nightStart: '19:30'
})

function isHHMM (s) {
  return typeof s === 'string' && HHMM.test(s)
}

function minutesOf (hhmm) {
  const m = HHMM.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// Settings as stored, with defaults filled in for anything missing/invalid.
function normalizeDayNight (raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const out = {
    mode: MODES.includes(r.mode) ? r.mode : DEFAULT_DAY_NIGHT.mode,
    dayTheme: isTheme(r.dayTheme) ? r.dayTheme : DEFAULT_DAY_NIGHT.dayTheme,
    nightTheme: isTheme(r.nightTheme) ? r.nightTheme : DEFAULT_DAY_NIGHT.nightTheme,
    dayStart: isHHMM(r.dayStart) ? r.dayStart : DEFAULT_DAY_NIGHT.dayStart,
    nightStart: isHHMM(r.nightStart) ? r.nightStart : DEFAULT_DAY_NIGHT.nightStart,
    override: null
  }
  if (r.override && PHASES.includes(r.override.phase) && PHASES.includes(r.override.basePhase)) {
    out.override = {
      phase: r.override.phase,
      basePhase: r.override.basePhase,
      setAt: r.override.setAt || null
    }
  }
  return out
}

// Validate an operator patch; returns { ok, errors, value } where value is the
// cleaned partial patch (only the recognised keys that were given).
function validateDayNightPatch (patch) {
  const errors = []
  const value = {}
  const p = patch && typeof patch === 'object' ? patch : {}
  if (p.mode !== undefined) {
    if (MODES.includes(p.mode)) value.mode = p.mode
    else errors.push(`mode must be one of ${MODES.join(', ')}`)
  }
  for (const k of ['dayTheme', 'nightTheme']) {
    if (p[k] === undefined) continue
    if (isTheme(p[k])) value[k] = p[k]
    else errors.push(`${k} is not a known theme`)
  }
  for (const k of ['dayStart', 'nightStart']) {
    if (p[k] === undefined) continue
    if (isHHMM(p[k])) value[k] = p[k]
    else errors.push(`${k} must be HH:MM (24 h)`)
  }
  return { ok: errors.length === 0, errors, value }
}

// ---- schedule --------------------------------------------------------------

function localMinutes (ms) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

function schedulePhase (s, ms) {
  const day = minutesOf(s.dayStart)
  const night = minutesOf(s.nightStart)
  const t = localMinutes(ms)
  if (day === night) return 'day'
  if (day < night) return t >= day && t < night ? 'day' : 'night'
  // Day window crosses midnight (e.g. day 05:00 .. night 00:30).
  return t >= day || t < night ? 'day' : 'night'
}

// Next local wall-clock occurrence of HH:MM strictly after ms.
function nextLocal (hhmm, ms) {
  const mins = minutesOf(hhmm)
  const d = new Date(ms)
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60, 0, 0)
  if (c.getTime() <= ms) c.setDate(c.getDate() + 1)
  return c.getTime()
}

function scheduleNextChange (s, ms) {
  if (s.dayStart === s.nightStart) return null
  return Math.min(nextLocal(s.dayStart, ms), nextLocal(s.nightStart, ms))
}

// ---- sun -------------------------------------------------------------------

const RAD = Math.PI / 180

function toJulian (ms) { return ms / DAY_MS + 2440587.5 }
function fromJulian (j) { return Math.round((j - 2440587.5) * DAY_MS) }

// Sunrise / sunset (UTC ms) for the solar day `n` (days since J2000.0, the
// local solar day at longitude lon). { polar: 'day'|'night' } when the sun
// does not rise or set that day.
function sunEventsForDay (n, lat, lon) {
  const jStar = n - lon / 360
  const M = ((357.5291 + 0.98560028 * jStar) % 360 + 360) % 360
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD)
  const lambda = ((M + C + 180 + 102.9372) % 360 + 360) % 360
  const jTransit = 2451545.0 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD)
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD)
  const cosDec = Math.cos(Math.asin(sinDec))
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec)
  if (cosW < -1) return { polar: 'day', transit: fromJulian(jTransit) }
  if (cosW > 1) return { polar: 'night', transit: fromJulian(jTransit) }
  const w = Math.acos(cosW) / RAD
  return {
    sunrise: fromJulian(jTransit - w / 360),
    sunset: fromJulian(jTransit + w / 360),
    transit: fromJulian(jTransit)
  }
}

function solarDayIndex (ms, lon) {
  return Math.round(toJulian(ms) - 2451545.0 + lon / 360)
}

// Sunrise / sunset around the instant ms at (lat, lon) in degrees, east and
// north positive. Returns UTC ms values (or a polar marker).
function sunTimes (ms, lat, lon) {
  return sunEventsForDay(solarDayIndex(ms, lon), lat, lon)
}

function sunPhase (ms, lat, lon) {
  const ev = sunTimes(ms, lat, lon)
  if (ev.polar) return ev.polar
  return ms >= ev.sunrise && ms < ev.sunset ? 'day' : 'night'
}

function sunNextChange (ms, lat, lon) {
  const n0 = solarDayIndex(ms, lon)
  for (let n = n0 - 1; n <= n0 + 2; n++) {
    const ev = sunEventsForDay(n, lat, lon)
    if (ev.polar) continue
    if (ev.sunrise > ms) return ev.sunrise
    if (ev.sunset > ms) return ev.sunset
  }
  return null
}

function validPosition (pos) {
  return Boolean(pos) && Number.isFinite(pos.latitude) && Number.isFinite(pos.longitude) &&
    Math.abs(pos.latitude) <= 90 && Math.abs(pos.longitude) <= 180
}

// ---- phase -----------------------------------------------------------------

// The automatic phase, ignoring any override.
function automaticPhase (s, ms, position) {
  if (s.mode === 'sun' && validPosition(position)) {
    return {
      phase: sunPhase(ms, position.latitude, position.longitude),
      source: 'sun',
      nextChangeAt: sunNextChange(ms, position.latitude, position.longitude)
    }
  }
  return {
    phase: schedulePhase(s, ms),
    source: s.mode === 'sun' ? 'schedule-fallback' : 'schedule',
    nextChangeAt: scheduleNextChange(s, ms)
  }
}

// Current phase for settings `raw` at ms. `position` is { latitude, longitude }
// or null. Returns null when mode is off. `overrideExpired` is true when a
// stored override no longer applies (the automatic phase has moved on).
function computePhase (raw, ms, position) {
  const s = normalizeDayNight(raw)
  if (s.mode === 'off') return null
  const auto = automaticPhase(s, ms, position)
  let phase = auto.phase
  let source = auto.source
  let overrideExpired = false
  if (s.override) {
    if (s.override.basePhase === auto.phase) {
      phase = s.override.phase
      source = 'override'
    } else {
      overrideExpired = true
    }
  }
  return {
    phase,
    theme: phase === 'day' ? s.dayTheme : s.nightTheme,
    source,
    automaticPhase: auto.phase,
    nextChangeAt: auto.nextChangeAt,
    overrideExpired
  }
}

module.exports = {
  MODES,
  PHASES,
  DEFAULT_DAY_NIGHT,
  isHHMM,
  normalizeDayNight,
  validateDayNightPatch,
  schedulePhase,
  scheduleNextChange,
  sunTimes,
  sunPhase,
  sunNextChange,
  validPosition,
  automaticPhase,
  computePhase
}
