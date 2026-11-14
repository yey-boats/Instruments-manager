'use strict'

// #67 automatic day/night theme switching.
//
// Pure phase computation (lib/day-night.js) and the manager side: broadcast
// on a transition, catch-up for a display that was offline, no duplicate
// sends, the generated config following the phase, the manual override, the
// SignalK delta and the audit trail.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const dn = require('../lib/day-night')
const { makeManager } = require('./test-utils')
const { MockFirmware } = require('./mock-firmware')

// Local wall-clock instant (the schedule is in the manager's local time).
const local = (h, m, day = 1) => new Date(2026, 5, day, h, m, 0, 0).getTime()
const MIN = 60000

const LONDON = { latitude: 51.5074, longitude: -0.1278 }
const SYDNEY = { latitude: -33.8688, longitude: 151.2093 }

// ---- pure: schedule --------------------------------------------------------

test('schedule: default 07:00 / 19:30 day window', () => {
  const s = { mode: 'schedule' }
  const at = (h, m) => dn.computePhase(s, local(h, m), null)
  assert.strictEqual(at(6, 59).phase, 'night')
  assert.strictEqual(at(7, 0).phase, 'day')
  assert.strictEqual(at(19, 29).phase, 'day')
  assert.strictEqual(at(19, 30).phase, 'night')
  assert.strictEqual(at(0, 0).phase, 'night')
  assert.strictEqual(at(12, 0).theme, 'sun', 'default day theme is Sun')
  assert.strictEqual(at(23, 0).theme, 'red-night', 'default night theme is Red night')
  assert.strictEqual(at(12, 0).source, 'schedule')
})

test('schedule: a day window crossing midnight', () => {
  const s = { mode: 'schedule', dayStart: '05:00', nightStart: '00:30' }
  const at = (h, m) => dn.computePhase(s, local(h, m), null).phase
  assert.strictEqual(at(23, 0), 'day')
  assert.strictEqual(at(0, 29), 'day')
  assert.strictEqual(at(0, 30), 'night')
  assert.strictEqual(at(4, 59), 'night')
  assert.strictEqual(at(5, 0), 'day')
})

test('schedule: next change is the next dayStart / nightStart', () => {
  const s = dn.normalizeDayNight({ mode: 'schedule' })
  assert.strictEqual(dn.scheduleNextChange(s, local(12, 0)), local(19, 30))
  assert.strictEqual(dn.scheduleNextChange(s, local(20, 0)), local(7, 0, 2))
  assert.strictEqual(dn.computePhase(s, local(6, 0), null).nextChangeAt, local(7, 0))
})

test('mode off computes no phase', () => {
  assert.strictEqual(dn.computePhase({ mode: 'off' }, local(12, 0), null), null)
  assert.strictEqual(dn.computePhase(undefined, local(12, 0), null), null)
})

test('settings validation', () => {
  assert.deepStrictEqual(dn.validateDayNightPatch({ mode: 'sun', dayTheme: 'classic', nightStart: '21:15' }),
    { ok: true, errors: [], value: { mode: 'sun', dayTheme: 'classic', nightStart: '21:15' } })
  const bad = dn.validateDayNightPatch({ mode: 'auto', nightTheme: 'purple', dayStart: '7:00' })
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(bad.errors.length, 3)
  const n = dn.normalizeDayNight({ mode: 'nope', dayTheme: 'x', dayStart: '25:00' })
  assert.deepStrictEqual(n, { mode: 'off', dayTheme: 'sun', nightTheme: 'red-night', dayStart: '07:00', nightStart: '19:30', override: null })
})

// ---- pure: sun -------------------------------------------------------------

function near (actualMs, expectedIso, label, tolMin = 4) {
  const diff = Math.abs(actualMs - Date.parse(expectedIso)) / MIN
  assert.ok(diff <= tolMin, `${label}: ${new Date(actualMs).toISOString()} vs ${expectedIso} (${diff.toFixed(1)} min)`)
}

test('sun: London midsummer matches published sunrise/sunset', () => {
  // Published (timeanddate / HM Nautical Almanac): 21 Jun 2026 sunrise 04:43,
  // sunset 21:21 BST.
  const t = dn.sunTimes(Date.UTC(2026, 5, 21, 12), LONDON.latitude, LONDON.longitude)
  near(t.sunrise, '2026-06-21T03:43:00Z', 'London sunrise')
  near(t.sunset, '2026-06-21T20:21:00Z', 'London sunset')
})

test('sun: Sydney midsummer (southern hemisphere, east longitude)', () => {
  // Published: 21 Dec 2026 sunrise 05:41, sunset 20:05 AEDT (UTC+11).
  const t = dn.sunTimes(Date.UTC(2026, 11, 21, 2), SYDNEY.latitude, SYDNEY.longitude)
  near(t.sunrise, '2026-12-20T18:41:00Z', 'Sydney sunrise')
  near(t.sunset, '2026-12-21T09:05:00Z', 'Sydney sunset')
})

test('sun mode: phase from the position, with next change', () => {
  const s = { mode: 'sun' }
  const noon = dn.computePhase(s, Date.UTC(2026, 5, 21, 12), LONDON)
  assert.strictEqual(noon.phase, 'day')
  assert.strictEqual(noon.source, 'sun')
  near(noon.nextChangeAt, '2026-06-21T20:21:00Z', 'next change is sunset')
  assert.strictEqual(dn.computePhase(s, Date.UTC(2026, 5, 21, 2), LONDON).phase, 'night')
  assert.strictEqual(dn.computePhase(s, Date.UTC(2026, 5, 21, 22), LONDON).phase, 'night')
  // Polar day: the sun never sets at Svalbard in June.
  assert.strictEqual(dn.computePhase(s, Date.UTC(2026, 5, 21, 0), { latitude: 78.2, longitude: 15.6 }).phase, 'day')
  // Polar night in December.
  assert.strictEqual(dn.computePhase(s, Date.UTC(2026, 11, 21, 12), { latitude: 78.2, longitude: 15.6 }).phase, 'night')
})

test('sun mode without a position falls back to the schedule', () => {
  const s = { mode: 'sun', dayStart: '06:00', nightStart: '18:00' }
  const r = dn.computePhase(s, local(17, 0), null)
  assert.strictEqual(r.phase, 'day')
  assert.strictEqual(r.source, 'schedule-fallback')
  assert.strictEqual(dn.computePhase(s, local(18, 0), { latitude: NaN, longitude: 1 }).phase, 'night')
})

test('override holds until the automatic phase changes', () => {
  const s = { mode: 'schedule', override: { phase: 'night', basePhase: 'day', setAt: 'x' } }
  const r = dn.computePhase(s, local(12, 0), null)
  assert.strictEqual(r.phase, 'night')
  assert.strictEqual(r.theme, 'red-night')
  assert.strictEqual(r.source, 'override')
  assert.strictEqual(r.overrideExpired, false)
  const later = dn.computePhase(s, local(20, 0), null)
  assert.strictEqual(later.phase, 'night')
  assert.strictEqual(later.source, 'schedule')
  assert.strictEqual(later.overrideExpired, true)
})

// ---- manager ---------------------------------------------------------------

function setup (n = 2, opts = {}) {
  const { manager, auth } = makeManager({ auth: { mode: 'dev-shared-token', devToken: 'test-token' } })
  const deltas = []
  manager.app.handleMessage = (id, delta) => deltas.push(delta)
  if (opts.position !== undefined) {
    manager.app.getSelfPath = (p) => (p === 'navigation.position' && opts.position ? { value: opts.position } : undefined)
  }
  const fws = []
  for (let i = 0; i < n; i++) {
    const fw = new MockFirmware(manager, { deviceId: `yey-d-dn${i}`, auth, themes: opts.themes })
    fw.register()
    fw.fetchConfig()
    fws.push(fw)
  }
  return { manager, auth, fws, deltas }
}

const themeCmds = (manager, id) => manager.store.commands.commands
  .filter((c) => c.deviceId === id && c.type === 'theme.set')

const dayNightDeltas = (deltas) => deltas
  .map((d) => d.updates[0].values[0])
  .filter((v) => v.path === 'network.yeyboats.dayNight')

function auditTypes (manager) {
  const file = path.join(manager.store.dataDir, 'audit.jsonl')
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

test('defaults: mode off, Sun / Red night, 07:00 / 19:30; ticking does nothing', () => {
  const { manager, fws, deltas } = setup(1)
  const st = manager.getDayNight()
  assert.deepStrictEqual(st.settings, { mode: 'off', dayTheme: 'sun', nightTheme: 'red-night', dayStart: '07:00', nightStart: '19:30' })
  assert.strictEqual(st.status.phase, null)
  manager.dayNightTick(local(20, 0))
  assert.strictEqual(themeCmds(manager, fws[0].deviceId).length, 0)
  assert.strictEqual(dayNightDeltas(deltas).length, 0)
  assert.strictEqual(manager.generateConfig(fws[0].deviceId).settings.theme, 'day', 'per-device theme as today')
  assert.ok(!('ui' in manager.generateConfig(fws[0].deviceId)), 'no ui.theme while off')
})

test('a transition queues theme.set for every display, publishes a delta and audits', () => {
  const { manager, fws, deltas } = setup(2)
  manager.updateDayNight({ mode: 'schedule' }, local(12, 0))
  for (const fw of fws) {
    const cmds = themeCmds(manager, fw.deviceId)
    assert.strictEqual(cmds.length, 1)
    assert.deepStrictEqual(cmds[0].payload, { theme: 'sun' })
  }
  manager.dayNightTick(local(19, 31))
  for (const fw of fws) {
    const cmds = themeCmds(manager, fw.deviceId)
    assert.strictEqual(cmds.length, 2)
    assert.strictEqual(cmds[0].status, 'cancelled', 'the stale day command is withdrawn')
    assert.deepStrictEqual(cmds[1].payload, { theme: 'red-night' })
  }
  const vals = dayNightDeltas(deltas)
  assert.strictEqual(vals.length, 2)
  assert.strictEqual(vals[1].value.phase, 'night')
  assert.strictEqual(vals[1].value.theme, 'red-night')
  assert.ok(vals[1].value.at)
  const switched = auditTypes(manager).filter((e) => e.type === 'dayNight.switched')
  assert.strictEqual(switched.length, 2)
  assert.strictEqual(switched[1].data.phase, 'night')
  assert.strictEqual(switched[1].data.devices, 2)
  // Each display applies it on its next poll.
  for (const fw of fws) {
    fw.pollAndExecute()
    assert.strictEqual(fw.theme, 'red-night')
  }
})

test('no duplicate sends: same phase on later ticks and polls sends nothing', () => {
  const { manager, fws } = setup(1)
  const id = fws[0].deviceId
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fws[0].pollAndExecute()
  assert.strictEqual(fws[0].theme, 'red-night')
  for (let m = 1; m <= 10; m++) manager.dayNightTick(local(20, m))
  assert.strictEqual(fws[0].pollAndExecute().length, 0)
  fws[0].heartbeat()
  assert.strictEqual(fws[0].pollAndExecute().length, 0)
  assert.strictEqual(themeCmds(manager, id).length, 1)
})

test('catch-up: an offline display gets the current theme on its next poll', () => {
  const { manager, fws } = setup(2)
  const [online, offline] = fws
  manager.updateDayNight({ mode: 'schedule' }, local(12, 0))
  online.pollAndExecute()
  offline.pollAndExecute()
  manager.dayNightTick(local(19, 30))
  online.pollAndExecute()
  assert.strictEqual(online.theme, 'red-night')
  // The offline display never polls: its command expires.
  for (const c of themeCmds(manager, offline.deviceId)) {
    if (c.status === 'pending') c.expiresAt = new Date(Date.now() - 1000).toISOString()
  }
  manager.expireCommands()
  // Later ticks in the same phase do not re-queue for it (no spam while away).
  manager.dayNightTick(local(19, 45))
  manager.dayNightTick(local(20, 30))
  assert.strictEqual(themeCmds(manager, offline.deviceId).filter((c) => c.status === 'pending').length, 0)
  // Back online: the first poll carries the current theme.
  const got = offline.pollAndExecute()
  assert.strictEqual(got.length, 1)
  assert.deepStrictEqual(got[0].command.payload, { theme: 'red-night' })
  assert.strictEqual(offline.theme, 'red-night')
  // ...exactly once.
  assert.strictEqual(offline.pollAndExecute().length, 0)
  assert.strictEqual(online.pollAndExecute().length, 0)
  assert.strictEqual(manager.getDayNight().status.devices.find((d) => d.id === offline.deviceId).state, 'applied')
})

test('a display that rejects the theme is not re-sent it', () => {
  // Older firmware accepts only day/night in theme.set (instruments#76).
  const { manager, fws } = setup(1, { themes: ['day', 'night'] })
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  const r = fws[0].pollAndExecute()
  assert.strictEqual(r.length, 1)
  assert.strictEqual(r[0].result.ok, false)
  assert.strictEqual(fws[0].pollAndExecute().length, 0)
  manager.dayNightTick(local(21, 0))
  assert.strictEqual(fws[0].pollAndExecute().length, 0)
  assert.strictEqual(manager.getDayNight().status.devices[0].state, 'failed')
})

test('generated config follows the phase without forcing a reload', () => {
  const { manager, fws } = setup(1)
  const id = fws[0].deviceId
  const hashOff = manager.generateConfig(id).hash
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  let cfg = manager.generateConfig(id)
  assert.strictEqual(cfg.settings.theme, 'red-night')
  assert.strictEqual(cfg.ui.theme, 'red-night', 'ui.theme is what the firmware applies on config load')
  assert.strictEqual(cfg.hash, hashOff, 'phase is not part of the config hash')
  assert.strictEqual(fws[0].heartbeat().desiredConfig.reload, false)
  // A config.reload now lands on the night theme, not the per-device one.
  fws[0].fetchConfig()
  assert.strictEqual(fws[0].theme, 'red-night')
  manager.dayNightTick(local(7, 0, 2))
  cfg = manager.generateConfig(id)
  assert.strictEqual(cfg.settings.theme, 'sun')
  assert.strictEqual(cfg.hash, hashOff)
  // The device form edits the display's own theme, not the phase theme.
  assert.strictEqual(manager.generateConfig(id, { dayNight: false }).settings.theme, 'day')
})

test('override: Day now holds until the next scheduled transition', () => {
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(21, 0))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'red-night')
  manager.setDayNightOverride('day', local(22, 0))
  assert.strictEqual(manager.getDayNight().status.source, 'override')
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'sun')
  // Still night by the schedule: the override holds.
  manager.dayNightTick(local(23, 0))
  manager.dayNightTick(local(6, 59, 2))
  assert.strictEqual(fw.pollAndExecute().length, 0)
  assert.strictEqual(fw.theme, 'sun')
  // 07:00: the schedule turns to day; the override is spent.
  manager.dayNightTick(local(7, 0, 2))
  assert.strictEqual(manager.getDayNight().override, null)
  assert.strictEqual(fw.pollAndExecute().length, 0, 'already on the day theme')
  // 19:30: night again, automatically.
  manager.dayNightTick(local(19, 30, 2))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'red-night')
  // Clearing an override returns to the automatic phase.
  manager.setDayNightOverride('day', local(20, 0, 2))
  manager.setDayNightOverride(null, local(20, 1, 2))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'red-night')
  assert.ok(auditTypes(manager).some((e) => e.type === 'dayNight.override'))
})

test('override needs automatic switching on', () => {
  const { manager } = setup(0)
  assert.throws(() => manager.setDayNightOverride('night', local(12, 0)), (e) => e.status === 400)
  manager.updateDayNight({ mode: 'schedule' }, local(12, 0))
  assert.throws(() => manager.setDayNightOverride('dusk', local(12, 0)), (e) => e.status === 400)
})

test('changing the night theme re-sends during the night', () => {
  const { manager, fws } = setup(1)
  manager.updateDayNight({ mode: 'schedule' }, local(21, 0))
  fws[0].pollAndExecute()
  manager.updateDayNight({ nightTheme: 'night' }, local(21, 5))
  fws[0].pollAndExecute()
  assert.strictEqual(fws[0].theme, 'night')
})

test('turning it off restores each display\'s own theme', () => {
  const { manager, fws, deltas } = setup(1)
  const fw = fws[0]
  manager.assignProfile(fw.deviceId, { profileId: 'default', overrides: { settings: { theme: 'classic' } } })
  manager.updateDayNight({ mode: 'schedule' }, local(21, 0))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'red-night')
  manager.updateDayNight({ mode: 'off' }, local(21, 10))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'classic')
  assert.strictEqual(manager.generateConfig(fw.deviceId).settings.theme, 'classic')
  assert.strictEqual(dayNightDeltas(deltas).pop().value.phase, 'off')
  manager.dayNightTick(local(7, 30, 2))
  assert.strictEqual(fw.pollAndExecute().length, 0)
})

test('sun mode reads navigation.position from SignalK', () => {
  const { manager, fws } = setup(1, { position: LONDON })
  manager.updateDayNight({ mode: 'sun' }, Date.UTC(2026, 5, 21, 20, 0))
  assert.strictEqual(manager.getDayNight().status.phase, 'day')
  assert.strictEqual(manager.getDayNight().status.source, 'sun')
  manager.dayNightTick(Date.UTC(2026, 5, 21, 20, 30))
  assert.strictEqual(manager.getDayNight().status.phase, 'night')
  fws[0].pollAndExecute()
  assert.strictEqual(fws[0].theme, 'red-night')
})

test('settings persist across a restart', () => {
  const { manager } = setup(0)
  manager.updateDayNight({ mode: 'sun', dayTheme: 'day', nightStart: '20:15' }, local(12, 0))
  const { YeyBoatsDisplayManager } = require('../lib/manager')
  const again = new YeyBoatsDisplayManager(manager.app, manager.options)
  try {
    assert.deepStrictEqual(again.getDayNight().settings, { mode: 'sun', dayTheme: 'day', nightTheme: 'red-night', dayStart: '07:00', nightStart: '20:15' })
  } finally {
    again.close()
  }
  assert.throws(() => manager.updateDayNight({ dayStart: '7am' }), (e) => e.status === 400)
})

// ---- routes + UI -------------------------------------------------------------

function routesFor (manager) {
  const list = []
  const add = (method) => (p, ...h) => list.push({ method, p, h: h[h.length - 1] })
  require('../index')._test.registerRoutes({ use () {}, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') }, () => manager)
  return (method, p, body) => {
    const r = list.find((x) => x.method === method && x.p === p)
    assert.ok(r, `${method} ${p} registered`)
    return new Promise((resolve, reject) => {
      const out = {}
      const res = {
        statusCode: 200,
        setHeader (k, v) { out[k.toLowerCase()] = v },
        status (c) { this.statusCode = c; return this },
        json (b) { resolve({ status: this.statusCode, json: b, headers: out }) },
        end (b) { resolve({ status: this.statusCode, body: b, headers: out }) }
      }
      const headers = { 'content-type': body && body.__form ? 'application/x-www-form-urlencoded' : 'application/json' }
      const req = { method, params: {}, query: {}, headers, body: body || {}, socket: { remoteAddress: '127.0.0.1' }, get: (k) => headers[String(k).toLowerCase()] || '' }
      Promise.resolve(r.h(req, res)).catch(reject)
    })
  }
}

test('JSON API: GET / POST /day-night and POST /day-night/override', async () => {
  const { manager } = setup(1)
  const call = routesFor(manager)
  let r = await call('GET', '/day-night')
  assert.strictEqual(r.json.settings.mode, 'off')
  r = await call('POST', '/day-night', { mode: 'schedule', nightTheme: 'night' })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.json.settings.mode, 'schedule')
  assert.strictEqual(r.json.settings.nightTheme, 'night')
  assert.ok(['day', 'night'].includes(r.json.status.phase))
  r = await call('POST', '/day-night', { dayStart: 'noon' })
  assert.strictEqual(r.status, 400)
  const want = r.json && r.json.error ? r.json.error : r.json
  assert.ok(want, 'error body')
  r = await call('POST', '/day-night/override', { phase: 'night' })
  assert.strictEqual(r.status, 200)
  assert.strictEqual(r.json.status.phase, 'night')
  r = await call('POST', '/day-night/override', { phase: null })
  assert.strictEqual(r.json.override, null)
})

test('settings page has the Day / night section', async () => {
  const { manager } = setup(0)
  const idx = require('../index.js')
  let html = idx.__renderSettingsPage(manager, { query: {} })
  assert.ok(/id="day-night"/.test(html))
  assert.ok(/name="dayNightMode"/.test(html))
  assert.ok(/name="dayTheme"[\s\S]*value="sun" selected/.test(html))
  assert.ok(/name="nightTheme"[\s\S]*value="red-night" selected/.test(html))
  assert.ok(/name="dayStart"[^>]*value="07:00"/.test(html))
  assert.ok(/name="nightStart"[^>]*value="19:30"/.test(html))
  assert.ok(!/Night now/.test(html), 'no override buttons while off')
  const call = routesFor(manager)
  const r = await call('POST', '/ui/settings/day-night', { __form: true, dayNightMode: 'schedule', dayTheme: 'day', nightTheme: 'red-night', dayStart: '06:30', nightStart: '20:00' })
  assert.strictEqual(r.status, 303)
  assert.strictEqual(manager.getDayNight().settings.dayStart, '06:30')
  html = idx.__renderSettingsPage(manager, { query: {} })
  assert.ok(/Day now/.test(html) && /Night now/.test(html))
  const o = await call('POST', '/ui/settings/day-night/override', { __form: true, phase: 'night' })
  assert.strictEqual(o.status, 303)
  assert.strictEqual(manager.getDayNight().status.phase, 'night')
})
