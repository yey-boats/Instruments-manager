// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// Trend backfill from the SignalK History API (midl
// docs/specs/2026-11-15-trend-history.md §4), shared by the Display Manager
// pages that draw MIDL trends (device preview, MIDL demo, editor). It is the
// optional `DataProvider.history(path, {window_s, step_s, agg})` of
// @yey-boats/midl-web:
//
//   GET /signalk/v2/api/history/values?paths=<path>:<method>&duration=PT<window>S&resolution=<step>
//
// method = average|min|max|last for agg avg|min|max|last; resolution is a
// number of seconds (the server also takes '5s'/'1m' but rejects anything
// else with 400). The pages are served by the SignalK server, so the request
// is same-origin with the session cookie. Response
// {"data": [["<ISO time>", <value>], ...]} -> [[epoch ms, value], ...].
// No provider (404/501), a validation error, a network error or empty data
// all resolve [] (the chart starts empty and fills live).
(function (root) {
  'use strict'

  const BASE = '/signalk/v2/api/history/values'
  const METHODS = { avg: 'average', min: 'min', max: 'max', last: 'last' }
  // A SignalK path: dot-separated segments of letters, digits, _ and -.
  const PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/
  const TIMEOUT_MS = 10000

  function methodFor (agg) {
    return METHODS[agg] || METHODS.avg
  }

  // The request URL for one series, or null when the request is not valid
  // (bad path, no window). Seconds are rounded: duration to whole seconds,
  // resolution to milliseconds (step = window / points is often fractional).
  function historyUrl (path, req) {
    if (typeof path !== 'string' || !PATH_RE.test(path)) return null
    const r = req || {}
    const windowS = Math.round(Number(r.window_s))
    if (!Number.isFinite(windowS) || windowS <= 0) return null
    let stepS = Number(r.step_s)
    if (!Number.isFinite(stepS) || stepS <= 0) stepS = windowS / 120
    stepS = Math.max(0.001, Math.round(stepS * 1000) / 1000)
    return BASE + '?paths=' + path + ':' + methodFor(r.agg) +
      '&duration=PT' + windowS + 'S&resolution=' + stepS
  }

  // History API body -> [[epoch ms, number], ...]; rows without a parseable
  // time or a finite number are skipped.
  function parseRows (body) {
    const data = body && Array.isArray(body.data) ? body.data : []
    const out = []
    for (const row of data) {
      if (!Array.isArray(row) || row.length < 2) continue
      const t = typeof row[0] === 'number' ? row[0] : Date.parse(row[0])
      const v = row[1]
      if (!Number.isFinite(t) || typeof v !== 'number' || !Number.isFinite(v)) continue
      out.push([t, v])
    }
    return out
  }

  // A DataProvider.history() over `fetchImpl` (default: the page's fetch).
  function createHistory (fetchImpl) {
    return function history (path, req) {
      const f = fetchImpl || (typeof fetch === 'function' ? fetch : null)
      const url = historyUrl(path, req)
      if (!f || !url) return Promise.resolve([])
      let timer = null
      const opts = { credentials: 'include', headers: { accept: 'application/json' } }
      if (typeof AbortController === 'function') {
        const ac = new AbortController()
        opts.signal = ac.signal
        timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
      }
      return Promise.resolve()
        .then(() => f(url, opts))
        .then((res) => (res && res.ok ? res.json() : null))
        .then(parseRows)
        .catch(() => [])
        .finally(() => { if (timer) clearTimeout(timer) })
    }
  }

  const api = { historyUrl, parseRows, createHistory, methodFor, history: createHistory() }
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.YeySignalkHistory = api
}(typeof window !== 'undefined' ? window : null))
