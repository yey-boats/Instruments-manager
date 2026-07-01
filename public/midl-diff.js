// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// Dependency-free MIDL dashboard diff utility.
// Exposes window.MidlDiff with diffDashboards(currentDoc, proposedDoc).
// Compares screens[0] elements keyed by id + layout cells.
// Returns { added:[], removed:[], changed:[{ id, field, was, now }] }

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.MidlDiff = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Extract a flat map of element-id -> element descriptor from a MIDL doc.
  // Only looks at screens[0]. Returns {} for empty/missing docs.
  function extractElements(doc) {
    if (!doc || !Array.isArray(doc.screens) || !doc.screens[0]) return {};
    var screen = doc.screens[0];
    var elements = screen.elements || {};
    var out = {};
    Object.keys(elements).forEach(function (id) {
      var el = elements[id] || {};
      out[id] = {
        type: el.type || '',
        path: (el.bindings && el.bindings.value && el.bindings.value.path) || '',
        unit: (el.format && el.format.unit) || '',
        label: el.name || ''
      };
    });
    return out;
  }

  // Extract ordered list of cell element-ids from screens[0].layout.cells.
  // Used to detect layout-cell-level additions and removals.
  function extractCells(doc) {
    if (!doc || !Array.isArray(doc.screens) || !doc.screens[0]) return [];
    var screen = doc.screens[0];
    var cells = (screen.layout && Array.isArray(screen.layout.cells)) ? screen.layout.cells : [];
    return cells.map(function (c) { return (c && c.element) || ''; });
  }

  // Compare two element descriptors and return a list of field changes.
  var FIELDS = ['type', 'path', 'unit', 'label'];
  function compareElements(id, current, proposed) {
    var changes = [];
    FIELDS.forEach(function (field) {
      var was = current[field] !== undefined ? current[field] : '';
      var now = proposed[field] !== undefined ? proposed[field] : '';
      if (was !== now) {
        changes.push({ id: id, field: field, was: was, now: now });
      }
    });
    return changes;
  }

  /**
   * diffDashboards(currentDoc, proposedDoc)
   *
   * Both arguments are parsed MIDL doc objects (not JSON strings).
   * Returns { added: string[], removed: string[], changed: Array<{id, field, was, now}> }.
   *
   * "added" and "removed" are element ids. Elements present in proposed but not
   * in current are "added". Elements present in current but not in proposed are
   * "removed". Elements present in both but with differing fields appear in
   * "changed" (one entry per changed field).
   *
   * If currentDoc is null/undefined/empty, everything in proposedDoc is added.
   */
  function diffDashboards(currentDoc, proposedDoc) {
    var currentEls = extractElements(currentDoc);
    var proposedEls = extractElements(proposedDoc);

    var added = [];
    var removed = [];
    var changed = [];

    var currentIds = Object.keys(currentEls);
    var proposedIds = Object.keys(proposedEls);

    // Added: in proposed, not in current
    proposedIds.forEach(function (id) {
      if (!Object.prototype.hasOwnProperty.call(currentEls, id)) {
        added.push(id);
      }
    });

    // Removed: in current, not in proposed
    currentIds.forEach(function (id) {
      if (!Object.prototype.hasOwnProperty.call(proposedEls, id)) {
        removed.push(id);
      }
    });

    // Changed: in both, but fields differ
    proposedIds.forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(currentEls, id)) {
        var fieldChanges = compareElements(id, currentEls[id], proposedEls[id]);
        fieldChanges.forEach(function (c) { changed.push(c); });
      }
    });

    return { added: added, removed: removed, changed: changed };
  }

  return { diffDashboards: diffDashboards };
}));
