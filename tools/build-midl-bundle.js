#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// (Re)build the self-contained MIDL browser bundles from the
// `midl` submodule and copy them into public/, where the SignalK plugin serves
// them as part of its webapp:
//   * @yey-boats/midl-web device bundle -> public/midl-device.global.js
//   * @yey-boats/midl-editor global     -> public/midl-editor.global.js
//                                          (+ byte-identical e2e/editor-demo copy)
// The built files are committed and ship in the plugin; run this to refresh
// them after a submodule bump.
//
//   npm run build:midl-bundle
//
// Steps: build midl/ts (the validator+solver), then build midl/web's device
// entry (vite.device.config.ts -> dist-device/midl-device.global.js) and
// midl/editor's global entry (vite.global.config.ts ->
// dist-global/midl-editor.global.js), then copy.
//
// midl/web and midl/editor declare `"@yey-boats/midl*": "*"` dependencies,
// which 404 on `npm install` (they are resolved via Vite aliases to the
// sibling sources, NOT from npm). We install AROUND them: temporarily strip
// those lines, install, build, restore.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TS = path.join(ROOT, "midl", "ts");
const WEB = path.join(ROOT, "midl", "web");
const EDITOR = path.join(ROOT, "midl", "editor");
const BUNDLE = path.join(WEB, "dist-device", "midl-device.global.js");
const DEST = path.join(ROOT, "public", "midl-device.global.js");
const EDITOR_BUNDLE = path.join(EDITOR, "dist-global", "midl-editor.global.js");
const EDITOR_DESTS = [
  path.join(ROOT, "public", "midl-editor.global.js"),
  path.join(ROOT, "e2e", "editor-demo", "midl-editor.global.js"),
];

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (in ${path.relative(ROOT, cwd) || "."})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

// The builds below touch files the midl repo tracks (npm rewrites the
// workspace lockfile; the editor build overwrites midl's own committed
// editor/dist-global bundle). Snapshot them and put them back afterwards so a
// rebuild never leaves the submodule dirty.
const MIDL_TRACKED_OUTPUTS = [
  path.join(ROOT, "midl", "package-lock.json"),
  EDITOR_BUNDLE,
].filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f)]);
// midl/ts has no lockfile of its own (the workspace root holds it); drop the
// one its standalone `npm install` writes unless it was already there.
const TS_LOCK = path.join(TS, "package-lock.json");
const tsLockExisted = fs.existsSync(TS_LOCK);
function restoreMidlTracked() {
  for (const [f, buf] of MIDL_TRACKED_OUTPUTS) fs.writeFileSync(f, buf);
  if (!tsLockExisted) fs.rmSync(TS_LOCK, { force: true });
}

// Install + build a package with its unresolvable workspace deps stripped from
// package.json for the duration (restored afterwards, even on failure).
function buildAround(dir, script) {
  const pkg = path.join(dir, "package.json");
  const original = fs.readFileSync(pkg, "utf8");
  const stripped = original.replace(/^\s*"@yey-boats\/midl(-web)?":\s*"\*",?\s*\n/gm, "");
  try {
    fs.writeFileSync(pkg, stripped);
    run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], dir);
    run("npm", ["run", script], dir);
  } finally {
    fs.writeFileSync(pkg, original);
  }
}

// Copy a single-file bundle into the plugin (public/ is the webapp root).
function copy(src, dest) {
  fs.copyFileSync(src, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`OK: copied ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dest)} (${kb} KB)`);
}
try {
  // 1. Build the validator/solver the device bundle inlines.
  run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], TS);
  run("npm", ["run", "build"], TS);

  // 2. Build the device bundle and the editor bundle.
  buildAround(WEB, "build:device");
  buildAround(EDITOR, "build:global");

  console.log("");
  copy(BUNDLE, DEST);
  for (const dest of EDITOR_DESTS) copy(EDITOR_BUNDLE, dest);
} finally {
  restoreMidlTracked();
}
