// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// Demo harness: animated mock provider + trivial store + editor mount.
// Self-contained — no server, no SignalK required.

(function () {
  "use strict";

  // ── Animated mock provider ─────────────────────────────────────────────────
  // Implements DataProvider + LivePathSource.
  // Values update every 400ms with smooth sine variation.

  var TICK_MS = 400;

  var PATH_DEFS = [
    { path: "navigation.speedOverGround",          base: 5.2,  amp: 1.2,  freq: 1.0,  unit: "kn"    },
    { path: "environment.wind.speedApparent",      base: 12.4, amp: 3.0,  freq: 0.7,  unit: "kn"    },
    { path: "environment.wind.angleApparent",      base: 42,   amp: 18,   freq: 0.4,  unit: "deg"   },
    { path: "environment.depth.belowTransducer",   base: 8.5,  amp: 1.5,  freq: 0.3,  unit: "m"     },
    { path: "navigation.headingTrue",              base: 215,  amp: 12,   freq: 0.5,  unit: "deg"   },
    { path: "electrical.batteries.0.stateOfCharge",base: 0.82, amp: 0.06, freq: 0.15, unit: "ratio" },
  ];

  // Per-path phase offsets so they don't all peak at the same time.
  var PHASES = [0, 0.8, 1.6, 2.4, 3.2, 4.0];

  // Catalogue of known PathInfo entries (updated each tick).
  var catalogue = PATH_DEFS.map(function (d, i) {
    return {
      path: d.path,
      value: d.base,
      sourceUnit: d.unit,
      updatedAt: Date.now(),
      injected: false,
    };
  });

  // Session-level injected values: path → {value, sourceUnit}
  var injected = {};

  // Tick counter (used as time base for sine variation).
  var tick = 0;

  // Subscription registry: id → { paths: Set<string>, cb: fn }
  var subscribers = {};
  var nextSubId = 1;

  // onChange subscribers (DataTree catalogue updates).
  var changeListeners = [];

  function currentValue(pathDef, tickNow) {
    var phase = PHASES[PATH_DEFS.indexOf(pathDef)] || 0;
    var t = tickNow * (TICK_MS / 1000);
    return pathDef.base + pathDef.amp * Math.sin(2 * Math.PI * pathDef.freq * t + phase);
  }

  function runTick() {
    tick++;
    var now = Date.now();

    // Update catalogue values.
    catalogue = PATH_DEFS.map(function (d, i) {
      var inj = injected[d.path];
      if (inj) {
        return {
          path: d.path,
          value: inj.value,
          sourceUnit: inj.sourceUnit || d.unit,
          updatedAt: now,
          injected: true,
        };
      }
      return {
        path: d.path,
        value: currentValue(d, tick),
        sourceUnit: d.unit,
        updatedAt: now,
        injected: false,
      };
    });

    // Notify subscribe() listeners.
    Object.keys(subscribers).forEach(function (id) {
      var sub = subscribers[id];
      var relevant = false;
      catalogue.forEach(function (entry) {
        if (sub.paths.has(entry.path)) relevant = true;
      });
      // If paths is empty (subscribe([]) = subscribe to nothing), skip.
      if (relevant) {
        try { sub.cb(); } catch (e) { /* ignore */ }
      }
    });

    // Notify onChange() listeners (DataTree).
    changeListeners.forEach(function (cb) {
      try { cb(); } catch (e) { /* ignore */ }
    });
  }

  var intervalId = setInterval(runTick, TICK_MS);

  // ── DataProvider interface ─────────────────────────────────────────────────

  var provider = {

    // DataProvider.getValue(binding) → ResolvedValue
    getValue: function (binding) {
      if (!binding || binding.kind !== "signalk") {
        return { value: undefined, stale: false, present: false };
      }
      var path = binding.path;
      var inj = injected[path];
      if (inj) {
        return {
          value: inj.value,
          sourceUnit: inj.sourceUnit,
          updatedAt: Date.now(),
          stale: false,
          present: true,
        };
      }
      var def = null;
      for (var i = 0; i < PATH_DEFS.length; i++) {
        if (PATH_DEFS[i].path === path) { def = PATH_DEFS[i]; break; }
      }
      if (!def) return { value: undefined, stale: false, present: false };
      return {
        value: currentValue(def, tick),
        sourceUnit: def.unit,
        updatedAt: Date.now(),
        stale: false,
        present: true,
      };
    },

    // DataProvider.subscribe(paths, cb) → unsub
    subscribe: function (paths, cb) {
      var pathSet = new Set(paths);
      var id = nextSubId++;
      subscribers[id] = { paths: pathSet, cb: cb };
      return function () { delete subscribers[id]; };
    },

    // DataProvider.now() → number
    now: function () { return Date.now(); },

    // ── LivePathSource interface ───────────────────────────────────────────

    // LivePathSource.knownPaths() → PathInfo[]
    knownPaths: function () {
      return catalogue.slice();
    },

    // LivePathSource.inject(path, value, unit)
    inject: function (path, value, sourceUnit) {
      injected[path] = { value: value, sourceUnit: sourceUnit || undefined };
      // Also add to catalogue if not already there.
      var found = false;
      for (var i = 0; i < catalogue.length; i++) {
        if (catalogue[i].path === path) { found = true; break; }
      }
      if (!found) {
        catalogue.push({ path: path, value: value, sourceUnit: sourceUnit || undefined, updatedAt: Date.now(), injected: true });
      }
    },

    // LivePathSource.onChange(cb) → unsub
    onChange: function (cb) {
      changeListeners.push(cb);
      return function () {
        var idx = changeListeners.indexOf(cb);
        if (idx >= 0) changeListeners.splice(idx, 1);
      };
    },
  };

  // ── Manifest source ────────────────────────────────────────────────────────
  // square-480 capability manifest (mirrors midl/schemas/gen/…)

  var MANIFEST = {
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
      { type: "text",         bindings: ["value"], attrs: ["title", "size", "color"] },
      { type: "gauge",        bindings: ["value"], attrs: ["title", "size", "unit", "color", "range", "zones"] },
      { type: "bar",          bindings: ["value"], attrs: ["title", "size", "unit", "color", "range", "zones"] },
      { type: "compass",      bindings: ["value", "dir"], attrs: ["title", "size", "color"] },
      { type: "windrose",     bindings: ["value", "dir"], attrs: ["title", "format", "size", "unit", "color"] },
      { type: "trend",        bindings: ["value"], attrs: ["title", "size", "unit", "color"] },
      { type: "autopilot",    bindings: ["value"], attrs: ["title", "size", "color"] },
      { type: "button",       bindings: [], attrs: ["title", "size", "color"] },
    ],
    sources: ["signalk"],
    actionKinds: ["nav", "command"],
    presets: ["full", "hero-split"],
    themes: ["day", "night", "high-contrast"],
    fonts: [14, 20, 28, 48],
  };

  var manifestSource = {
    get: function () { return Promise.resolve(MANIFEST); },
  };

  // ── Starter MIDL document ──────────────────────────────────────────────────
  // A square-480 screen with a 2×2 grid and one single-value element bound
  // to navigation.speedOverGround pre-placed in cell 0.

  // A fully-populated 2×2 grid — all 4 cells have elements so validation passes.
  var STARTER_DOC = [
    "midl: 1.0.0",
    "meta:",
    "  title: Demo Dashboard",
    "  tags: [demo]",
    "screens:",
    "  - id: main",
    "    meta:",
    "      title: Demo",
    "    elements:",
    "      sog:",
    "        type: single-value",
    "        name: SOG",
    "        format: { unit: kn, decimals: 1 }",
    "        bindings:",
    "          value: { kind: signalk, path: navigation.speedOverGround }",
    "      wind:",
    "        type: single-value",
    "        name: TWS",
    "        format: { unit: kn, decimals: 1 }",
    "        bindings:",
    "          value: { kind: signalk, path: environment.wind.speedApparent }",
    "      depth:",
    "        type: single-value",
    "        name: Depth",
    "        format: { unit: m, decimals: 1 }",
    "        bindings:",
    "          value: { kind: signalk, path: environment.depth.belowTransducer }",
    "      hdg:",
    "        type: single-value",
    "        name: HDG",
    "        format: { unit: deg, decimals: 0 }",
    "        bindings:",
    "          value: { kind: signalk, path: navigation.headingTrue }",
    "    layout:",
    "      rows: 2",
    "      cols: 2",
    "      cells:",
    "        - element: sog",
    "        - element: wind",
    "        - element: depth",
    "        - element: hdg",
  ].join("\n");

  // ── Trivial store ──────────────────────────────────────────────────────────

  var store = {
    capabilities: "single",

    list: async function () { return []; },

    get: async function (id) {
      if (id === "demo") {
        return {
          ref: { id: "demo" },
          doc: STARTER_DOC,
          metadata: {},
        };
      }
      throw new Error("demo store: unknown id " + id);
    },

    save: async function (input) {
      console.log("[DEMO] SAVE called", input);
      return {
        ref: { id: "demo" },
        validation: { ok: true, issues: [] },
      };
    },

    remove: async function () { throw new Error("demo store: remove not supported"); },
    clone:  async function () { throw new Error("demo store: clone not supported"); },
  };

  // ── Mount ──────────────────────────────────────────────────────────────────

  var editorEl = document.getElementById("editor");

  if (!window.MidlEditor || typeof window.MidlEditor.mount !== "function") {
    editorEl.textContent = "ERROR: MidlEditor bundle did not load or has no mount().";
    return;
  }

  var unmount = window.MidlEditor.mount(editorEl, {
    store: store,
    provider: provider,
    manifest: manifestSource,
    initialId: "demo",
    targetClass: "square-480",
    onSaved: function (ref) {
      console.log("[DEMO] Saved:", ref);
    },
  });

  // Expose provider for Playwright inspection.
  window.__demoProvider = provider;
  window.__demoUnmount = unmount;

})();
