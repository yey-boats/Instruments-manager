// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Yey Boats Project. See LICENSE and COMMERCIAL.md.
//
// Functional verification of two editor fixes:
//   1) DECIMALS — inspector live-value readout shows formatted value (e.g. "4.1 kn")
//   2) SPAN IN PREVIEW — colSpan=2 makes the spanned tile visibly wider in SVG preview
//
// For SPAN: the starter 4-cell 2×2 doc makes setting span=2x1 via the UI invalid
// (overflow: 5 slots needed in 4-slot grid). Instead we:
//   a) Capture the SVG BEFORE setting span (4 tiles, all 236-wide)
//   b) Use source mode to inject a valid 3-cell doc with colSpan:2 on cell-0
//   c) Switch to visual mode; assert the spanned tile is now 476-wide (2× wider)
//   d) Screenshot shot-span.png from visual mode with span inspector open
// This directly tests the solveLayout fix (the renderer now honors colSpan).
//
// Run: node e2e/editor-demo/verify-fixes-final.js

"use strict";

const path = require("path");
const { chromium } = require("playwright");

const DEMO_DIR = path.resolve(__dirname);
const HARNESS_URL = "file://" + path.join(DEMO_DIR, "harness.html");
const SHOT_DECIMALS = path.join(DEMO_DIR, "shot-decimals.png");
const SHOT_SPAN = path.join(DEMO_DIR, "shot-span.png");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pass(label, detail) { console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`); }
function fail(label, detail) { console.error(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }

async function jsClick(page, testid) {
  await page.evaluate(tid => {
    const el = document.querySelector('[data-testid="' + tid + '"]');
    if (el) el.click();
  }, testid);
}

async function waitForPreviewReady(page) {
  await page.waitForFunction(() => {
    const host = document.querySelector('[data-testid="preview-host"]');
    return host && host.innerHTML.length > 100;
  }, { timeout: 15000 });
}

// A valid 3-cell doc with cell-0 spanning 2 columns in a 2×2 grid.
// Slot accounting: cell-0 (colSpan:2)=2 slots + cell-1=1 slot + cell-2=1 slot = 4 = 2×2.
const SPAN_DOC = [
  "midl: 1.0.0",
  "meta:",
  "  title: Span Test",
  "  tags:",
  "    - demo",
  "screens:",
  "  - id: main",
  "    meta:",
  "      title: Span Test",
  "    elements:",
  "      sog:",
  "        type: single-value",
  "        name: SOG",
  "        format:",
  "          unit: kn",
  "          decimals: 1",
  "        bindings:",
  "          value:",
  "            kind: signalk",
  "            path: navigation.speedOverGround",
  "      wind:",
  "        type: single-value",
  "        name: TWS",
  "        format:",
  "          unit: kn",
  "          decimals: 1",
  "        bindings:",
  "          value:",
  "            kind: signalk",
  "            path: environment.wind.speedApparent",
  "      depth:",
  "        type: single-value",
  "        name: Depth",
  "        format:",
  "          unit: m",
  "          decimals: 1",
  "        bindings:",
  "          value:",
  "            kind: signalk",
  "            path: environment.depth.belowTransducer",
  "    layout:",
  "      rows: 2",
  "      cols: 2",
  "      cells:",
  "        - element: sog",
  "          colSpan: 2",
  "        - element: wind",
  "        - element: depth",
].join("\n");

(async function main() {
  console.log("=== MIDL Editor Fix Verifications ===");
  console.log("Harness:", HARNESS_URL);

  const browser = await chromium.launch({ headless: true });
  const results = { decimals: null, decimalsText: null, span: null, spanWider: null };

  // ══════════════════════════════════════════════════════════════════════
  // VERIFICATION 1: DECIMALS
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n[1] DECIMALS — inspector live-value readout format check");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();

    page.on("console", msg => {
      if (msg.type() === "error") console.log("  [page error]", msg.text().slice(0, 200));
    });

    await page.goto(HARNESS_URL);
    await waitForPreviewReady(page);
    await sleep(600);

    // Go to Elements tab, select cell-0 (SOG, decimals:1, unit:kn)
    await jsClick(page, "tab-elements");
    await sleep(400);
    await jsClick(page, "cell-0");
    await sleep(1000);

    // Wait for live-value-text to appear
    await page.waitForSelector('[data-testid="live-value-text"]', { timeout: 8000 }).catch(() => {
      console.warn("  WARN: live-value-text not found");
    });
    await sleep(500);

    const readoutText = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="live-value-text"]');
      return el ? el.textContent.trim() : null;
    });

    console.log("  Live-value readout text:", JSON.stringify(readoutText));
    results.decimalsText = readoutText;

    if (readoutText === null) {
      fail("DECIMALS", "live-value-text element not found");
      results.decimals = false;
    } else {
      const formattedPattern = /^\d+\.\d\s*kn$/;
      const longFloatPattern = /\d\.\d{4,}/;
      const isFormatted = formattedPattern.test(readoutText);
      const isLongFloat = longFloatPattern.test(readoutText);

      if (isFormatted && !isLongFloat) {
        pass("DECIMALS", `readout="${readoutText}" matches /^\\d+\\.\\d\\s*kn$/`);
        results.decimals = true;
      } else if (isLongFloat) {
        fail("DECIMALS", `readout="${readoutText}" is a long raw float (decimals fix not applied)`);
        results.decimals = false;
      } else {
        fail("DECIMALS", `readout="${readoutText}" does not match expected pattern /^\\d+\\.\\d\\s*kn$/`);
        results.decimals = false;
      }
    }

    await page.screenshot({ path: SHOT_DECIMALS, fullPage: false });
    console.log("  Screenshot:", SHOT_DECIMALS);

    await ctx.close();
  }

  // ══════════════════════════════════════════════════════════════════════
  // VERIFICATION 2: SPAN IN PREVIEW
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n[2] SPAN IN PREVIEW — colSpan=2 makes spanned tile wider in SVG");
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();

    page.on("console", msg => {
      if (msg.type() === "error") console.log("  [page error]", msg.text().slice(0, 200));
    });

    await page.goto(HARNESS_URL);
    await waitForPreviewReady(page);
    await sleep(600);

    // Step 1: Capture SVG BEFORE span (4-cell, 2x2, all tiles = 236-wide)
    const svgBefore = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="preview-host"]');
      return host ? host.innerHTML.trim() : "";
    });

    const tileWidthsBefore = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="preview-host"]');
      const svg = host ? host.querySelector("svg") : null;
      if (!svg) return [];
      return Array.from(svg.querySelectorAll("rect"))
        .map(r => ({ x: r.getAttribute("x"), w: r.getAttribute("width") }))
        .filter(r => r.x !== null); // exclude the background rect (x=null)
    });

    console.log("  Tile rects BEFORE span:", JSON.stringify(tileWidthsBefore));

    // Step 2: Switch to source mode and inject the valid span doc
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="mode-toggle"]');
      if (btn) btn.click();
    });
    await sleep(600);

    const textarea = page.locator('textarea[data-testid="source-textarea"]');
    await textarea.waitFor({ timeout: 5000 });

    // Use fill() to atomically replace the textarea content. This clears first,
    // then types the new value, and triggers React's onChange handler.
    await textarea.fill(SPAN_DOC);
    // Blur to trigger onBlur → applyText()
    await textarea.blur();
    await sleep(600);

    // Verify the source edit was accepted
    const sourceState = await page.evaluate(() => ({
      statusBar: document.querySelector('[data-testid="status-bar"]')?.textContent?.trim(),
      issues: Array.from(document.querySelectorAll('[data-testid="source-issues"] li')).map(l => l.textContent?.trim()),
    }));
    console.log("  Source edit status:", JSON.stringify(sourceState));

    // Step 3: Switch back to visual mode
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="mode-toggle"]');
      if (btn) btn.click();
    });
    await sleep(1200);

    await waitForPreviewReady(page).catch(() => console.warn("  WARN: preview-host empty after switch"));

    // Step 4: Select cell-0 to open inspector (shows span=2x1)
    await jsClick(page, "tab-elements");
    await sleep(400);
    await jsClick(page, "cell-0");
    await sleep(800);

    // Step 5: Capture SVG AFTER span doc is loaded
    const svgAfter = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="preview-host"]');
      return host ? host.innerHTML.trim() : "";
    });

    const tileWidthsAfter = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="preview-host"]');
      const svg = host ? host.querySelector("svg") : null;
      if (!svg) return [];
      return Array.from(svg.querySelectorAll("rect"))
        .map(r => ({ x: r.getAttribute("x"), y: r.getAttribute("y"), w: r.getAttribute("width"), h: r.getAttribute("height") }))
        .filter(r => r.x !== null);
    });

    console.log("  Tile rects AFTER span:", JSON.stringify(tileWidthsAfter));

    // Read span inspector value
    const spanSelectValue = await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="span-select"]');
      return sel ? sel.value : null;
    });
    console.log("  Inspector span-select value:", spanSelectValue);

    // Read status bar
    const visualStatus = await page.evaluate(() => ({
      statusBar: document.querySelector('[data-testid="status-bar"]')?.textContent?.trim(),
      previewError: document.querySelector('[data-testid="preview-error"]')?.textContent?.trim(),
    }));
    console.log("  Visual mode status:", JSON.stringify(visualStatus));

    // Screenshot
    await page.screenshot({ path: SHOT_SPAN, fullPage: false });
    console.log("  Screenshot:", SHOT_SPAN);

    // Assertions
    const svgChanged = svgBefore !== svgAfter && svgBefore.length > 100;
    console.log("  SVG changed:", svgChanged, `(before len=${svgBefore.length} after len=${svgAfter.length})`);

    // Measure tile widths
    // Before: tiles should all be ~236 wide (4 tiles in 2x2)
    // After: first tile should be ~476 wide (colSpan=2), rest ~236
    const beforeWidths = tileWidthsBefore.map(r => parseFloat(r.w)).filter(w => !isNaN(w));
    const afterWidths = tileWidthsAfter.map(r => parseFloat(r.w)).filter(w => !isNaN(w));
    const maxBeforeWidth = Math.max(...beforeWidths, 0);
    const maxAfterWidth = Math.max(...afterWidths, 0);

    console.log(`  Before tile widths: [${beforeWidths.join(", ")}] max=${maxBeforeWidth}`);
    console.log(`  After tile widths: [${afterWidths.join(", ")}] max=${maxAfterWidth}`);
    results.spanWider = maxAfterWidth > maxBeforeWidth;

    if (!svgChanged) {
      fail("SPAN IN PREVIEW", `SVG did not change (span doc may not have loaded correctly); before=${svgBefore.length} after=${svgAfter.length}`);
      results.span = false;
    } else if (!results.spanWider) {
      fail("SPAN IN PREVIEW", `SVG changed but spanned tile NOT wider (before max=${maxBeforeWidth}px after max=${maxAfterWidth}px)`);
      results.span = false;
    } else {
      pass("SPAN IN PREVIEW", `SVG changed AND spanned tile is wider: ${maxBeforeWidth}px → ${maxAfterWidth}px`);
      results.span = true;
    }

    await ctx.close();
  }

  await browser.close();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n=== RESULTS ===");
  console.log(`  DECIMALS: ${results.decimals ? "PASS" : "FAIL"} — readout="${results.decimalsText}"`);
  console.log(`  SPAN IN PREVIEW: ${results.span ? "PASS" : "FAIL"} — tile wider: ${results.spanWider}`);
  console.log(`  shot-decimals: ${SHOT_DECIMALS}`);
  console.log(`  shot-span: ${SHOT_SPAN}`);

  if (!results.decimals || !results.span) {
    process.exitCode = 1;
  }
})().catch(err => {
  console.error("Fatal:", err);
  process.exitCode = 1;
});
