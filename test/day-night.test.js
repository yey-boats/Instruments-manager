'use strict'

// #67 automatic day/night theme switching.
//
// Pure phase computation (lib/day-night.js) and the manager side: broadcast
// on a transition, catch-up for a display that was offline, no duplicate
// sends, the generated config never carrying the phase theme (theme.set is
// the only carrier), the manual override, the SignalK delta and the audit
// trail.

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
    const fw = new MockFirmware(manager, { deviceId: `yey-d-dn${i}`, auth, themes: opts.themes, ackStrings: opts.ackStrings })
    fw.register()
    fw.fetchConfig()
    fws.push(fw)
  }
  return { manager, auth, fws, deltas }
}

const themeCmds = (manager, id) => manager.store.commands.commands
  .filter((c) => c.deviceId === id && c.type === 'theme.set')

// Moves Date.now() (command timestamps, expiry, retry spacing) forward; the
// phase itself is driven by the explicit instants passed to the manager.
function clock (t) {
  const real = Date.now
  let off = 0
  Date.now = () => real() + off
  t.after(() => { Date.now = real })
  return { advance (ms) { off += ms } }
}

// Retry spacing and per-switch send cap (lib/manager.js).
const RETRY_MS = 60 * 1000
const MAX_SENDS = 5

const record = (manager, id) => manager.getDayNight().status.devices.find((d) => d.id === id)

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

test('catch-up: an offline display gets the current theme on its next poll', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(2)
  const [online, offline] = fws
  manager.updateDayNight({ mode: 'schedule' }, local(12, 0))
  online.pollAndExecute()
  offline.pollAndExecute()
  manager.dayNightTick(local(19, 30))
  online.pollAndExecute()
  assert.strictEqual(online.theme, 'red-night')
  // The offline display never polls: its command expires.
  c.advance(5 * MIN)
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

test('the generated config never carries the phase theme', () => {
  // PR #70 review B1: the firmware persists a fetched config and re-applies
  // it (ui.theme included) on every boot, so a phase theme in the config
  // would come back after a power cycle in the other phase. The switch is
  // delivered only by theme.set, which the firmware keeps in NVS.
  const { manager, fws } = setup(1)
  const id = fws[0].deviceId
  const off = manager.generateConfig(id)
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  const cfg = manager.generateConfig(id)
  assert.strictEqual(cfg.settings.theme, 'day', 'the display\'s own theme')
  assert.ok(!cfg.ui || cfg.ui.theme === undefined, 'no ui.theme')
  assert.strictEqual(cfg.hash, off.hash)
  assert.strictEqual(fws[0].heartbeat().desiredConfig.reload, false)
  fws[0].pollAndExecute()
  fws[0].fetchConfig()
  assert.strictEqual(fws[0].theme, 'red-night', 'a config reload keeps the theme.set theme')
})

test('B1: a power cycle in the other phase does not bring back the old theme', () => {
  const { manager, fws } = setup(1)
  const fw = fws[0]
  const id = fw.deviceId
  manager.patchDevice(id, { overrides: { settings: { theme: 'classic' } } })
  fw.fetchConfig()
  fw.theme = 'classic'
  manager.updateDayNight({ mode: 'schedule' }, local(12, 0))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'sun')
  // A device setting edited during the day: the display fetches the new
  // config and persists it to flash (the hash changed).
  manager.patchDevice(id, { overrides: { settings: { theme: 'classic', brightness: 0.5 } } })
  assert.strictEqual(fw.heartbeat().desiredConfig.reload, true)
  fw.fetchConfig()
  assert.strictEqual(fw.theme, 'sun')
  assert.strictEqual(fw.persisted.hash, manager.generateConfig(id).hash)
  manager.dayNightTick(local(20, 0))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'red-night')
  // Power cycle at night: the persisted config is re-applied.
  fw.reboot()
  assert.strictEqual(fw.theme, 'red-night', 'boots on the night theme')
  assert.strictEqual(fw.heartbeat().desiredConfig.reload, false)
  assert.strictEqual(fw.pollAndExecute().length, 0)
  // Switching turned off: the own theme comes back and survives a reboot.
  manager.updateDayNight({ mode: 'off' }, local(23, 30))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'classic')
  fw.reboot()
  assert.strictEqual(fw.theme, 'classic')
  assert.strictEqual(fw.heartbeat().desiredConfig.reload, false)
  assert.strictEqual(fw.pollAndExecute().length, 0)
})

test('B1: a display that reports another theme after applying is re-sent it, rate-limited and capped', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  const id = fw.deviceId
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  fw.heartbeat()
  assert.strictEqual(fw.theme, 'red-night')
  // A persisted config with a ui.theme in it (another manager, #71...) is
  // re-applied on boot and overwrites the NVS theme.
  fw.persisted = Object.assign({}, fw.persisted, { ui: { theme: 'sun' } })
  fw.reboot()
  assert.strictEqual(fw.theme, 'sun')
  fw.heartbeat()
  c.advance(RETRY_MS)
  let got = fw.pollAndExecute()
  assert.strictEqual(got.length, 1)
  assert.deepStrictEqual(got[0].command.payload, { theme: 'red-night' })
  assert.strictEqual(fw.theme, 'red-night')
  fw.heartbeat()
  assert.strictEqual(fw.pollAndExecute().length, 0, 'reports the theme it was sent')
  // Reverted again at once: nothing within the retry interval...
  fw.reboot()
  fw.heartbeat()
  assert.strictEqual(fw.pollAndExecute().length, 0)
  // ...then once more.
  c.advance(RETRY_MS)
  assert.strictEqual(fw.pollAndExecute().length, 1)
  // A display that keeps reverting gets at most MAX_SENDS per switch (each
  // reboot is a while after the last ack, as a real power cycle is).
  for (let i = 0; i < 10; i++) {
    c.advance(RETRY_MS)
    fw.reboot()
    fw.heartbeat()
    fw.pollAndExecute()
  }
  assert.strictEqual(themeCmds(manager, id).length, MAX_SENDS)
  assert.strictEqual(record(manager, id).state, 'gave-up')
  // The next switch starts afresh: the display already reports the day
  // theme (its persisted config brought it back), so that one is applied.
  manager.dayNightTick(local(7, 0, 2))
  assert.strictEqual(fw.pollAndExecute().length, 0)
  assert.strictEqual(fw.theme, 'sun')
  assert.strictEqual(record(manager, id).state, 'applied')
  // ...and the night after is sent again.
  manager.dayNightTick(local(20, 0, 2))
  got = fw.pollAndExecute()
  assert.strictEqual(got.length, 1)
  assert.strictEqual(fw.theme, 'red-night')
})

test('B1: a heartbeat sent before the theme was applied does not count as a mismatch', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.heartbeat() // still on 'day': the command is not applied yet
  fw.pollAndExecute()
  c.advance(RETRY_MS)
  assert.strictEqual(fw.pollAndExecute().length, 0)
  assert.strictEqual(themeCmds(manager, fw.deviceId).length, 1)
})

test('B1: a theme the operator set by hand is not fought until the next switch', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  manager.createCommand(fw.deviceId, { type: 'theme.set', payload: { theme: 'high-contrast' } })
  fw.pollAndExecute()
  fw.heartbeat()
  c.advance(RETRY_MS)
  assert.strictEqual(fw.pollAndExecute().length, 0)
  assert.strictEqual(fw.theme, 'high-contrast')
  manager.dayNightTick(local(7, 0, 2))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'sun')
})

test('S1: older firmware that rejects ui.theme is not sent into a config refetch loop', () => {
  // Firmware rejecting an unknown ui.theme applies the valid subset but
  // never records the new hash as applied, so a phase theme in the config
  // would make every heartbeat ask for a reload.
  const { manager, fws } = setup(1, { themes: ['day', 'night'] })
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  manager.patchDevice(fw.deviceId, { overrides: { settings: { brightness: 0.4 } } })
  assert.strictEqual(fw.heartbeat().desiredConfig.reload, true)
  fw.fetchConfig()
  for (let i = 0; i < 3; i++) assert.strictEqual(fw.heartbeat().desiredConfig.reload, false)
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

test('S2: turning it off while a display is away restores its theme when it is back', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  const id = fw.deviceId
  manager.patchDevice(id, { overrides: { settings: { theme: 'classic' } } })
  fw.fetchConfig()
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'red-night')
  manager.updateDayNight({ mode: 'off' }, local(21, 0))
  // Away for longer than the command lives.
  c.advance(5 * MIN)
  manager.expireCommands()
  assert.ok(record(manager, id), 'the restore is still owed')
  const hb = fw.heartbeat()
  assert.strictEqual(hb.desiredConfig.reload, false)
  const got = fw.pollAndExecute()
  assert.strictEqual(got.length, 1)
  assert.deepStrictEqual(got[0].command.payload, { theme: 'classic' })
  assert.strictEqual(fw.theme, 'classic')
  assert.strictEqual(record(manager, id), undefined, 'done once acknowledged')
  c.advance(5 * MIN)
  assert.strictEqual(fw.pollAndExecute().length, 0)
})

test('S2: a restore that is never confirmed is retried a bounded number of times', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  manager.updateDayNight({ mode: 'off' }, local(21, 0))
  fw.busy = true
  for (let i = 0; i < 20; i++) {
    fw.pollAndExecute()
    c.advance(RETRY_MS)
  }
  const restores = themeCmds(manager, fw.deviceId).filter((x) => x.payload.theme === 'day')
  assert.strictEqual(restores.length, MAX_SENDS)
  assert.strictEqual(record(manager, fw.deviceId), undefined, 'given up')
})

test('S3: a display that heartbeats but does not fetch commands is not queued more', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  for (let i = 0; i < 30; i++) {
    c.advance(61000)
    manager.dashboard()
    fw.heartbeat()
  }
  assert.strictEqual(themeCmds(manager, fw.deviceId).length, 1)
  // One that fetches but never acknowledges: bounded too.
  for (let i = 0; i < 30; i++) {
    c.advance(61000)
    manager.getCommands(fw.deviceId, fw.auth, 10)
    fw.heartbeat()
  }
  assert.strictEqual(themeCmds(manager, fw.deviceId).length, MAX_SENDS)
  const created = auditTypes(manager).filter((e) => e.type === 'command.created')
  assert.ok(created.length <= MAX_SENDS + 2, `audit stays small (${created.length})`)
})

test('nit: a command delivered but never acknowledged is sent again after it expires', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  assert.strictEqual(manager.getCommands(fw.deviceId, fw.auth, 10).commands.length, 1) // lost on the way
  c.advance(RETRY_MS + 1000)
  const got = fw.pollAndExecute()
  assert.strictEqual(got.length, 1)
  assert.strictEqual(fw.theme, 'red-night')
  assert.strictEqual(record(manager, fw.deviceId).state, 'applied')
})

test('S4: firmware status strings: invalid_payload is a refusal, busy is retried', (t) => {
  const c = clock(t)
  // invalid_payload: older firmware without the theme.
  {
    const { manager, fws } = setup(1, { themes: ['day', 'night'], ackStrings: true })
    const fw = fws[0]
    manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
    const r = fw.pollAndExecute()
    assert.strictEqual(r.length, 1)
    assert.strictEqual(manager.getCommand(fw.deviceId, r[0].command.id).status, 'failed')
    c.advance(RETRY_MS)
    assert.strictEqual(fw.pollAndExecute().length, 0)
    assert.strictEqual(record(manager, fw.deviceId).state, 'failed')
  }
  // busy: sent again after the retry interval.
  {
    const { manager, fws } = setup(1, { ackStrings: true })
    const fw = fws[0]
    manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
    fw.busy = true
    assert.strictEqual(fw.pollAndExecute().length, 1)
    assert.strictEqual(record(manager, fw.deviceId).state, 'retry')
    assert.strictEqual(fw.pollAndExecute().length, 0, 'not straight away')
    fw.busy = false
    c.advance(RETRY_MS)
    assert.strictEqual(fw.pollAndExecute().length, 1)
    assert.strictEqual(fw.theme, 'red-night')
    assert.strictEqual(record(manager, fw.deviceId).state, 'applied')
  }
})

test('nit: a phase change while the manager was down applies at startup', (t) => {
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(12, 0))
  fw.pollAndExecute()
  assert.strictEqual(fw.theme, 'sun')
  manager.close()
  const real = Date.now
  const night = new Date(2027, 0, 1, 21, 0, 0, 0).getTime()
  Date.now = () => night
  t.after(() => { Date.now = real })
  const { YeyBoatsDisplayManager } = require('../lib/manager')
  const again = new YeyBoatsDisplayManager(manager.app, manager.options)
  t.after(() => again.close())
  assert.strictEqual(again.getDayNight().status.phase, 'night')
  const pending = again.store.commands.commands.filter((x) => x.deviceId === fw.deviceId && x.type === 'theme.set' && x.status === 'pending')
  assert.strictEqual(pending.length, 1)
  assert.deepStrictEqual(pending[0].payload, { theme: 'red-night' })
})

// ---- PR #70 re-review (6ef9f7a) ---------------------------------------------

// Pins Date.now() to `start` and lets the test move it.
function pinnedClock (t, start) {
  const real = Date.now
  let at = start
  Date.now = () => at
  t.after(() => { Date.now = real })
  return { advance (ms) { at += ms } }
}

// HH:00 `h` hours after the local hour of `ms`.
const hourAfter = (ms, h) => `${String((new Date(ms).getHours() + h) % 24).padStart(2, '0')}:00`

test('R1: sun mode keeps the last known position across a restart and a GPS dropout', (t) => {
  // 21 Jun 04:30 UTC: the sun is up in London (sunrise 03:43Z). The fixed
  // times are set so that the schedule says night then.
  const t0 = Date.UTC(2026, 5, 21, 4, 30)
  const c = pinnedClock(t, t0)
  const { manager, fws } = setup(1)
  const fw = fws[0]
  let pos = LONDON
  manager.app.getSelfPath = (p) => (p === 'navigation.position' && pos ? { value: pos } : undefined)
  manager.updateDayNight({ mode: 'sun', dayStart: hourAfter(t0, 1), nightStart: hourAfter(t0, 2) }, Date.now())
  assert.strictEqual(manager.getDayNight().status.source, 'sun')
  fw.pollAndExecute()
  fw.heartbeat()
  assert.strictEqual(fw.theme, 'sun')
  const kept = manager.store.settings.dayNight.lastPosition
  assert.ok(kept && Math.abs(kept.latitude - LONDON.latitude) < 1e-9 && Math.abs(kept.longitude - LONDON.longitude) < 1e-9)
  assert.ok(kept.at, 'with the time it was seen')
  // Restart before SignalK has a position: the startup tick uses the last one.
  manager.close()
  pos = null
  c.advance(2 * MIN)
  const { YeyBoatsDisplayManager } = require('../lib/manager')
  const again = new YeyBoatsDisplayManager(manager.app, manager.options)
  t.after(() => again.close())
  fw.manager = again
  const st = again.getDayNight().status
  assert.strictEqual(st.phase, 'day')
  assert.strictEqual(st.source, 'sun-last-position')
  assert.strictEqual(fw.pollAndExecute().length, 0, 'nothing broadcast at startup')
  assert.strictEqual(fw.theme, 'sun')
  // The fix is back, then lost again mid-run: no flip either way.
  pos = LONDON
  c.advance(MIN)
  assert.strictEqual(again.dayNightTick().changed, false)
  pos = null
  c.advance(MIN)
  assert.strictEqual(again.dayNightTick().changed, false)
  assert.strictEqual(fw.pollAndExecute().length, 0)
  assert.strictEqual(themeCmds(again, fw.deviceId).length, 1)
  assert.ok(/last known position/.test(require('../index.js').__renderSettingsPage(again, { query: {} })))
})

test('R1: sun mode with no position ever known uses the fixed times', () => {
  const { manager } = setup(0, { position: null })
  manager.updateDayNight({ mode: 'sun' }, local(12, 0))
  assert.strictEqual(manager.getDayNight().status.source, 'schedule-fallback')
  assert.strictEqual(manager.getDayNight().status.position, false)
  assert.ok(!manager.store.settings.dayNight.lastPosition)
})

test('R2: a theme picked on the display itself holds until the next switch', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1, { ackStrings: true })
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  fw.heartbeat()
  assert.strictEqual(fw.theme, 'red-night')
  for (let i = 0; i < 8; i++) {
    c.advance(5 * MIN)
    fw.theme = 'night' // the crew picks it on the touch screen
    fw.heartbeat()
    c.advance(15000)
    assert.strictEqual(fw.pollAndExecute().length, 0, 'not reverted')
    fw.heartbeat()
  }
  assert.strictEqual(fw.theme, 'night')
  assert.strictEqual(themeCmds(manager, fw.deviceId).length, 1)
  assert.strictEqual(record(manager, fw.deviceId).state, 'local')
  const html = require('../index.js').__renderSettingsPage(manager, { query: {} })
  assert.ok(/changed on the display/.test(html), 'shown as changed on the display')
  assert.ok(!/did not keep the theme/.test(html))
  // The next switch applies again.
  manager.dayNightTick(local(7, 0, 2))
  assert.strictEqual(fw.pollAndExecute().length, 1)
  assert.strictEqual(fw.theme, 'sun')
})

test('R2: a heartbeat built just before the queued theme took effect is not a local change', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1, { ackStrings: true })
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  // The firmware acks when the UI task has the command queued; a heartbeat
  // right after can still carry the old theme.
  fw.theme = 'day'
  fw.heartbeat()
  fw.theme = 'red-night'
  assert.notStrictEqual(record(manager, fw.deviceId).state, 'local')
  c.advance(15000)
  fw.heartbeat()
  assert.strictEqual(record(manager, fw.deviceId).state, 'applied')
})

test('R2: a reboot after the ack that brings back another theme is re-sent once', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1, { ackStrings: true })
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  // No heartbeat between the ack and the power cycle (missed, or the
  // display went down at once): the uptime still shows it rebooted.
  c.advance(5 * MIN)
  fw.persisted = Object.assign({}, fw.persisted, { ui: { theme: 'sun' } })
  fw.reboot()
  c.advance(30000)
  fw.heartbeat()
  assert.strictEqual(fw.theme, 'sun')
  const got = fw.pollAndExecute()
  assert.strictEqual(got.length, 1)
  assert.deepStrictEqual(got[0].command.payload, { theme: 'red-night' })
  fw.heartbeat()
  assert.strictEqual(record(manager, fw.deviceId).state, 'applied')
  // Then the crew changes it (no reboot): respected.
  c.advance(5 * MIN)
  fw.theme = 'classic'
  fw.heartbeat()
  c.advance(RETRY_MS)
  assert.strictEqual(fw.pollAndExecute().length, 0)
  assert.strictEqual(record(manager, fw.deviceId).state, 'local')
})

test('R3: an operator theme.set sent while the record is in retry is not overwritten', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1, { ackStrings: true })
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.busy = true
  fw.pollAndExecute()
  fw.busy = false
  assert.strictEqual(record(manager, fw.deviceId).state, 'retry')
  c.advance(20000)
  manager.createCommand(fw.deviceId, { type: 'theme.set', payload: { theme: 'high-contrast' } })
  fw.pollAndExecute()
  fw.heartbeat()
  assert.strictEqual(fw.theme, 'high-contrast')
  c.advance(RETRY_MS)
  assert.strictEqual(fw.pollAndExecute().length, 0)
  fw.heartbeat()
  assert.strictEqual(fw.theme, 'high-contrast')
  assert.strictEqual(record(manager, fw.deviceId).state, 'overridden')
})

test('R3: an operator theme.set that was not applied does not stop a retry', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1, { ackStrings: true, themes: ['day', 'night', 'sun', 'red-night'] })
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.busy = true
  fw.pollAndExecute()
  fw.busy = false
  // Refused by the display (the build lacks it)...
  manager.createCommand(fw.deviceId, { type: 'theme.set', payload: { theme: 'classic' } })
  fw.pollAndExecute()
  // ...and one cancelled before delivery.
  const cancelled = manager.createCommand(fw.deviceId, { type: 'theme.set', payload: { theme: 'high-contrast' } })
  manager.cancelCommand(fw.deviceId, cancelled.id, 'changed my mind')
  c.advance(RETRY_MS)
  const got = fw.pollAndExecute()
  assert.strictEqual(got.length, 1)
  assert.deepStrictEqual(got[0].command.payload, { theme: 'red-night' })
  assert.strictEqual(fw.theme, 'red-night')
})

test('Ra: a display that never acks but reports the theme counts as applied', (t) => {
  const c = clock(t)
  const { manager, fws } = setup(1, { ackStrings: true })
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  for (let i = 0; i < 40; i++) {
    // Low heap: the command runs but no ack goes out.
    const got = manager.getCommands(fw.deviceId, fw.auth, 10).commands
    got.forEach((x) => { if (x.type === 'theme.set') fw.theme = x.payload.theme })
    fw.heartbeat()
    c.advance(15000)
  }
  assert.strictEqual(fw.theme, 'red-night')
  assert.strictEqual(themeCmds(manager, fw.deviceId).length, 1)
  assert.strictEqual(record(manager, fw.deviceId).state, 'applied')
})

test('Ra: a display already reporting the phase theme is not sent it', () => {
  const { manager, fws } = setup(2)
  const [on, other] = fws
  on.theme = 'red-night'
  on.heartbeat()
  other.heartbeat()
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  assert.strictEqual(themeCmds(manager, on.deviceId).length, 0)
  assert.strictEqual(record(manager, on.deviceId).state, 'applied')
  assert.strictEqual(themeCmds(manager, other.deviceId).length, 1)
  assert.strictEqual(on.pollAndExecute().length, 0)
  // The next switch is sent as usual.
  manager.dayNightTick(local(7, 0, 2))
  assert.strictEqual(on.pollAndExecute().length, 1)
  assert.strictEqual(on.theme, 'sun')
})

test('Ra: skipping the send also withdraws a queued theme.set for another target', () => {
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  fw.pollAndExecute()
  fw.heartbeat()
  // Off: a restore to its own theme is queued, but the display does not poll.
  manager.updateDayNight({ mode: 'off' }, local(20, 10))
  assert.strictEqual(themeCmds(manager, fw.deviceId).filter((x) => x.status === 'pending').length, 1)
  // On again while it still reports the night theme.
  manager.updateDayNight({ mode: 'schedule' }, local(20, 20))
  assert.strictEqual(themeCmds(manager, fw.deviceId).filter((x) => x.status === 'pending').length, 0)
  assert.strictEqual(fw.pollAndExecute().length, 0)
  assert.strictEqual(fw.theme, 'red-night')
  assert.strictEqual(record(manager, fw.deviceId).state, 'applied')
})

test('Rb: a day/night error never breaks command delivery', () => {
  const { manager, fws } = setup(1)
  const fw = fws[0]
  manager.updateDayNight({ mode: 'schedule' }, local(20, 0))
  manager.syncDeviceTheme = () => { throw new Error('boom') }
  manager.createCommand(fw.deviceId, { type: 'screen.set', payload: { screen: 'wind' } })
  const got = fw.pollAndExecute()
  assert.ok(got.some((x) => x.command.type === 'screen.set'))
  assert.strictEqual(fw.screen, 'wind')
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
