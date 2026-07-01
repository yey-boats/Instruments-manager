// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// MIDL dashboard editor page. Mounts the shared window.MidlEditor as a GENERIC
// editor (device-independent authoring, identical to the web-shell). The device
// <select> is ONLY the push destination: Save pushes the authored MIDL to the
// selected device via POST /devices/:id/editor/midl (which queues a config.reload
// the device pulls). Live SignalK deltas drive the preview via the shared
// createSignalKProvider from @yey-boats/midl-editor (window.MidlEditor).

(function () {
  "use strict";

  const API = "/plugins/yey-boats-display-manager";

  // --- square-480 capability manifest (mirrors midl/schemas/gen/…) ---
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

  const manifestSource = { get: async function () { return MANIFEST; } };

  // --- Live DataProvider via the shared createSignalKProvider ---
  // paths:"all" subscribes to all vessels.self deltas so any path bound in
  // the current editor dashboard receives live updates without re-subscribing
  // on each edit. The provider sends the subscribe message on open AND on
  // keepalive re-subscribe every 25 s — the exact fix for the old "never
  // connects" bug where the socket was opened but no subscribe was sent.
  const provider = window.MidlEditor.createSignalKProvider({ paths: "all" });

  // --- DOM ---
  const deviceSel = document.getElementById("deviceSel");
  const editorEl = document.getElementById("editor");
  const pushedNote = document.getElementById("pushedNote");

  // Device is the PUSH DESTINATION only — not the edit source.
  let pushTargetId = "";

  fetch(API + "/devices/summary", { credentials: "include" })
    .then(function (r) { return r.ok ? r.json() : { devices: [] }; })
    .then(function (j) {
      const devices = (j.devices || j || []);
      devices.forEach(function (d) {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = (d.name || d.id) + (d.online === false ? " (offline)" : "");
        deviceSel.appendChild(opt);
      });
      if (deviceSel.value) pushTargetId = deviceSel.value;
    })
    .catch(function () {});

  deviceSel.addEventListener("change", function () { pushTargetId = deviceSel.value; });

  // --- Push-to-device diff/confirm modal ---
  //
  // showPushModal(deviceId, diff, proposed, expectedRevision) → Promise
  //   Resolves with { ref, validation } when the user clicks "Push Now".
  //   Rejects (no-op) when the user cancels.
  //   expectedRevision (optional): the device config revision the editor loaded;
  //   sent so the server can reject a concurrent clobber (revision_conflict).
  //
  // DOM construction strategy: all structure is built with createElement +
  // textContent so no user-controlled string ever touches innerHTML. The only
  // innerHTML assignment is the static <style> block (no interpolation) and
  // the SVG success icon (static markup, no user data).
  function showPushModal(deviceId, diff, proposed, expectedRevision) {
    return new Promise(function (resolve, reject) {

      // --- DOM helpers (no innerHTML for user data) ---
      function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      }
      function ap(parent) {
        var children = Array.prototype.slice.call(arguments, 1);
        children.forEach(function (c) { if (c) parent.appendChild(c); });
        return parent;
      }

      var n = diff.added.length + diff.removed.length + diff.changed.length;

      // Build diff rows entirely with DOM nodes
      function buildDiffList() {
        var list = el("div", "midl-diff-list");

        diff.added.forEach(function (id) {
          var row = el("div", "midl-diff-row");
          var top = el("div", "midl-diff-row-top");
          ap(top,
            el("div", "midl-diff-indicator midl-diff-added"),
            el("span", "midl-diff-op midl-diff-op-added", "+ " + id),
            el("span", "midl-diff-path", "(new element)")
          );
          ap(row, top);
          list.appendChild(row);
        });

        diff.removed.forEach(function (id) {
          var row = el("div", "midl-diff-row");
          var top = el("div", "midl-diff-row-top");
          ap(top,
            el("div", "midl-diff-indicator midl-diff-removed"),
            el("span", "midl-diff-op midl-diff-op-removed", "- " + id),
            el("span", "midl-diff-path", "(removed)")
          );
          ap(row, top);
          list.appendChild(row);
        });

        diff.changed.forEach(function (c) {
          var row = el("div", "midl-diff-row");
          var top = el("div", "midl-diff-row-top");
          ap(top,
            el("div", "midl-diff-indicator midl-diff-changed"),
            el("span", "midl-diff-op midl-diff-op-changed", "~ " + c.id),
            el("span", "midl-diff-path", c.field)
          );
          var detail = el("div", "midl-diff-row-detail",
            (c.was || "(empty)") + " → " + (c.now || "(empty)"));
          ap(row, top, detail);
          list.appendChild(row);
        });

        if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
          var none = el("div", null, "No changes detected.");
          none.style.cssText = "color:var(--midl-ink-faint);font-size:11px;padding:8px 0;";
          list.appendChild(none);
        }

        return list;
      }

      // --- Static styles (no user data interpolated) ---
      var styleEl = document.createElement("style");
      styleEl.textContent = [
        ":root{",
        "--midl-bg:#0a121c;--midl-surface:#0e1825;--midl-surface2:#0c1521;",
        "--midl-elev:#12202f;--midl-line:#1d2b3a;--midl-line2:#24364a;",
        "--midl-ink:#cbd6e2;--midl-ink-dim:#8aa0b4;--midl-ink-faint:#5b7286;",
        "--midl-ink-bright:#eef4fb;--midl-accent:#57c7d8;",
        "--midl-online:oklch(0.72 0.15 155);--midl-drift:oklch(0.80 0.13 75);",
        "--midl-danger:oklch(0.64 0.19 25);}",
        ".midl-modal{background:var(--midl-surface);border:1px solid var(--midl-line);",
        "border-radius:14px;width:480px;max-width:96vw;overflow:hidden;",
        "box-shadow:0 24px 64px rgba(0,0,0,0.55);}",
        ".midl-modal-header{padding:18px 20px 14px;border-bottom:1px solid var(--midl-line);}",
        ".midl-modal-title{font-size:16px;font-weight:700;color:var(--midl-ink-bright);letter-spacing:-0.01em;}",
        ".midl-modal-sub{font-size:11px;font-family:'JetBrains Mono',monospace;",
        "color:var(--midl-ink-faint);margin-top:4px;}",
        ".midl-modal-body{padding:16px 20px;display:flex;flex-direction:column;gap:10px;",
        "max-height:320px;overflow-y:auto;}",
        ".midl-diff-summary-badge{display:inline-flex;align-items:center;gap:4px;",
        "padding:3px 12px;border-radius:20px;font-size:11px;font-weight:600;}",
        ".midl-diff-list{display:flex;flex-direction:column;gap:3px;}",
        ".midl-diff-row{display:flex;flex-direction:column;gap:2px;padding:7px 9px;",
        "border-radius:6px;background:var(--midl-surface2);border:1px solid var(--midl-line);}",
        ".midl-diff-row-top{display:flex;align-items:center;gap:7px;}",
        ".midl-diff-indicator{width:8px;height:8px;border-radius:2px;flex-shrink:0;}",
        ".midl-diff-added{background:var(--midl-online);}",
        ".midl-diff-removed{background:var(--midl-danger);}",
        ".midl-diff-changed{background:var(--midl-drift);}",
        ".midl-diff-op{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;flex-shrink:0;}",
        ".midl-diff-op-added{color:var(--midl-online);}",
        ".midl-diff-op-removed{color:var(--midl-danger);}",
        ".midl-diff-op-changed{color:var(--midl-drift);}",
        ".midl-diff-path{font-family:'JetBrains Mono',monospace;font-size:10px;",
        "color:var(--midl-ink-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}",
        ".midl-diff-row-detail{font-size:10px;color:var(--midl-ink-faint);",
        "font-family:'JetBrains Mono',monospace;padding-left:15px;}",
        ".midl-modal-footer{padding:14px 20px;border-top:1px solid var(--midl-line);",
        "display:flex;gap:8px;justify-content:flex-end;}",
        ".midl-btn-cancel{padding:8px 16px;background:transparent;color:var(--midl-ink-dim);",
        "border:1px solid var(--midl-line2);border-radius:8px;font-family:'Montserrat',sans-serif;",
        "font-size:12px;font-weight:600;cursor:pointer;}",
        ".midl-btn-push{display:flex;align-items:center;gap:6px;padding:8px 18px;",
        "background:var(--midl-accent);color:#071018;border:none;border-radius:8px;",
        "font-family:'Montserrat',sans-serif;font-size:12px;font-weight:700;cursor:pointer;",
        "letter-spacing:0.03em;box-shadow:0 0 14px color-mix(in srgb,var(--midl-accent) 35%,transparent);}",
        ".midl-success-body{display:flex;flex-direction:column;align-items:center;",
        "justify-content:center;gap:10px;padding:32px 20px;text-align:center;}",
        ".midl-success-heading{font-size:22px;font-weight:700;color:var(--midl-ink-bright);letter-spacing:-0.02em;}",
        ".midl-success-sub{font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--midl-ink-dim);}"
      ].join("");

      // --- Build overlay + modal skeleton entirely with DOM methods ---
      var overlay = document.createElement("div");
      overlay.style.cssText = [
        "position:fixed;inset:0;z-index:9999",
        "background:rgba(10,18,28,0.82)",
        "display:flex;align-items:center;justify-content:center",
        "font-family:'Montserrat',sans-serif"
      ].join(";");

      // Header
      var titleNode = el("div", "midl-modal-title");
      // "Review Changes · Pushing to <deviceId>" — built as text nodes so
      // deviceId never touches innerHTML
      titleNode.appendChild(document.createTextNode("Review Changes · Pushing to "));
      titleNode.appendChild(document.createTextNode(deviceId));
      var subNode = el("div", "midl-modal-sub");
      subNode.appendChild(document.createTextNode("Destination: "));
      subNode.appendChild(document.createTextNode(deviceId));
      var header = ap(el("div", "midl-modal-header"), titleNode, subNode);

      // Badge
      var badgeIsChanged = n > 0;
      var badgeColor = badgeIsChanged ? "var(--midl-drift)" : "var(--midl-ink-faint)";
      var badge = el("span", "midl-diff-summary-badge",
        n + " tile" + (n !== 1 ? "s" : "") + " change" + (n !== 1 ? "s" : ""));
      badge.style.cssText = [
        "background:color-mix(in srgb," + badgeColor + " 12%,var(--midl-surface2))",
        "color:" + badgeColor,
        "border:1px solid color-mix(in srgb," + badgeColor + " 30%,transparent)"
      ].join(";");

      // Body
      var diffList = buildDiffList();
      var body = ap(el("div", "midl-modal-body"),
        ap(el("div"), badge),
        diffList
      );
      body.id = "midl-modal-body";

      // Footer buttons
      var cancelBtn = el("button", "midl-btn-cancel", "Cancel");
      cancelBtn.id = "midl-btn-cancel";
      var pushBtn = el("button", "midl-btn-push", "Push Now ↑");
      pushBtn.id = "midl-btn-push";
      var footer = ap(el("div", "midl-modal-footer"), cancelBtn, pushBtn);
      footer.id = "midl-modal-footer";

      // Modal card
      var modal = ap(el("div", "midl-modal"), styleEl, header, body, footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // --- Actions ---
      function dismiss() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }

      function showSuccess() {
        // Rebuild body with success state using DOM methods; the only
        // innerHTML here is the static SVG icon (no user data).
        var successBody = el("div", "midl-success-body");

        // Static SVG checkmark — no user data
        var svgWrap = document.createElement("div");
        svgWrap.innerHTML = '<svg width="52" height="52" viewBox="0 0 52 52" fill="none">' +
          '<circle cx="26" cy="26" r="24" stroke="var(--midl-online)" stroke-width="2" opacity="0.3"/>' +
          '<circle cx="26" cy="26" r="20" fill="color-mix(in srgb,var(--midl-online) 12%,transparent)" stroke="var(--midl-online)" stroke-width="1.5"/>' +
          '<path d="M16 27l7 7 13-15" stroke="var(--midl-online)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
          '</svg>';
        successBody.appendChild(svgWrap.firstChild);

        ap(successBody,
          el("div", "midl-success-heading", "Pushed!"),
          el("div", "midl-success-sub", deviceId + " pulled config")
        );

        body.style.maxHeight = "none";
        while (body.firstChild) body.removeChild(body.firstChild);
        body.appendChild(successBody);
        while (footer.firstChild) footer.removeChild(footer.firstChild);

        setTimeout(dismiss, 2500);
      }

      cancelBtn.addEventListener("click", function () {
        dismiss();
        reject(new Error("Push cancelled"));
      });

      pushBtn.addEventListener("click", async function () {
        pushBtn.disabled = true;
        pushBtn.textContent = "Pushing…";
        cancelBtn.disabled = true;
        try {
          var postBody = { doc: proposed };
          if (expectedRevision != null && expectedRevision !== "") {
            postBody.expectedRevision = expectedRevision;
          }
          var r = await fetch(API + "/devices/" + encodeURIComponent(deviceId) + "/editor/midl", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(postBody)
          });
          if (r.status === 409) {
            // Optimistic-concurrency conflict: another editor changed the device
            // config since we loaded it. Do not clobber — tell the user to reload.
            var cj = null;
            try { cj = await r.json(); } catch (e) { cj = null; }
            var cmsg = (cj && cj.error && cj.error.message) ||
              "device config changed since you loaded it; close and reopen the editor to reload, then retry";
            throw new Error(cmsg);
          }
          if (!r.ok) throw new Error("Push failed (HTTP " + r.status + ")");
          showSuccess();
          resolve({ ref: { id: deviceId }, validation: { ok: true, issues: [] } });
        } catch (err) {
          pushBtn.disabled = false;
          pushBtn.textContent = "Push Now ↑";
          cancelBtn.disabled = false;
          var errEl = body.querySelector(".midl-push-error");
          if (!errEl) {
            errEl = el("div", "midl-push-error");
            errEl.style.cssText = "color:var(--midl-danger);font-size:11px;font-weight:600;margin-top:4px;";
            body.appendChild(errEl);
          }
          errEl.textContent = err.message;
        }
      });
    });
  }

  // Generic store: editing is device-independent. save() shows a diff/confirm
  // modal then PUSHES the authored MIDL to the selected destination device.
  const store = {
    capabilities: "single",
    list: async function () { return []; },
    get: async function () { throw new Error("generic editor: nothing to preload"); },
    save: async function (input) {
      if (!pushTargetId) throw new Error("Select a destination device to push to.");
      const proposed = window.MidlEditor.parseDoc(input.source);
      // Fetch current device config for diff (404 or empty → treat as blank).
      // Capture the revision so the push can carry expectedRevision for
      // optimistic concurrency (reject a concurrent clobber).
      let currentDoc = null;
      let currentRevision = null;
      try {
        const gr = await fetch(API + "/devices/" + encodeURIComponent(pushTargetId) + "/editor/midl", {
          credentials: "include"
        });
        if (gr.ok) {
          const j = await gr.json();
          if (j && j.doc) {
            try { currentDoc = JSON.parse(j.doc); } catch (e) { currentDoc = null; }
          }
          if (j && j.revision != null) currentRevision = j.revision;
        }
        // 404 or empty → currentDoc stays null (everything shows as added)
      } catch (e) { currentDoc = null; }

      const diff = window.MidlDiff
        ? window.MidlDiff.diffDashboards(currentDoc, proposed)
        : { added: [], removed: [], changed: [] };

      // Show the diff/confirm modal; resolves on Push Now, rejects on Cancel
      return showPushModal(pushTargetId, diff, proposed, currentRevision);
    },
    remove: async function () { throw new Error("not supported"); },
    clone: async function () { throw new Error("not supported"); }
  };

  if (!window.MidlEditor || typeof window.MidlEditor.mount !== "function") {
    editorEl.textContent = "MidlEditor bundle did not load.";
    return;
  }

  // Mount once, generically (no initialId => blank dashboard to author).
  window.MidlEditor.mount(editorEl, {
    store: store,
    provider: provider,
    manifest: manifestSource,
    targetClass: "square-480",
    onSaved: function () {
      pushedNote.classList.remove("hidden");
      setTimeout(function () { pushedNote.classList.add("hidden"); }, 3000);
    }
  });
})();
