'use strict'

// Trend backfill from the SignalK History API (midl
// docs/specs/2026-11-15-trend-history.md §4): public/signalk-history.js is the
// DataProvider.history() the Display Manager pages hand the MIDL renderer.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const H = require('../public/signalk-history')

const PUBLIC = path.join(__dirname, '..', 'public')

function fakeFetch (reply) {
  const calls = []
  const f = (url, opts) => {
    calls.push({ url, opts })
    return typeof reply === 'function' ? reply(url, opts) : Promise.resolve(reply)
  }
  f.calls = calls
  return f
}
const ok = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) })
const status = (code) => ({ ok: false, status: code, json: () => Promise.resolve({ error: 'x' }) })

test('URL: paths=<path>:<method>, duration=PT<window>S, resolution=<step seconds>', () => {
  assert.strictEqual(H.historyUrl('environment.wind.speedTrue', { window_s: 600, step_s: 5, agg: 'avg' }),
    '/signalk/v2/api/history/values?paths=environment.wind.speedTrue:average&duration=PT600S&resolution=5')
  // 10m over 90 points (round-360): fractional step, kept to the millisecond
  assert.strictEqual(H.historyUrl('navigation.speedOverGround', { window_s: 600, step_s: 600 / 90, agg: 'max' }),
    '/signalk/v2/api/history/values?paths=navigation.speedOverGround:max&duration=PT600S&resolution=6.667')
  assert.strictEqual(H.historyUrl('a.b', { window_s: 86400, step_s: 720, agg: 'last' }),
    '/signalk/v2/api/history/values?paths=a.b:last&duration=PT86400S&resolution=720')
  // no step: window / 120
  assert.match(H.historyUrl('a.b', { window_s: 600, agg: 'min' }), /paths=a\.b:min&duration=PT600S&resolution=5$/)
})

test('agg maps avg->average, min, max, last; unknown -> average', () => {
  assert.strictEqual(H.methodFor('avg'), 'average')
  assert.strictEqual(H.methodFor('min'), 'min')
  assert.strictEqual(H.methodFor('max'), 'max')
  assert.strictEqual(H.methodFor('last'), 'last')
  assert.strictEqual(H.methodFor(undefined), 'average')
  assert.strictEqual(H.methodFor('sma'), 'average')
})

test('no request for a bad path or window', () => {
  assert.strictEqual(H.historyUrl('', { window_s: 600 }), null)
  assert.strictEqual(H.historyUrl('a.b&paths=x', { window_s: 600 }), null)
  assert.strictEqual(H.historyUrl('a..b', { window_s: 600 }), null)
  assert.strictEqual(H.historyUrl(undefined, { window_s: 600 }), null)
  assert.strictEqual(H.historyUrl('a.b', { window_s: 0 }), null)
  assert.strictEqual(H.historyUrl('a.b', {}), null)
})

test('response rows -> [[epoch ms, value]]; bad rows skipped', () => {
  const rows = H.parseRows({
    context: 'vessels.self',
    data: [
      ['2026-11-15T20:00:00.000Z', 3.2],
      ['2026-11-15T20:00:05.000Z', null],
      ['not a time', 1],
      ['2026-11-15T20:00:10.000Z', 'x'],
      [1763236815000, 4],
      'junk',
      ['2026-11-15T20:00:15.000Z', 3.4, 9]
    ]
  })
  assert.deepStrictEqual(rows, [
    [Date.parse('2026-11-15T20:00:00.000Z'), 3.2],
    [1763236815000, 4],
    [Date.parse('2026-11-15T20:00:15.000Z'), 3.4]
  ])
  assert.deepStrictEqual(H.parseRows({ data: [] }), [])
  assert.deepStrictEqual(H.parseRows(null), [])
  assert.deepStrictEqual(H.parseRows({ error: 'x' }), [])
})

test('history() fetches same-origin with credentials and parses the data', async () => {
  const f = fakeFetch(ok({ data: [['2026-11-15T20:00:00Z', 1.5]] }))
  const rows = await H.createHistory(f)('environment.depth.belowTransducer', { window_s: 1800, step_s: 15, agg: 'min' })
  assert.deepStrictEqual(rows, [[Date.parse('2026-11-15T20:00:00Z'), 1.5]])
  assert.strictEqual(f.calls.length, 1)
  assert.strictEqual(f.calls[0].url,
    '/signalk/v2/api/history/values?paths=environment.depth.belowTransducer:min&duration=PT1800S&resolution=15')
  assert.strictEqual(f.calls[0].opts.credentials, 'include')
})

test('history() resolves [] on 404/501/400, network error, bad JSON or empty data', async () => {
  const req = { window_s: 600, step_s: 5, agg: 'avg' }
  for (const reply of [
    status(404), status(501), status(400), status(401),
    () => Promise.reject(new Error('offline')),
    () => { throw new Error('sync throw') },
    { ok: true, json: () => Promise.reject(new SyntaxError('bad json')) },
    ok({ data: [] }), ok({}), null
  ]) {
    assert.deepStrictEqual(await H.createHistory(fakeFetch(reply))('a.b', req), [])
  }
  const f = fakeFetch(ok({ data: [['2026-11-15T20:00:00Z', 1]] }))
  assert.deepStrictEqual(await H.createHistory(f)('bad path', req), [], 'invalid path: no request')
  assert.strictEqual(f.calls.length, 0)
})

// End to end in the device bundle: the device preview's provider carries
// history(), the store backfills the series once and the SVG draws the chart.
test('device preview: backfilled trend draws a chart; one store per screen', async () => {
  const ctx = { console, TextEncoder, TextDecoder, setTimeout, clearTimeout, window: { __yeyboatsPreview: {} } }
  ctx.window.window = ctx.window
  ctx.document = { getElementById: () => null }
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'midl-device.global.js'), 'utf8') + '\nwindow.MidlWeb = MidlWeb;', ctx)
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'device-preview.js'), 'utf8'), ctx)
  const DP = ctx.window.YeyDevicePreview
  const W = ctx.window.MidlWeb
  assert.strictEqual(typeof W.HistoryStore, 'function', 'bundle exports HistoryStore')

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'midl', 'schemas', 'gen', 'yb-midl-capabilities.square-480.json'), 'utf8'))
  const doc = {
    midl: '1.0.0',
    screens: [{
      id: 'wind',
      elements: {
        tws: { type: 'trend', name: 'TWS', format: { unit: 'kn', decimals: 1 }, history: { window: '10m', agg: 'max' }, bindings: { value: { kind: 'signalk', path: 'environment.wind.speedTrue' } } }
      },
      layout: { rows: 1, cols: 1, cells: [{ element: 'tws' }] }
    }]
  }
  assert.strictEqual(DP.hasTrend(doc), true)
  assert.strictEqual(DP.hasTrend({ screens: [{ elements: { a: { type: 'text' } } }] }), false)
  assert.strictEqual(DP.hasTrend(null), false)

  const now = Date.now()
  const calls = []
  const history = (p, req) => {
    calls.push([p, req])
    return Promise.resolve([[now - 60000, 5], [now - 30000, 6], [now - 10000, 7]])
  }
  // (the renderer draws a no-data placeholder, and asks for no backfill, until
  // the path has a live value)
  const provider = DP.makeProvider({ 'environment.wind.speedTrue': 3.5 }, { 'environment.wind.speedTrue': now }, {}, history)
  assert.strictEqual(typeof provider.history, 'function')
  assert.strictEqual(DP.makeProvider({}, {}, {}).history, undefined, 'no backfill without a history function')

  let updates = 0
  const store = new W.HistoryStore({ onUpdate: () => { updates++ } })
  const draw = () => W.renderDashboardSvg(JSON.stringify(doc), manifest, 'square-480', { x: 0, y: 0, w: 480, h: 480 }, provider, { trends: store })
  let r = draw()
  assert.ok(r.ok, JSON.stringify(r.issues))
  const points = (svg) => (svg.match(/<polyline points="([^"]*)"/g) || []).reduce((n, m) => n + m.split(' ').length - 1, 0)
  const before = points(r.svg)
  assert.ok(before <= 2, 'only the live bucket before the backfill lands')
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(calls.length, 1, 'backfill requested on the first paint')
  assert.strictEqual(updates, 1, 'the backfill asked for a repaint')
  r = draw()
  draw()
  assert.ok(points(r.svg) > before, 'backfilled buckets drawn')
  assert.strictEqual(calls.length, 1, 'one backfill per series per store')
  assert.strictEqual(calls[0][0], 'environment.wind.speedTrue')
  assert.strictEqual(calls[0][1].window_s, 600)
  assert.strictEqual(calls[0][1].step_s, 5)
  assert.strictEqual(calls[0][1].agg, 'max')
  assert.strictEqual(H.historyUrl(calls[0][0], calls[0][1]),
    '/signalk/v2/api/history/values?paths=environment.wind.speedTrue:max&duration=PT600S&resolution=5')

  const src = fs.readFileSync(path.join(PUBLIC, 'device-preview.js'), 'utf8')
  assert.ok(!src.includes('trendsByScreen'), 'no store kept per screen forever')
  assert.match(src, /trendScreenId !== scr\.id/, 'a new store when the screen changes')
})

test('the pages load signalk-history.js before their glue', () => {
  for (const [page, glue] of [['midl-preview.html', 'midl-preview.js'], ['midl-editor.html', 'midl-editor.js']]) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8')
    const h = html.indexOf('./signalk-history.js')
    assert.ok(h >= 0, `${page} loads signalk-history.js`)
    assert.ok(html.indexOf(`./${glue}`) > h, `${page}: before ${glue}`)
  }
})
