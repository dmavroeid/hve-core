// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const adapter = fileURLToPath(new URL(
  "../../../../.evidence-preflight/grading/detailed-data-catalog/check-submission.mjs",
  import.meta.url,
));

test("embedded output probe contains no native eval parameter placeholders", () => {
  const source = readFileSync(new URL("./output-probe.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("${"), "Embedded JavaScript must use concatenation, not eval parameters");
});

for (const id of ["detailed-analysis-authoring", "generic-analysis-authoring",
  "detailed-c4-architecture", "generic-c4-architecture"]) {
  test(id + " rejects an output-root override outside the dedicated mount", () => {
    const file = fileURLToPath(new URL(
      "../../../../.evidence-preflight/grading/" + id + "/check-submission.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [file], {
      env: { ...process.env, HVE_GRADE_OUTPUT_ROOT: "/unexpected-host-path" },
      encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid dedicated grade-output root/);
  });
}

function runChecker(t, script) {
  const root = mkdtempSync(join(tmpdir(), "catalog adapter "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = join(root, "assets");
  const snapshot = join(root, "snapshot");
  const workspace = join(root, "workspace");
  mkdirSync(join(assets, "task-fixture"), { recursive: true });
  mkdirSync(join(snapshot, "deliverable"), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(snapshot, "deliverable", "northlake-ds-catalog.md"), "Trusted synthetic control\n");
  if (script !== null) writeFileSync(join(assets, "task-fixture", "check.mjs"), script);
  const result = spawnSync(process.execPath, [adapter], {
    env: { ...process.env, EVALUATE_ASSETS: assets,
      EVALUATE_ARTIFACT_DIR: snapshot, EVALUATE_WORKSPACE: workspace },
    encoding: "utf8", timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, workspace };
}

test("catalog bootstrap preserves checker arguments, cwd and clean child environment", t => {
  const result = runChecker(t, [
    'import assert from "node:assert/strict";',
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'assert.equal(process.argv[1], join(process.env.EVALUATE_ASSETS, "task-fixture", "check.mjs"));',
    'assert.equal(process.argv[2], "deliverable/northlake-ds-catalog.md");',
    'assert.equal(process.cwd(), join(process.env.EVALUATE_WORKSPACE, "execution"));',
    'assert.equal(process.env.NODE_TEST_CONTEXT, undefined);',
    'assert.equal(process.env.NODE_OPTIONS, undefined);',
    'writeFileSync("validated.txt", "passed");',
  ].join("\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(result.workspace, "execution", "validated.txt"), "utf8"), "passed");
});

test("deliberate catalog rejection retains measured exit 1", t => {
  const result = runChecker(t, "process.exit(1);\n");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
});

test("missing Node dependency is an operational error with loader diagnostics", t => {
  const result = runChecker(t, 'import "skill-effectiveness-deliberately-missing-dependency";\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Checker operational failure/);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("missing checker entrypoint is an operational error", t => {
  const result = runChecker(t, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Checker operational failure/);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("checker syntax errors retain operational classification", t => {
  const result = runChecker(t, "export const invalid = ;\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Checker operational failure/);
  assert.match(result.stderr, /SyntaxError/);
});

test("checker-body exceptions retain operational diagnostics", t => {
  const result = runChecker(t, 'throw new Error("trusted checker exception");\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Checker operational failure.*trusted checker exception/);
});

test("explicit checker setup exit 2 remains an operational error", t => {
  const result = runChecker(t, 'console.error("trusted checker setup error"); process.exit(2);\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Checker operational failure.*trusted checker setup error/);
});
