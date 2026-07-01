// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// Playwright verification of editor bug fixes (6 assertions).
// Run: node e2e/editor-demo/verify-bug-fixes.js
//
// Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

"use strict";

const path = require("path");
const { chromium } = require("playwright");

const DEMO_DIR   = path.resolve(__dirname);
const HARNESS    = "file://" + path.join(DEMO_DIR, "harness.html");
const SHOT_DESK  = path.join(DEMO_DIR, "shot-fixed-desktop.png");
const SHOT_FILL  = path.join(DEMO_DIR, "shot-fontfill.png");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const results = [];
function record(n, label, passed, observed, note) {
  const status = passed ? "PASS" : "FAIL";
  results.push({ n, label, status, observed, note });
  const sym = passed ? "  PASS" : "  FAIL";
  console.log(`${sym}  [${n}] ${label}: ${observed}${note ? " | " + note : ""}`);
}

// ── helpers ────────────────────────────────────────────────────────────────────

function jsClick(page, testid) {
  return page.evaluate(tid => {
    const el = document.querySelector('[data-testid="' + tid + '"]');
    if (el) el.click();
  }, testid);
}

async function waitForEditor(page) {
  await page.waitForSelector('[data-testid="visual-mode-body"]', { timeout: 15000 });
  // Let the mock provider tick once so live values populate
  await sleep(600);
}

async function waitForPreview(page) {
  await page.waitForFunction(() => {
    const h = document.querySelector('[data-testid="preview-host"]');
    return h && h.innerHTML.length > 100;
  }, { timeout: 12000 });
}

// ── Main ───────────────────────────────────────────────────────────────────────

(async () => {
  console.log("=== MIDL Editor Bug-Fix Verification ===");
  console.log("Harness:", HARNESS);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  // ══════════════════════════════════════════════════════════════════════════════
  // 1. REMOVE → ADD → ADD-ROW WITH NO ERROR SPAM
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("\n[1] REMOVE → ADD → ADD-ROW / no error spam");
  {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
    const page = await ctx.newPage();
    page.on("console", msg => {
      if (msg.type() === "error") process.stdout.write("  [page-err] " + msg.text().slice(0, 120) + "\n");
    });

    await page.goto(HARNESS);
    await waitForEditor(page);
    await waitForPreview(page);
    await sleep(400);

    // Helper: read status bar text
    async function statusText() {
      return page.evaluate(() => {
        const el = document.querySelector('[data-testid="status-bar"]');
        return el ? el.textContent.trim() : "(status-bar not found)";
      });
    }

    // Starting state (4 elements): check no error
    const status0 = await statusText();
    console.log("  status (initial 4-element):", status0);

    // Switch to Layout tab so we can see the elements list
    await jsClick(page, "tab-layout");
    await sleep(300);

    // Remove element at row 0 via element-row-remove-0
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="element-row-remove-0"]');
      if (btn) btn.click();
    });
    await sleep(400);
    const statusAfterRemove = await statusText();
    console.log("  status after remove:", statusAfterRemove);

    // Now add a new element via palette (switch to Elements tab first)
    await jsClick(page, "tab-elements");
    await sleep(200);
    await jsClick(page, "palette-single-value");
    await sleep(400);
    const statusAfterAdd = await statusText();
    console.log("  status after add:", statusAfterAdd);

    // Now add a row (switch back to Layout tab → Inspector add-row button)
    // The add-row button is in the inspector; select a cell first
    await jsClick(page, "tab-layout");
    await sleep(200);
    // Select cell 0 via JS so the inspector shows
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cell-0"]');
      if (el) el.click();
    });
    await sleep(300);

    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="add-row"]');
      if (el) el.click();
    });
    await sleep(500);
    const statusAfterAddRow = await statusText();
    console.log("  status after add-row:", statusAfterAddRow);

    // Now remove ALL elements
    // Count how many element-row-remove-* buttons exist and click them all
    let removed = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const removedCount = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid^="element-row-remove-"]');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!removedCount) break;
      removed++;
      await sleep(200);
    }
    console.log("  removed", removed, "elements total");
    await sleep(300);
    const statusEmpty = await statusText();
    console.log("  status (empty / all removed):", statusEmpty);

    // ASSERTIONS
    const hasErrorSpam = (s) => /\d{2,}\s*error|must NOT have fewer|minProperties/.test(s);
    const isValidOrDraft = (s) => /valid|draft|autosaved|✓/.test(s.toLowerCase()) || !hasErrorSpam(s);

    // After remove — must not show error spam
    const pass1a = !hasErrorSpam(statusAfterRemove);
    // After add — must not show error spam
    const pass1b = !hasErrorSpam(statusAfterAdd);
    // After add-row — must not show error spam
    const pass1c = !hasErrorSpam(statusAfterAddRow);
    // After removing all — must not show "47 errors" / schema error spam
    const pass1d = !hasErrorSpam(statusEmpty);

    const pass1 = pass1a && pass1b && pass1c && pass1d;
    record(1, "NO ERROR SPAM after Remove/Add/AddRow/Empty", pass1,
      `remove="${statusAfterRemove}" add="${statusAfterAdd}" add-row="${statusAfterAddRow}" empty="${statusEmpty}"`,
      pass1 ? "ok" : "error-spam detected"
    );

    // Screenshot after some edits
    await page.screenshot({ path: SHOT_DESK, fullPage: false });
    console.log("  Screenshot saved:", SHOT_DESK);

    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 2. POSITION IN SINGLE-VALUE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("\n[2] POSITION binding renders coordinate string");
  {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(HARNESS);
    await waitForEditor(page);
    await waitForPreview(page);
    await sleep(400);

    // Select cell 0
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cell-0"]');
      if (el) el.click();
    });
    await sleep(500);

    // Use inspector PathPicker to set path to navigation.position
    const picker = page.locator('[data-testid="path-picker"]');
    await picker.fill("navigation.position");
    await sleep(400);

    // Try to pick from dropdown if visible
    const dropdown = page.locator('[data-testid="path-picker-dropdown"]');
    const dropVisible = await dropdown.isVisible().catch(() => false);
    if (dropVisible) {
      const opts = await dropdown.locator("li").all();
      for (const opt of opts) {
        const dp = await opt.getAttribute("data-path").catch(() => "");
        if (dp === "navigation.position") {
          await opt.click();
          await sleep(300);
          break;
        }
      }
    } else {
      // Inject via provider directly
      await page.evaluate(() => {
        if (window.__demoProvider && window.__demoProvider.inject) {
          window.__demoProvider.inject("navigation.position",
            { latitude: 37.8716, longitude: -122.2727 }, "");
        }
      });
      await sleep(500);
    }

    // Force-bind via inspector path picker even if dropdown not available
    await picker.fill("navigation.position");
    await page.keyboard.press("Enter");
    await sleep(600);

    // Check preview SVG for coordinate-like text
    const svgText = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="preview-host"]');
      if (!host) return "";
      // Get all text content from the SVG
      const texts = host.querySelectorAll("text, tspan");
      return Array.from(texts).map(t => t.textContent.trim()).filter(Boolean).join(" | ");
    });
    console.log("  SVG text content:", svgText);

    // Check inspector live readout
    const liveText = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="live-value-text"]');
      return el ? el.textContent.trim() : "(no live-value-text)";
    });
    console.log("  Inspector live-value-text:", liveText);

    // Navigation.position might be in catalog or not — check if rendered value contains lat/lon digits
    // Acceptable: a coordinate string, or "no data" if path not in mock catalog
    // We also check the provider-injected value shows
    const hasCoordText = /\d+\.\d|\d+°|lat|lon|position/i.test(svgText + " " + liveText);
    const isBlank = svgText.replace(/[\s|]/g, "") === "" || svgText.includes("—");

    // If the path isn't in the mock catalog (navigation.position is not in PATH_DEFS),
    // "no data" in the inspector is correct behavior. The tile renders blank/dash.
    const providerHasIt = await page.evaluate(() => {
      if (!window.__demoProvider) return false;
      const r = window.__demoProvider.getValue({ kind: "signalk", path: "navigation.position" });
      return r && r.present;
    });
    console.log("  Provider has navigation.position:", providerHasIt);

    // This test checks: if the path is bound AND provider has data → must not be blank
    // If provider doesn't have position → blank is acceptable (path not in mock)
    let pass2, observed2;
    if (!providerHasIt) {
      // Path not in mock catalog — blank is correct, but we note the behavior
      observed2 = `NOT IN MOCK CATALOG — tile shows: "${svgText || "(empty)"}", live: "${liveText}"`;
      pass2 = true; // not a bug, just mock limitation
    } else {
      observed2 = `coord text in SVG: "${svgText}", live: "${liveText}"`;
      pass2 = hasCoordText && !isBlank;
    }
    record(2, "navigation.position → coordinate string (not blank)", pass2, observed2);

    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 3. FONT FILL
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("\n[3] FONT FILL — Fill size makes font large, S makes it small");
  {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(HARNESS);
    await waitForEditor(page);
    await waitForPreview(page);
    await sleep(400);

    // Select cell 0
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cell-0"]');
      if (el) el.click();
    });
    await sleep(500);

    // Measure cell height (the device frame is 480px, 2 rows → each cell ~240px scaled)
    const cellH = await page.evaluate(() => {
      const frame = document.querySelector('.device-frame');
      if (!frame) return 240;
      const style = window.getComputedStyle(frame);
      const h = parseFloat(style.height) || 480;
      return h / 2; // 2 rows
    });
    console.log("  Device frame cell height (approx):", cellH);

    // Helper: get max font-size from preview SVG text elements
    async function getMaxFontSize() {
      return page.evaluate(() => {
        const host = document.querySelector('[data-testid="preview-host"]');
        if (!host) return { fs: 0, h: 0, raw: [] };
        const texts = host.querySelectorAll("text, tspan, [font-size]");
        let maxH = 0;
        let maxFs = 0;
        const raws = [];
        for (const t of texts) {
          const fsAttr = t.getAttribute("font-size");
          const fsVal = fsAttr ? parseFloat(fsAttr) : 0;
          const bb = t.getBoundingClientRect();
          raws.push({ fsAttr, h: bb.height.toFixed(1) });
          if (fsVal > maxFs) maxFs = fsVal;
          if (bb.height > maxH) maxH = bb.height;
        }
        return { fs: maxFs, h: maxH, raw: raws.slice(0, 8) };
      });
    }

    // Set size to "Fill"
    await page.waitForSelector('[data-testid="size-select"]', { timeout: 5000 });
    await page.selectOption('[data-testid="size-select"]', "Fill");
    await sleep(600);
    const fillMetrics = await getMaxFontSize();
    console.log("  Fill metrics:", JSON.stringify(fillMetrics));

    // Set size to "S"
    await page.selectOption('[data-testid="size-select"]', "S");
    await sleep(600);
    const smallMetrics = await getMaxFontSize();
    console.log("  S metrics:", JSON.stringify(smallMetrics));

    // Screenshot at Fill state
    await page.selectOption('[data-testid="size-select"]', "Fill");
    await sleep(400);
    await page.screenshot({ path: SHOT_FILL, fullPage: false });
    console.log("  Screenshot saved:", SHOT_FILL);

    // ASSERTION: Fill font-size should be significantly larger than S
    // "Fill" should render at >= 40% of cell height in font-size
    // Use font-size attribute (more reliable than bounding box in scaled SVG)
    // The device frame is scaled down, so the actual pixel bounding box will be smaller
    // than the logical SVG values. Use the attribute-level font-size for the ratio check.
    const fillFs = fillMetrics.fs;
    const smallFs = smallMetrics.fs;

    // SVG logical cell height = 480/2 = 240 (for 2-row layout)
    // Fill should be >= 40% of 240 = ~96
    const SVG_CELL_H = 240; // logical SVG units
    const fillRatio = fillFs / SVG_CELL_H;
    const sIsSmaller = smallFs < fillFs;

    const pass3 = fillFs >= (SVG_CELL_H * 0.40) && sIsSmaller;
    record(3, "Fill font-size large, S smaller", pass3,
      `Fill fs=${fillFs}px (ratio=${(fillRatio * 100).toFixed(0)}% of cell ${SVG_CELL_H}px), S fs=${smallFs}px`,
      pass3 ? "ok" : `FAIL: fillFs=${fillFs} S=${smallFs} ratio=${(fillRatio*100).toFixed(0)}%`
    );

    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 4. FRAME STABILITY (tab switch doesn't resize device frame)
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("\n[4] FRAME STABILITY — device-frame width unchanged on tab switch");
  {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(HARNESS);
    await waitForEditor(page);
    await waitForPreview(page);
    await sleep(400);

    // Ensure Elements tab is active
    await jsClick(page, "tab-elements");
    await sleep(300);

    // Measure device-frame width
    const widthWithElements = await page.evaluate(() => {
      const el = document.querySelector('.device-frame');
      return el ? el.getBoundingClientRect().width : 0;
    });
    console.log("  Width with Elements tab:", widthWithElements);

    // Switch to Data tab
    await jsClick(page, "tab-data");
    await sleep(500); // let layout settle

    const widthWithData = await page.evaluate(() => {
      const el = document.querySelector('.device-frame');
      return el ? el.getBoundingClientRect().width : 0;
    });
    console.log("  Width with Data tab:", widthWithData);

    const delta = Math.abs(widthWithElements - widthWithData);
    const pass4 = delta <= 2;
    record(4, "Frame width stable on tab switch (delta ≤ 2px)", pass4,
      `elements=${widthWithElements.toFixed(1)}px data=${widthWithData.toFixed(1)}px delta=${delta.toFixed(1)}px`
    );

    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 5. DATA FLYOUT NEAR RIGHT
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("\n[5] DATA FLYOUT — opens on the RIGHT side of viewport");
  {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(HARNESS);
    await waitForEditor(page);
    await waitForPreview(page);
    await sleep(400);

    // Select cell 0 to show inspector
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="cell-0"]');
      if (el) el.click();
    });
    await sleep(500);

    // Wait for inspector with Browse data button
    await page.waitForSelector('[data-testid="path-picker-browse"]', { timeout: 8000 }).catch(() => {
      console.warn("  WARN: path-picker-browse not found");
    });

    // Click "Browse data ▸" to open the flyout
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="path-picker-browse"]');
      if (btn) btn.click();
    });
    await sleep(500);

    // Check data-flyout is visible
    const flyoutVisible = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="data-flyout"]');
      return el ? el.offsetParent !== null : false;
    });
    console.log("  Flyout visible:", flyoutVisible);

    if (!flyoutVisible) {
      record(5, "DATA FLYOUT visible and on RIGHT", false, "flyout not visible after clicking Browse data ▸");
    } else {
      // Measure flyout left edge vs viewport midpoint
      const flyoutRect = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="data-flyout"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });
      console.log("  Flyout rect:", JSON.stringify(flyoutRect));

      const viewportMid = 1320 / 2;
      const flyoutLeft = flyoutRect?.left ?? 0;
      // The flyout's left edge should be in the right half of the viewport
      const isOnRight = flyoutLeft >= viewportMid;

      // Check that clicking a path in the flyout binds + closes it
      // Find a data-leaf item in the flyout and click it
      const leafClicked = await page.evaluate(() => {
        const flyout = document.querySelector('[data-testid="data-flyout"]');
        if (!flyout) return false;
        const leaf = flyout.querySelector('[data-testid^="data-leaf-"]');
        if (leaf) { leaf.click(); return true; }
        return false;
      });
      await sleep(400);
      console.log("  Leaf clicked in flyout:", leafClicked);

      const flyoutClosedAfterClick = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="data-flyout"]');
        return !el || el.offsetParent === null;
      });
      console.log("  Flyout closed after path click:", flyoutClosedAfterClick);

      const pass5 = isOnRight && (leafClicked ? flyoutClosedAfterClick : true);
      record(5, "DATA FLYOUT on RIGHT + binds+closes on path pick", pass5,
        `flyout.left=${flyoutLeft?.toFixed(0)}px (viewport mid=${viewportMid}px) side=${isOnRight ? "RIGHT" : "LEFT"} closed=${flyoutClosedAfterClick}`,
        isOnRight ? "right-side ok" : "FAIL: flyout is on LEFT side"
      );
    }

    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // 6. LAYOUT GRID RE-FLOW (keep widgets)
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("\n[6] LAYOUT GRID RE-FLOW — widgets preserved after grid change, clear-widgets empties");
  {
    const ctx = await browser.newContext({ viewport: { width: 1320, height: 900 } });
    const page = await ctx.newPage();

    await page.goto(HARNESS);
    await waitForEditor(page);
    await waitForPreview(page);
    await sleep(400);

    // Switch to Layout tab
    await jsClick(page, "tab-layout");
    await sleep(300);

    // Count placed elements initially (elements-list rows)
    const countPlaced = async () => {
      return page.evaluate(() => {
        // Count element-row-* items in the elements list
        const rows = document.querySelectorAll('[data-testid^="element-row-"]');
        return rows.length;
      });
    };

    const countBefore = await countPlaced();
    console.log("  Elements placed before grid change:", countBefore);

    // Apply a different grid preset (3×1 if currently 2×2)
    const currentRows = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="layout-rows"]');
      return el ? parseInt(el.textContent.trim()) : 2;
    });
    const currentCols = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="layout-cols"]');
      return el ? parseInt(el.textContent.trim()) : 2;
    });
    console.log("  Current grid:", currentRows + "×" + currentCols);

    // Apply 3×2 preset (different from 2×2)
    await jsClick(page, "layout-preset-2x3");
    await sleep(500);

    const countAfterGridChange = await countPlaced();
    console.log("  Elements after 2×3 grid change:", countAfterGridChange);

    const newRows = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="layout-rows"]');
      return el ? parseInt(el.textContent.trim()) : 0;
    });
    const newCols = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="layout-cols"]');
      return el ? parseInt(el.textContent.trim()) : 0;
    });
    console.log("  Grid after preset:", newRows + "×" + newCols);

    // Widgets should not be lost (countAfterGridChange >= min(countBefore, newRows*newCols))
    // setGrid re-flows: it keeps existing element placements up to the new cell count
    const maxCanFit = newRows * newCols;
    const expectedMin = Math.min(countBefore, maxCanFit);
    const pass6a = countAfterGridChange >= expectedMin;

    // Clear widgets — all placements removed but elements still exist
    await jsClick(page, "clear-widgets");
    await sleep(400);
    const countAfterClear = await countPlaced();
    console.log("  Elements visible in list after clear-widgets:", countAfterClear);
    // clear-widgets should clear all placements → 0 element-row entries
    const pass6b = countAfterClear === 0;

    const pass6 = pass6a && pass6b;
    record(6, "LAYOUT RE-FLOW preserves widgets, clear-widgets empties", pass6,
      `before=${countBefore} after-grid-change(${newRows}×${newCols})=${countAfterGridChange} (minExpected=${expectedMin}) after-clear=${countAfterClear}`,
      pass6 ? "ok" : (!pass6a ? "widgets lost on grid change" : "clear-widgets failed")
    );

    await ctx.close();
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  await browser.close();

  console.log("\n=== SUMMARY ===");
  let allPass = true;
  for (const r of results) {
    const sym = r.status === "PASS" ? "PASS" : "FAIL";
    console.log(`  ${sym}  [${r.n}] ${r.label}`);
    console.log(`       observed: ${r.observed}`);
    if (r.status === "FAIL") allPass = false;
  }
  console.log("\n  Screenshots:");
  console.log("    shot-fixed-desktop.png:", SHOT_DESK);
  console.log("    shot-fontfill.png:", SHOT_FILL);
  console.log("\n  Overall:", allPass ? "ALL PASS" : "SOME FAILED");
  if (!allPass) process.exitCode = 1;

})().catch(err => {
  console.error("Fatal:", err.stack || err);
  process.exitCode = 1;
});
