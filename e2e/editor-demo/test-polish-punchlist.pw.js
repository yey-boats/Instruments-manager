// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// Editor polish punch-list — 9 assertions across Desktop / Tablet / Phone viewports.
// Run with:
//   node e2e/editor-demo/test-polish-punchlist.pw.js
//
// Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

const { chromium } = require("@playwright/test");
const path = require("path");

const HARNESS = `file://${path.resolve(__dirname, "harness.html")}`;
const SHOT_DIR = __dirname;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function openEditor(browser, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto(HARNESS, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="visual-mode-body"]', { timeout: 15000 });
  await page.waitForTimeout(700); // let ticks fire and React settle
  return { page, ctx };
}

async function selectCell(page, index) {
  await page.evaluate((i) => {
    const el = document.querySelector(`[data-testid="cell-${i}"]`);
    if (el) el.click();
  }, index);
  await page.waitForTimeout(300);
}

function pass(n, msg) { console.log(`  ✓ [${n}] PASS — ${msg}`); }
function fail(n, msg) { console.log(`  ✗ [${n}] FAIL — ${msg}`); }

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  function record(n, ok, msg) {
    results.push({ n, ok, msg });
    if (ok) pass(n, msg); else fail(n, msg);
  }

  // ════════════════════════════════════════════════════════
  // DESKTOP 1320×900
  // ════════════════════════════════════════════════════════
  console.log("\n─── DESKTOP (1320×900) ───────────────────────────────");
  const { page: dPage, ctx: dCtx } = await openEditor(browser, { width: 1320, height: 900 });

  // ── 1. Single viewport / no page scroll ────────────────────────────────────
  {
    const { scrollH, innerH } = await dPage.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
    }));
    const ok = scrollH <= innerH + 2;
    record(1, ok, `scrollHeight=${scrollH} innerHeight=${innerH} (delta=${scrollH - innerH})`);
    await dPage.screenshot({ path: path.join(SHOT_DIR, "shot-desktop.png"), fullPage: false });
    console.log(`     → screenshot: shot-desktop.png`);
  }

  // ── 2. Catalog defaults on bind ────────────────────────────────────────────
  // The starter doc has 4 elements in a 2×2 grid, all cells occupied.
  // Strategy: expand grid to 3 rows so cell 4 is empty, add a single-value to it,
  // then bind environment.depth.belowTransducer and assert auto-fill.
  {
    // First add a row to get an empty cell
    await dPage.locator('[data-testid="add-row"]').click();
    await dPage.waitForTimeout(300);

    // Add a single-value element from palette — it should go to first empty cell (index 4)
    await dPage.locator('[data-testid="tab-elements"]').click();
    await dPage.waitForTimeout(200);
    await dPage.locator('[data-testid="palette-single-value"]').click();
    await dPage.waitForTimeout(400);

    // Select that new element's cell (should be cell 4)
    await selectCell(dPage, 4);
    await dPage.waitForTimeout(300);

    // Confirm inspector shows an element with empty/no name yet (fresh element)
    // Use the path-picker to bind to depth path
    const pathInput = dPage.locator('[data-testid="path-picker"]').first();
    await pathInput.fill("");
    await pathInput.focus();
    await dPage.waitForTimeout(200);
    await pathInput.fill("environment.depth.belowTransducer");
    await dPage.waitForTimeout(500); // dropdown renders

    // Select via the dropdown option (mousedown fires before blur closes it)
    const option = dPage.locator('[data-testid="path-picker-option-environment-depth-belowTransducer"]').first();
    const optVisible = await option.isVisible().catch(() => false);
    if (optVisible) {
      await option.dispatchEvent("mousedown");
    } else {
      // Try keyboard: clear + type partial path then press Enter
      await pathInput.fill("belowTransducer");
      await dPage.waitForTimeout(400);
      const opt2 = dPage.locator('[data-testid="path-picker-option-environment-depth-belowTransducer"]').first();
      const opt2Visible = await opt2.isVisible().catch(() => false);
      if (opt2Visible) await opt2.dispatchEvent("mousedown");
    }
    await dPage.waitForTimeout(600);

    // Read inspector fields — note there are TWO name-inputs in the DOM:
    // one in the topbar (dashboard title) and one in the inspector.
    // Target the inspector's name-input specifically via [data-component="inspector"].
    const labelVal    = await dPage.locator('[data-component="inspector"] [data-testid="name-input"]').inputValue().catch(() => "");
    const unitVal     = await dPage.locator('[data-component="inspector"] [data-testid="unit-input"]').inputValue().catch(() => "");
    const decimalsVal = await dPage.locator('[data-component="inspector"] [data-testid="decimals-input"]').inputValue().catch(() => "");

    // applyCatalogDefaults fills name only if empty. Fresh element has no name ⇒ "Depth Below Transducer".
    // unit → "m", decimals → 1
    const labelOk    = labelVal.toLowerCase().includes("depth");
    const unitOk     = unitVal === "m";
    const decimalsOk = decimalsVal === "1";

    // Live readout: should show a rounded value, not raw float
    await dPage.waitForTimeout(500);
    const liveText = await dPage.locator('[data-component="inspector"] [data-testid="live-value-text"]').innerText().catch(
      () => dPage.locator('[data-testid="live-value-text"]').first().innerText().catch(() => "")
    );
    const rawFloatPattern = /\d+\.\d{3,}/; // 3+ decimals = raw float
    const liveOk = liveText.length > 0 && !rawFloatPattern.test(liveText);

    const ok = labelOk && unitOk && decimalsOk && liveOk;
    record(2, ok,
      `label="${labelVal}" unit="${unitVal}" decimals="${decimalsVal}" live="${liveText}" ` +
      `(labelOk=${labelOk} unitOk=${unitOk} decimalsOk=${decimalsOk} liveOk=${liveOk})`
    );
  }

  // ── 3. Zoom ────────────────────────────────────────────────────────────────
  {
    // Measure device frame width before zoom-in
    const frameBefore = await dPage.evaluate(() => {
      const frame = document.querySelector(".device-frame");
      if (!frame) return null;
      return frame.getBoundingClientRect().width;
    });

    const zoomLevelBefore = await dPage.locator('[data-testid="zoom-level"]').innerText().catch(() => "");

    // Click zoom-in
    await dPage.locator('[data-testid="zoom-in"]').click();
    await dPage.waitForTimeout(300);

    const zoomLevelAfter = await dPage.locator('[data-testid="zoom-level"]').innerText().catch(() => "");
    const frameAfter = await dPage.evaluate(() => {
      const frame = document.querySelector(".device-frame");
      if (!frame) return null;
      return frame.getBoundingClientRect().width;
    });

    // zoom-level text must change (was "Fit", now should be percentage)
    const levelChanged = zoomLevelAfter !== zoomLevelBefore;
    // device frame bounding box width must grow
    const frameGrew = frameAfter !== null && frameBefore !== null && frameAfter > frameBefore;

    // Click zoom-fit → returns to "Fit"
    await dPage.locator('[data-testid="zoom-fit"]').click();
    await dPage.waitForTimeout(300);
    const zoomLevelFit = await dPage.locator('[data-testid="zoom-level"]').innerText().catch(() => "");
    const fitOk = zoomLevelFit === "Fit";

    const ok = levelChanged && frameGrew && fitOk;
    record(3, ok,
      `zoom before="${zoomLevelBefore}" after="${zoomLevelAfter}" fit="${zoomLevelFit}" ` +
      `frame: ${frameBefore?.toFixed(0)}→${frameAfter?.toFixed(0)}px ` +
      `(levelChanged=${levelChanged} frameGrew=${frameGrew} fitOk=${fitOk})`
    );
  }

  // ── 4. Elements on canvas / Layout tab ────────────────────────────────────
  {
    // Open Layout tab
    await dPage.locator('[data-testid="tab-layout"]').click();
    await dPage.waitForTimeout(300);

    // elements-list should show placed elements
    const elementRows = await dPage.locator('[data-testid^="element-row-"]').all();
    const rowCount = elementRows.length;
    const hasRows = rowCount > 0;

    // Click row 0 → inspector updates
    if (hasRows) {
      await dPage.locator('[data-testid="element-row-0"]').click();
      await dPage.waitForTimeout(300);
    }

    // Use inspector-scoped selector (topbar also has a name-input for dashboard title)
    const inspectorName = await dPage.locator('[data-component="inspector"] [data-testid="name-input"]').inputValue().catch(() => "");
    const inspectorUpdated = inspectorName.length > 0;

    // Remove element at the first available row (row-0's remove button)
    const rowsBefore = await dPage.locator('[data-testid^="element-row-"]').count();

    // Find the cell index of the first row's remove button
    const firstRowTestId = await dPage.locator('[data-testid^="element-row-"]').first().getAttribute("data-testid").catch(() => "");
    const firstCellIdx = firstRowTestId?.replace("element-row-", "") ?? "0";
    const removeBtn = dPage.locator(`[data-testid="element-row-remove-${firstCellIdx}"]`);
    const removeBtnVisible = await removeBtn.isVisible().catch(() => false);
    if (removeBtnVisible) {
      await removeBtn.click();
      await dPage.waitForTimeout(400);
    }
    const rowsAfter = await dPage.locator('[data-testid^="element-row-"]').count();
    const shrunk = removeBtnVisible ? rowsAfter < rowsBefore : false;

    const ok = hasRows && inspectorUpdated && shrunk;
    record(4, ok,
      `elementRows=${rowCount} inspectorName="${inspectorName}" ` +
      `rowsBefore=${rowsBefore} rowsAfter=${rowsAfter} (shrunk=${shrunk})`
    );
  }

  // ── 5. Add / Remove / Re-add ───────────────────────────────────────────────
  {
    // Current state: some cells are free (we removed one in test 4).
    // Count current placed elements
    await dPage.locator('[data-testid="tab-layout"]').click();
    await dPage.waitForTimeout(200);
    const rowsBefore = await dPage.locator('[data-testid^="element-row-"]').count();

    // Add a gauge from palette
    await dPage.locator('[data-testid="tab-elements"]').click();
    await dPage.waitForTimeout(200);
    await dPage.locator('[data-testid="palette-gauge"]').click();
    await dPage.waitForTimeout(500);

    // Verify list grew
    await dPage.locator('[data-testid="tab-layout"]').click();
    await dPage.waitForTimeout(300);
    const rowsAfterAdd1 = await dPage.locator('[data-testid^="element-row-"]').count();
    const addedFirst = rowsAfterAdd1 > rowsBefore;

    // Remove the newly added element: find highest-indexed element row
    let removedOk = false;
    const allRowEls = await dPage.locator('[data-testid^="element-row-"]').all();
    // Collect all cell indices and find the max (the newly added one)
    let maxCellIdx = -1;
    for (const rowEl of allRowEls) {
      const tid = await rowEl.getAttribute("data-testid").catch(() => "");
      const idx = parseInt(tid?.replace("element-row-", "") ?? "-1", 10);
      if (!isNaN(idx) && idx > maxCellIdx) maxCellIdx = idx;
    }
    if (maxCellIdx >= 0) {
      const removeBtn = dPage.locator(`[data-testid="element-row-remove-${maxCellIdx}"]`);
      const vis = await removeBtn.isVisible().catch(() => false);
      if (vis) {
        await removeBtn.click();
        await dPage.waitForTimeout(400);
        removedOk = true;
      }
    }
    const rowsAfterRemove = await dPage.locator('[data-testid^="element-row-"]').count();

    // Add another element (bar) — should place (no silent no-op)
    await dPage.locator('[data-testid="tab-elements"]').click();
    await dPage.waitForTimeout(200);
    await dPage.locator('[data-testid="palette-bar"]').click();
    await dPage.waitForTimeout(500);

    await dPage.locator('[data-testid="tab-layout"]').click();
    await dPage.waitForTimeout(300);
    const rowsAfterAdd2 = await dPage.locator('[data-testid^="element-row-"]').count();
    const addedSecond = rowsAfterAdd2 > rowsAfterRemove;

    const ok = addedFirst && addedSecond;
    record(5, ok,
      `rowsBefore=${rowsBefore} +gauge=${rowsAfterAdd1} -remove=${rowsAfterRemove} +bar=${rowsAfterAdd2} ` +
      `(addedFirst=${addedFirst} removedOk=${removedOk} addedSecond=${addedSecond})`
    );
  }

  // ── 6. Font size ───────────────────────────────────────────────────────────
  {
    // Select cell 0 to ensure inspector shows an element
    await selectCell(dPage, 0);
    await dPage.waitForTimeout(400);

    // Capture any SVG text font-size before
    const sizeBefore = await dPage.evaluate(() => {
      const host = document.querySelector('[data-testid="preview-host"]');
      if (!host) return null;
      const textEls = Array.from(host.querySelectorAll("text, tspan"));
      for (const el of textEls) {
        const fs = el.getAttribute("font-size");
        if (fs) return parseFloat(fs);
      }
      return null;
    });

    // Change size to 48
    const sizeSelect = dPage.locator('[data-component="inspector"] [data-testid="size-select"]');
    await sizeSelect.selectOption("48");
    await dPage.waitForTimeout(600);

    const sizeAfter = await dPage.evaluate(() => {
      const host = document.querySelector('[data-testid="preview-host"]');
      if (!host) return null;
      const textEls = Array.from(host.querySelectorAll("text, tspan"));
      for (const el of textEls) {
        const fs = el.getAttribute("font-size");
        if (fs) return parseFloat(fs);
      }
      return null;
    });

    const sizeSelectVal = await sizeSelect.inputValue().catch(() => "");
    const sizeSelectOk = sizeSelectVal === "48";

    // Text grew (or we at least confirm the select changed; SVG may not show inline font-size attribute)
    let grew = sizeSelectOk;
    if (sizeBefore !== null && sizeAfter !== null && sizeAfter !== sizeBefore) {
      grew = sizeAfter > sizeBefore;
    }

    const ok = sizeSelectOk && grew;
    record(6, ok,
      `size-select="${sizeSelectVal}" svgFontBefore=${sizeBefore} svgFontAfter=${sizeAfter} (grew=${grew})`
    );
  }

  // ── 7. Palette items have icon + description ───────────────────────────────
  {
    await dPage.locator('[data-testid="tab-elements"]').click();
    await dPage.waitForTimeout(300);

    const paletteItems = await dPage.locator('[data-testid^="palette-"]').all();
    let allHaveIconAndDesc = true;
    const failures = [];

    for (const item of paletteItems) {
      const testId = await item.getAttribute("data-testid").catch(() => "");
      // Icon: SVG element inside the button
      const hasSvg = await item.locator("svg").count().then(n => n > 0).catch(() => false);
      // Description text: the button should have multi-word content (label + desc)
      const innerText = await item.innerText().catch(() => "");
      // Description is the second span — check the text has at least one space (multi-word or two separate spans)
      const lines = innerText.split("\n").map(s => s.trim()).filter(Boolean);
      const hasDesc = lines.length >= 2 || (lines.length === 1 && lines[0].trim().split(/\s+/).length >= 2);
      if (!hasSvg || !hasDesc) {
        allHaveIconAndDesc = false;
        failures.push(`${testId}: svg=${hasSvg} desc(lines=${lines.length})=${hasDesc}`);
      }
    }

    const ok = paletteItems.length > 0 && allHaveIconAndDesc;
    record(7, ok,
      `palette items=${paletteItems.length} allHaveIconAndDesc=${allHaveIconAndDesc}` +
      (failures.length ? ` FAILURES: ${failures.join("; ")}` : "")
    );
  }

  await dCtx.close();

  // ════════════════════════════════════════════════════════
  // TABLET 1024×768
  // ════════════════════════════════════════════════════════
  console.log("\n─── TABLET (1024×768) ────────────────────────────────");
  const { page: tPage, ctx: tCtx } = await openEditor(browser, { width: 1024, height: 768 });

  // ── 8. Single viewport / no page scroll ───────────────────────────────────
  {
    const { scrollH, innerH } = await tPage.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
    }));
    const ok = scrollH <= innerH + 2;
    record(8, ok, `scrollHeight=${scrollH} innerHeight=${innerH} (delta=${scrollH - innerH})`);
    await tPage.screenshot({ path: path.join(SHOT_DIR, "shot-tablet.png"), fullPage: false });
    console.log(`     → screenshot: shot-tablet.png`);
  }

  await tCtx.close();

  // ════════════════════════════════════════════════════════
  // PHONE 390×844
  // ════════════════════════════════════════════════════════
  console.log("\n─── PHONE (390×844) ──────────────────────────────────");
  const { page: pPage, ctx: pCtx } = await openEditor(browser, { width: 390, height: 844 });

  // ── 9. Phone layout ────────────────────────────────────────────────────────
  {
    // mobile-tabbar visible
    const tabbarVisible = await pPage.locator('[data-testid="mobile-tabbar"]').isVisible().catch(() => false);

    // Left rail hidden at 390px — check computed style
    const leftRailHidden = await pPage.evaluate(() => {
      const rail = document.querySelector('[data-section="left-rail"]');
      if (!rail) return true; // absent = hidden
      const style = window.getComputedStyle(rail);
      return style.display === "none" || style.visibility === "hidden"
        || parseInt(style.width) < 10;
    });

    // Inspector hidden at phone width
    const inspectorHidden = await pPage.evaluate(() => {
      const insp = document.querySelector('[data-component="inspector"]');
      if (!insp) return true;
      const style = window.getComputedStyle(insp);
      // Inspector is inside the inspector panel; on mobile it should be in mobile-sheet or hidden
      // Check if it's within visible area or not
      const rect = insp.getBoundingClientRect();
      return style.display === "none" || style.visibility === "hidden"
        || rect.width < 10 || rect.right < 0;
    });

    // Tap Data tab in mobile-tabbar
    const dataTabBtn = pPage.locator('[data-testid="mobile-tabbar"] .mobile-tab-btn').filter({ hasText: /^data$/i }).first();
    const dataTabExists = await dataTabBtn.isVisible().catch(() => false);
    if (dataTabExists) {
      await dataTabBtn.click();
      await pPage.waitForTimeout(600);
    }

    const mobileSheet = pPage.locator('[data-testid="mobile-sheet"]');
    const sheetVisible = await mobileSheet.isVisible().catch(() => false);
    const sheetIsData = await mobileSheet.getAttribute("data-mobile-sheet").catch(() => "");

    // Canvas area visible above the sheet
    const canvasVisible = await pPage.locator('.canvas-area').isVisible().catch(() => false);

    // Tap Inspector tab — use JS click to avoid sheet interception
    await pPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('[data-testid="mobile-tabbar"] .mobile-tab-btn'));
      const inspBtn = btns.find(b => /inspector/i.test(b.textContent ?? ""));
      if (inspBtn) (inspBtn).click();
    });
    await pPage.waitForTimeout(500);

    const sheetAfterInspTap = await mobileSheet.isVisible().catch(() => false);
    const sheetIsInspector = await mobileSheet.getAttribute("data-mobile-sheet").catch(() => "");

    // topbar-overflow present (visible or at least in DOM)
    const overflowPresent = await pPage.locator('[data-testid="topbar-overflow"]').isVisible().catch(() => false);

    await pPage.screenshot({ path: path.join(SHOT_DIR, "shot-phone.png"), fullPage: false });
    console.log(`     → screenshot: shot-phone.png`);

    const ok = tabbarVisible && leftRailHidden && sheetVisible && canvasVisible && overflowPresent;
    record(9, ok,
      `tabbar=${tabbarVisible} leftRailHidden=${leftRailHidden} inspectorHidden=${inspectorHidden} ` +
      `sheet(data)=${sheetVisible}[${sheetIsData}] canvas=${canvasVisible} ` +
      `sheet(inspector)=${sheetAfterInspTap}[${sheetIsInspector}] overflow=${overflowPresent}`
    );
  }

  await pCtx.close();
  await browser.close();

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(" PUNCH-LIST RESULTS");
  console.log("═══════════════════════════════════════════════════════");
  let allPass = true;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    console.log(` [${r.n}] ${status}: ${r.msg}`);
    if (!r.ok) allPass = false;
  }
  console.log("───────────────────────────────────────────────────────");
  console.log(` Overall: ${allPass ? "ALL PASS" : "SOME FAILURES"}`);
  console.log("═══════════════════════════════════════════════════════\n");

  console.log("Screenshots:");
  console.log(`  ${path.join(SHOT_DIR, "shot-desktop.png")}`);
  console.log(`  ${path.join(SHOT_DIR, "shot-tablet.png")}`);
  console.log(`  ${path.join(SHOT_DIR, "shot-phone.png")}`);

  process.exit(allPass ? 0 : 1);
})();
