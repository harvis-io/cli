#!/usr/bin/env node
"use strict";

// The CLI is published to npm twice from this one folder: as `harvis`, and
// under the `hosting` name for people who search npm for a hosting CLI. Both
// packages are byte-identical apart from the name — this rewrites package.json
// in place for the second publish. Restore it afterwards with
// `git checkout package.json`; nothing here is meant to be committed.

const fs = require("fs");
const path = require("path");

const name = process.argv[2];
if (!name) {
  console.error("Usage: node scripts/alias-package.js <package-name>");
  process.exit(1);
}

const file = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
const [target] = Object.values(pkg.bin);
if (!target) {
  console.error("package.json has no bin entry to alias");
  process.exit(1);
}

pkg.name = name;
// One command per package: installing both globally must not fight over the
// same name in the PATH. The CLI reads the name it was invoked as, so its
// help and error text follows.
pkg.bin = { [name]: target };

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
console.log(`package.json now publishes as ${name} (bin ${name} -> ${target})`);
