// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// MIDL Instruments live demo. Renders a library MIDL dashboard against the
// SignalK delta stream using the shared, backend-free @yey-boats/midl-web
// device bundle (exposed as the global `MidlWeb` by midl-device.global.js).
//
// Replaces the bespoke public/live-preview.js rendering with the shared renderer.
// Data flow:
//   1. parse + solve the dashboard once (MidlWeb.collectBindings -> bound paths)
//   2. open ws(s)://<host>/signalk/v1/stream and subscribe to those paths
//   3. a SignalkDataProvider exposes the latest delta values to the renderer
//   4. re-render on each delta, coalesced into one paint per animation frame
//   5. if no live value arrives within ~3s, fall back to MockDataProvider sample
//      data so the demo always shows something. The UI shows live vs sample.

(function () {
  "use strict";

  // --- square-480 capability manifest (mirrors
  // midl/schemas/gen/yb-midl-capabilities.square-480.json): classes + elements +
  // sources:["signalk"]. A real device serves its own at /api/midl/manifest. ---
  const MANIFEST = {
    midl: "1.0.0",
    board: "esp32-4848s040",
    maxMarkersPerDial: 12,
    classes: [{
      id: "square-480", width: 480, height: 480, maxTiles: 4, maxDepth: 3,
      presets: ["full", "hero-split"],
      elements: ["single-value", "text", "gauge", "bar", "compass", "windrose", "trend", "autopilot", "button"],
    }],
    elements: [
      { type: "single-value", bindings: ["value"], attrs: ["title", "format", "size", "unit", "color"] },
      { type: "text", bindings: ["value"], attrs: ["title", "size", "color"] },
      { type: "gauge", bindings: ["value"], attrs: ["title", "size", "unit", "color", "range", "zones"] },
      { type: "bar", bindings: ["value"], attrs: ["title", "size", "unit", "color", "range", "zones"] },
      { type: "compass", bindings: ["value", "dir"], attrs: ["title", "size", "color"] },
      { type: "windrose", bindings: ["value", "dir"], attrs: ["title", "format", "size", "unit", "color"] },
      { type: "trend", bindings: ["value"], attrs: ["title", "size", "unit", "color"] },
      { type: "autopilot", bindings: ["value"], attrs: ["title", "size", "color"] },
      { type: "button", bindings: [], attrs: ["title", "size", "color"] },
    ],
    sources: ["signalk"],
    actionKinds: ["nav", "command"],
    presets: ["full", "hero-split"],
    themes: ["day", "night", "high-contrast"],
    fonts: [14, 20, 28, 48],
  };

  // --- Bundled standard layouts (inlined from midl/library/*.midl.yaml). ---
  const DASHBOARDS = {
    "wind-steering": {
      title: "Wind & Steering",
      doc: `midl: 1.0.0
meta:
  title: Wind & Steering
screens:
  - id: dash
    elements:
      wind:
        type: windrose
        name: WIND
        bindings:
          value: { kind: signalk, path: environment.wind.speedApparent }
          dir: { kind: signalk, path: environment.wind.angleApparent }
      sog:
        type: single-value
        name: SOG
        format: { unit: kn }
        bindings:
          value: { kind: signalk, path: navigation.speedOverGround }
      hdg:
        type: compass
        name: HDG
        bindings:
          value: { kind: signalk, path: navigation.headingTrue }
          dir: { kind: signalk, path: navigation.headingTrue }
    layout:
      flow: row
      children:
        - element: wind
        - flow: col
          children:
            - element: sog
            - element: hdg
`,
      // Sample fallback values (SI source units, as SignalK delivers).
      sample: {
        "environment.wind.speedApparent": { value: 6.2, sourceUnit: "m/s" },
        "environment.wind.angleApparent": { value: 0.6, sourceUnit: "rad" },
        "navigation.speedOverGround": { value: 3.1, sourceUnit: "m/s" },
        "navigation.headingTrue": { value: 1.57, sourceUnit: "rad" },
      },
    },
    "navigation": {
      title: "Navigation",
      doc: `midl: 1.0.0
meta:
  title: Navigation
screens:
  - id: nav
    elements:
      dtw:
        type: single-value
        name: DTW
        format: { unit: nm }
        bindings:
          value: { kind: signalk, path: navigation.courseGreatCircle.nextPoint.distance }
      btw:
        type: single-value
        name: BTW
        format: { unit: deg }
        bindings:
          value: { kind: signalk, path: navigation.courseGreatCircle.nextPoint.bearingTrue }
      cog:
        type: compass
        name: COG
        bindings:
          value: { kind: signalk, path: navigation.courseOverGroundTrue }
          dir: { kind: signalk, path: navigation.courseOverGroundTrue }
      xte:
        type: bar
        name: XTE
        format: { unit: m }
        bindings:
          value: { kind: signalk, path: navigation.courseGreatCircle.crossTrackError }
    layout:
      rows: 2
      cols: 2
      cells:
        - element: dtw
        - element: btw
        - element: cog
        - element: xte
`,
      sample: {
        "navigation.courseGreatCircle.nextPoint.distance": { value: 4820, sourceUnit: "m" },
        "navigation.courseGreatCircle.nextPoint.bearingTrue": { value: 1.92, sourceUnit: "rad" },
        "navigation.courseOverGroundTrue": { value: 2.0, sourceUnit: "rad" },
        "navigation.courseGreatCircle.crossTrackError": { value: -12, sourceUnit: "m" },
      },
    },
  };

  const VIEWPORT = { x: 0, y: 0, w: 480, h: 480 };
  const STALE_MS = 10000;     // freshness ceiling for live values
  const FALLBACK_MS = 3000;   // if no live value within this, show sample data

  // --- Live DataProvider backed by the latest SignalK delta values. Implements
  // the renderer's DataProvider interface: getValue, subscribe, now. ---
  function SignalkDataProvider() {
    const values = Object.create(null); // path -> { value, sourceUnit, updatedAt }
    const subs = new Set();             // { paths:Set, cb }
    this.hasData = false;

    this.now = function () { return Date.now(); };

    this.getValue = function (binding) {
      if (binding.kind === "const") return { value: binding.value, stale: false, present: true };
      if (binding.kind !== "signalk") return { value: undefined, stale: false, present: false };
      const v = values[binding.path];
      if (!v) return { value: undefined, stale: false, present: false };
      const stale = Date.now() - v.updatedAt > STALE_MS;
      return { value: v.value, sourceUnit: v.sourceUnit, updatedAt: v.updatedAt, present: true, stale: stale };
    };

    this.subscribe = function (paths, cb) {
      const entry = { paths: new Set(paths), cb: cb };
      subs.add(entry);
      return function () { subs.delete(entry); };
    };

    // Ingest one SignalK delta value update. Returns true if a subscribed path moved.
    this.ingest = function (path, value, sourceUnit, ts) {
      values[path] = { value: value, sourceUnit: sourceUnit, updatedAt: ts || Date.now() };
      this.hasData = true;
      let notify = false;
      subs.forEach(function (s) { if (s.paths.has(path)) notify = true; });
      if (notify) subs.forEach(function (s) { s.cb(); });
      return notify;
    };
  }

  // --- App state ---
  const canvas = document.getElementById("cv");
  const ctx = canvas.getContext("2d");
  const dashSel = document.getElementById("dash");
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("statusText");

  const live = new SignalkDataProvider();
  const trends = new MidlWeb.TrendBuffers();

  let current = null;       // { key, doc, paths, mock }
  let ws = null;
  let rafQueued = false;
  let usingLive = false;
  let fallbackTimer = null;

  function setStatus(kind, text) {
    statusEl.className = "pill" + (kind ? " " + kind : "");
    statusText.textContent = text;
  }

  function paint(provider) {
    const r = MidlWeb.renderDashboard(ctx, current.doc, MANIFEST, "square-480", VIEWPORT, provider, { trends: trends });
    if (!r.ok) {
      ctx.fillStyle = "#06090d"; ctx.fillRect(0, 0, 480, 480);
      ctx.fillStyle = "#f0c674"; ctx.font = "14px system-ui"; ctx.textAlign = "center";
      ctx.fillText("Invalid dashboard: " + (r.issues[0] && r.issues[0].message || "?"), 240, 240);
    }
  }

  function scheduleRender() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(function () {
      rafQueued = false;
      // Once any live value has arrived, drive the renderer from live data.
      if (live.hasData) {
        if (!usingLive) { usingLive = true; setStatus("live", "live · SignalK"); }
        paint(live);
      } else {
        paint(current.mock);
      }
    });
  }

  function closeWs() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
  }

  function connect() {
    closeWs();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/signalk/v1/stream?subscribe=none";
    let sock;
    try { sock = new WebSocket(url); } catch (e) { setStatus("sample", "sample data"); return; }
    ws = sock;

    sock.onopen = function () {
      if (sock !== ws) return;
      // Subscribe to exactly the paths this dashboard binds, under vessels.self.
      sock.send(JSON.stringify({
        context: "vessels.self",
        subscribe: current.paths.map(function (p) {
          return { path: p, period: 1000, format: "delta", policy: "instant" };
        }),
      }));
    };

    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.updates) return;
      let touched = false;
      msg.updates.forEach(function (u) {
        const ts = u.timestamp ? Date.parse(u.timestamp) : Date.now();
        (u.values || []).forEach(function (v) {
          if (!v || typeof v.path !== "string") return;
          if (live.ingest(v.path, v.value, undefined, ts)) touched = true;
        });
      });
      if (touched) scheduleRender();
    };

    sock.onerror = function () { if (sock === ws) setStatus(usingLive ? "live" : "sample", usingLive ? "live · SignalK" : "sample data"); };
    sock.onclose = function () {
      if (sock !== ws) return;
      if (!usingLive) setStatus("sample", "sample data");
    };
  }

  function load(key) {
    const d = DASHBOARDS[key];
    if (!d) return;
    // Solve once to collect the bound SignalK paths for this dashboard.
    let paths = [];
    try {
      const prep = MidlWeb.prepareDashboard(d.doc, MANIFEST, "square-480", VIEWPORT);
      paths = prep.paths || [];
    } catch (e) { paths = []; }
    current = { key: key, doc: d.doc, paths: paths, mock: new MidlWeb.MockDataProvider(d.sample) };

    usingLive = false;
    live.hasData = false;
    setStatus("", "connecting…");

    // Show sample immediately so the canvas is never blank.
    paint(current.mock);

    // Fall back to sample data if no live value arrives in time.
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(function () {
      if (!live.hasData) setStatus("sample", "sample data");
    }, FALLBACK_MS);

    connect();
  }

  dashSel.addEventListener("change", function () { load(dashSel.value); });

  if (!window.MidlWeb || typeof MidlWeb.renderDashboard !== "function") {
    setStatus("sample", "renderer failed to load");
    ctx.fillStyle = "#06090d"; ctx.fillRect(0, 0, 480, 480);
    ctx.fillStyle = "#f0c674"; ctx.font = "14px system-ui"; ctx.textAlign = "center";
    ctx.fillText("midl-device.global.js did not load", 240, 240);
  } else {
    load(dashSel.value);
  }
})();
