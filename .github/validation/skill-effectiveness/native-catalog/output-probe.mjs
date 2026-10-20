// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const report = (passed, evidence, status) => console.log(JSON.stringify({
  name: "output-storage", kind: "code", passed, score: passed ? 1 : 0,
  evidence, ...(status ? { status } : {}),
}));

try {
  const directory = "/grade-output";
  const output = lstatSync(directory);
  assert.ok(output.isDirectory() && !output.isSymbolicLink(), "Output must be a regular directory");
  const input = join(process.env.EVALUATE_ARTIFACT_DIR, "deliverable", "northlake-ds-catalog.md");
  const reference = join(process.env.EVALUATE_ASSETS, "probe.mjs");
  const bytes = readFileSync(input);
  const digest = createHash("sha256").update(bytes).digest("hex");
  for (const file of [input, reference]) {
    const before = readFileSync(file);
    assert.throws(() => writeFileSync(file, "must not modify inputs", { flag: "a" }),
      error => ["EROFS", "EACCES", "EPERM"].includes(error.code),
      "Original input/reference must reject writes");
    assert.deepEqual(readFileSync(file), before);
  }
  assert.equal(existsSync(process.argv[1]), false, "Unmounted host sibling must not be visible");
  writeFileSync(join(directory, "derived.json"), JSON.stringify({
    kind: "trusted-model-free-derived-output",
    inputSha256: digest,
    inputBytes: bytes.length,
    nonemptyLines: bytes.toString("utf8").split(/\r?\n/).filter(line => line.trim()).length,
    readonlyInputChecks: 2,
  }, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  report(true, "Generated derived.json in the dedicated output mount; original inputs rejected writes");
} catch (error) {
  report(false, error.name + ": " + (error.code ?? "") + " " + error.message, "error");
}
