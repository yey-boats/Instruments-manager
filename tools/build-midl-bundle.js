#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Reproducibly (re)build the self-contained @yey-boats/midl-web device bundle
// from the `midl` submodule and copy it into public/, where the SignalK plugin
// serves it as part of its webapp. The built file public/midl-device.global.js
// is committed and ships in the plugin; run this to refresh it after a submodule
// bump.
//
//   npm run build:midl-bundle
//
// Steps: build midl/ts (the validator+solver), then build midl/web's device
// entry (vite.device.config.ts -> dist-device/midl-device.global.js), then copy.
//
// midl/web/package.json declares `"@yey-boats/midl": "*"`, which 404s on
// `npm install` (it is resolved via a Vite alias to ../ts/src, NOT from npm).
// We install AROUND it: temporarily strip that line, install, build, restore.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TS = path.join(ROOT, "midl", "ts");
const WEB = path.join(ROOT, "midl", "web");
const WEB_PKG = path.join(WEB, "package.json");
const BUNDLE = path.join(WEB, "dist-device", "midl-device.global.js");
const DEST = path.join(ROOT, "public", "midl-device.global.js");

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (in ${path.relative(ROOT, cwd) || "."})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

// 1. Build the validator/solver the device bundle inlines.
run("npm", ["install", "--no-audit", "--no-fund"], TS);
run("npm", ["run", "build"], TS);

// 2. Build the device bundle, installing AROUND the unresolvable npm dep.
const original = fs.readFileSync(WEB_PKG, "utf8");
const stripped = original.replace(/^\s*"@yey-boats\/midl":\s*"\*",?\s*\n/m, "");
try {
  fs.writeFileSync(WEB_PKG, stripped);
  run("npm", ["install", "--no-audit", "--no-fund"], WEB);
  run("npm", ["run", "build:device"], WEB);
} finally {
  fs.writeFileSync(WEB_PKG, original);
}

// 3. Copy the single-file bundle into public/ (the plugin webapp root).
fs.copyFileSync(BUNDLE, DEST);
const kb = (fs.statSync(DEST).size / 1024).toFixed(0);
console.log(`\nOK: copied device bundle -> ${path.relative(ROOT, DEST)} (${kb} KB)`);
