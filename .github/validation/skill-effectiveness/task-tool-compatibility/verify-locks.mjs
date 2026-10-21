// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]), evidence = resolve(process.argv[3]);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const versions = entries => {
  const result = new Map();
  for (const [name, version] of entries) {
    if (!result.has(name)) result.set(name, new Set());
    result.get(name).add(version);
  }
  return result;
};
const compare = (before, after, approved) => {
  const changes = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const previous = [...(before.get(name) ?? [])].sort();
    const current = [...(after.get(name) ?? [])].sort();
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    assert.ok(Object.hasOwn(approved, name), "Unapproved package version change: " + name);
    assert.deepEqual(current, [approved[name]], name);
    changes.push({ name, before: previous, after: current });
  }
  return changes;
};
const npmEntries = lock => Object.entries(lock.packages)
  .filter(([name, value]) => name && value.version)
  .map(([path, value]) => {
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    assert.ok(value.resolved?.startsWith("https://registry.npmjs.org/"), name);
    assert.ok(value.integrity?.startsWith("sha512-"), name);
    return [name, value.version];
  });
const uvEntries = text => {
  for (const match of text.matchAll(/https:\/\/([^/"\s]+)/g)) {
    assert.ok(["pypi.org", "files.pythonhosted.org"].includes(match[1]), "Noncanonical Python source");
  }
  return text.split("[[package]]").slice(1).map(block => {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    assert.ok(name && version, "Invalid locked Python package");
    return [name, version];
  });
};
const renderer = JSON.parse(readFileSync(join(root, "renderer", "package-lock.json")));
const oldRenderer = JSON.parse(readFileSync(join(evidence, "renderer.before.json")));
const result = {
  scope: "Public lock generation and package-graph verification only; no browser, model or evaluation execution",
  renderer: compare(versions(npmEntries(oldRenderer)), versions(npmEntries(renderer)),
    { react: "19.3.0", "react-dom": "19.3.0", puppeteer: "25.13.0",
      "puppeteer-core": "25.13.0", "@puppeteer/browsers": "3.2.4",
      "@tanstack/react-virtual": "3.14.19", "@tanstack/virtual-core": "3.19.4",
      cytoscape: "3.34.3", lilconfig: "3.1.3", "modern-tar": "0.8.5" }),
  python: {},
};
for (const name of ["catalog", "notebook"]) {
  const file = join(root, name, "uv.lock");
  result.python[name] = {
    changes: compare(versions(uvEntries(readFileSync(join(evidence, name + ".before.lock"), "utf8"))),
      versions(uvEntries(readFileSync(file, "utf8"))),
      { platformdirs: "4.13.0", pluggy: "1.6.0", fonttools: "4.66.1", mistune: "3.3.4" }),
    sha256: hash(file),
  };
}
result.rendererLockSha256 = hash(join(root, "renderer", "package-lock.json"));
writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
