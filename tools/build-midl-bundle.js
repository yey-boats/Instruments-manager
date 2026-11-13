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
// Steps: install the midl workspace, build midl/ts (the validator+solver), then build midl/web's device
// entry (vite.device.config.ts -> dist-device/midl-device.global.js) and
// midl/editor's global entry (vite.global.config.ts ->
// dist-global/midl-editor.global.js), then copy.
//
// midl is an npm workspace monorepo (ts, web, editor) whose packages depend on
// each other by version; the Vite configs alias them to the sibling sources.
// So we install once at the midl root (workspaces link the siblings) and run
// each build with `-w`.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
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

// The builds below may touch files the midl repo tracks (npm can rewrite the
// workspace lockfile). Snapshot them and put them back afterwards so a
// rebuild never leaves the submodule dirty.
const MIDL = path.join(ROOT, "midl");
const MIDL_TRACKED_OUTPUTS = [
  path.join(MIDL, "package-lock.json"),
].filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f)]);
function restoreMidlTracked() {
  for (const [f, buf] of MIDL_TRACKED_OUTPUTS) fs.writeFileSync(f, buf);
}

// Copy a single-file bundle into the plugin (public/ is the webapp root).
function copy(src, dest) {
  fs.copyFileSync(src, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(0);
  console.log(`OK: copied ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dest)} (${kb} KB)`);
}
try {
  // 1. Install the workspace and build the validator/solver (midl/ts/dist,
  //    which lib/midl.js requires and the device bundle inlines).
  run("npm", ["ci", "--no-audit", "--no-fund"], MIDL);
  run("npm", ["run", "build", "-w", "@yey-boats/midl"], MIDL);

  // 2. Build the device bundle and the editor bundle.
  run("npm", ["run", "build:device", "-w", "@yey-boats/midl-web"], MIDL);
  run("npm", ["run", "build:global", "-w", "@yey-boats/midl-editor"], MIDL);

  console.log("");
  copy(BUNDLE, DEST);
  for (const dest of EDITOR_DESTS) copy(EDITOR_BUNDLE, dest);
} finally {
  restoreMidlTracked();
}
