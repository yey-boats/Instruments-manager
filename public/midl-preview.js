// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// MIDL Instruments live demo. Renders the FULL standard dashboard library
// (/midl-library.json — every device-supported element type: single-value, text,
// gauge, bar, compass, windrose, trend, autopilot, button) with the shared,
// backend-free @yey-boats/midl-web device bundle (global `MidlWeb`).
//
// Live against the SignalK delta stream when reachable; sample-data fallback.

(function () {
  "use strict";

  // square-480 capability manifest (mirrors midl/schemas/gen/yb-midl-capabilities.square-480.json).
  const MANIFEST = {
    midl: "1.0.0", board: "esp32-4848s040", maxMarkersPerDial: 12,
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
    sources: ["signalk"], actionKinds: ["nav", "command"],
    presets: ["full", "hero-split"], themes: ["day", "night", "high-contrast"], fonts: [14, 20, 28, 48],
  };

  // Sample fallback values (SI source units, as SignalK delivers) for every path
  // bound across the standard library.
  const SAMPLES = {
    "navigation.speedOverGround": { value: 3.1, sourceUnit: "m/s" },
    "navigation.headingTrue": { value: 1.57, sourceUnit: "rad" },
    "navigation.courseOverGroundTrue": { value: 2.0, sourceUnit: "rad" },
    "navigation.courseGreatCircle.nextPoint.distance": { value: 4820, sourceUnit: "m" },
    "navigation.courseGreatCircle.nextPoint.bearingTrue": { value: 1.92, sourceUnit: "rad" },
    "navigation.courseGreatCircle.crossTrackError": { value: -12, sourceUnit: "m" },
    "navigation.state": { value: "sailing" },
    "environment.wind.speedApparent": { value: 6.2, sourceUnit: "m/s" },
    "environment.wind.angleApparent": { value: 0.6, sourceUnit: "rad" },
    "environment.depth.belowTransducer": { value: 18.3, sourceUnit: "m" },
    "performance.velocityMadeGood": { value: 2.4, sourceUnit: "m/s" },
    "propulsion.main.revolutions": { value: 30, sourceUnit: "Hz" },
    "propulsion.main.temperature": { value: 350, sourceUnit: "K" },
    "propulsion.main.oilPressure": { value: 350000, sourceUnit: "Pa" },
    "tanks.fuel.0.currentLevel": { value: 0.62, sourceUnit: "ratio" },
    "electrical.batteries.house.capacity.stateOfCharge": { value: 0.78, sourceUnit: "ratio" },
    "electrical.batteries.house.voltage": { value: 12.7, sourceUnit: "V" },
    "electrical.batteries.house.current": { value: 12.4, sourceUnit: "A" },
    "electrical.solar.0.panelPower": { value: 180, sourceUnit: "W" },
    "steering.autopilot.state": { value: "auto" },
  };

  const VIEWPORT = { x: 0, y: 0, w: 480, h: 480 };
  const STALE_MS = 10000, FALLBACK_MS = 3000;

  function SignalkDataProvider() {
    const values = Object.create(null), subs = new Set();
    this.hasData = false;
    this.now = function () { return Date.now(); };
    this.getValue = function (b) {
      if (b.kind === "const") return { value: b.value, stale: false, present: true };
      if (b.kind !== "signalk") return { value: undefined, stale: false, present: false };
      const v = values[b.path];
      if (!v) return { value: undefined, stale: false, present: false };
      return { value: v.value, sourceUnit: v.sourceUnit, updatedAt: v.updatedAt, present: true, stale: Date.now() - v.updatedAt > STALE_MS };
    };
    this.subscribe = function (paths, cb) { const e = { paths: new Set(paths), cb: cb }; subs.add(e); return function () { subs.delete(e); }; };
    this.ingest = function (path, value, unit, ts) {
      values[path] = { value: value, sourceUnit: unit, updatedAt: ts || Date.now() };
      this.hasData = true;
      let n = false; subs.forEach(function (s) { if (s.paths.has(path)) n = true; }); if (n) subs.forEach(function (s) { s.cb(); }); return n;
    };
  }

  const canvas = document.getElementById("cv"), ctx = canvas.getContext("2d");
  const dashSel = document.getElementById("dash");
  const statusEl = document.getElementById("status"), statusText = document.getElementById("statusText");
  const live = new SignalkDataProvider(), trends = new MidlWeb.TrendBuffers();
  let DASHBOARDS = [], current = null, ws = null, rafQueued = false, usingLive = false, fallbackTimer = null;

  function setStatus(k, t) { statusEl.className = "pill" + (k ? " " + k : ""); statusText.textContent = t; }
  function sampleFor(paths) { const s = {}; paths.forEach(function (p) { if (SAMPLES[p]) s[p] = SAMPLES[p]; }); return s; }

  function paint(provider) {
    const r = MidlWeb.renderDashboard(ctx, current.doc, MANIFEST, "square-480", VIEWPORT, provider, { trends: trends });
    if (!r.ok) {
      ctx.fillStyle = "#06090d"; ctx.fillRect(0, 0, 480, 480);
      ctx.fillStyle = "#f0c674"; ctx.font = "14px system-ui"; ctx.textAlign = "center";
      ctx.fillText("Invalid: " + (r.issues[0] && r.issues[0].message || "?"), 240, 240);
    }
  }
  function scheduleRender() {
    if (rafQueued) return; rafQueued = true;
    requestAnimationFrame(function () {
      rafQueued = false;
      if (live.hasData) { if (!usingLive) { usingLive = true; setStatus("live", "live · SignalK"); } paint(live); }
      else paint(current.mock);
    });
  }
  function closeWs() { if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; } }
  function connect() {
    closeWs();
    const url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/signalk/v1/stream?subscribe=none";
    let sock; try { sock = new WebSocket(url); } catch (e) { setStatus("sample", "sample data"); return; }
    ws = sock;
    sock.onopen = function () { if (sock !== ws) return; sock.send(JSON.stringify({ context: "vessels.self", subscribe: current.paths.map(function (p) { return { path: p, period: 1000, format: "delta", policy: "instant" }; }) })); };
    sock.onmessage = function (ev) {
      if (sock !== ws) return; let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.updates) return; let t = false;
      msg.updates.forEach(function (u) { const ts = u.timestamp ? Date.parse(u.timestamp) : Date.now(); (u.values || []).forEach(function (v) { if (v && typeof v.path === "string" && live.ingest(v.path, v.value, undefined, ts)) t = true; }); });
      if (t) scheduleRender();
    };
    sock.onerror = function () { if (sock === ws && !usingLive) setStatus("sample", "sample data"); };
    sock.onclose = function () { if (sock === ws && !usingLive) setStatus("sample", "sample data"); };
  }
  function load(idx) {
    const d = DASHBOARDS[idx]; if (!d) return;
    let paths = []; try { paths = MidlWeb.prepareDashboard(d.doc, MANIFEST, "square-480", VIEWPORT).paths || []; } catch (e) {}
    current = { doc: d.doc, paths: paths, mock: new MidlWeb.MockDataProvider(sampleFor(paths)) };
    usingLive = false; live.hasData = false; setStatus("", "connecting…"); paint(current.mock);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(function () { if (!live.hasData) setStatus("sample", "sample data"); }, FALLBACK_MS);
    connect();
  }

  if (!window.MidlWeb || typeof MidlWeb.renderDashboard !== "function") {
    setStatus("sample", "renderer failed to load");
    ctx.fillStyle = "#06090d"; ctx.fillRect(0, 0, 480, 480);
    ctx.fillStyle = "#f0c674"; ctx.font = "14px system-ui"; ctx.textAlign = "center";
    ctx.fillText("midl-device.global.js did not load", 240, 240);
    return;
  }
  dashSel.addEventListener("change", function () { load(parseInt(dashSel.value, 10)); });

  // Load the full standard library and populate the selector with every dashboard.
  fetch("midl-library.json").then(function (r) { return r.json(); }).then(function (lib) {
    DASHBOARDS = lib || [];
    dashSel.replaceChildren();
    DASHBOARDS.forEach(function (d, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = d.title || d.id; // safe DOM text, no innerHTML
      dashSel.appendChild(o);
    });
    load(0);
  }).catch(function () { setStatus("sample", "library failed to load"); });
})();
