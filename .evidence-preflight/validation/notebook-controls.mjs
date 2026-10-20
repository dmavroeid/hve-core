import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDefaultGraderRegistry, hasGraderError } from "@microsoft/vally";
import { parse } from "yaml";
import { notebookControl } from "./notebook-control.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = { ...process.env };
delete environment.NODE_OPTIONS;
delete environment.NODE_TEST_CONTEXT;

function prepare(t, id, notebook = notebookControl(), summary = "Investigate high station medians and long waits. Synthetic observational data cannot establish maintenance effects.") {
  const directory = mkdtempSync(join(tmpdir(), "notebook-controls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const assets = join(root, "grading", id);
  const artifacts = join(directory, "artifacts");
  const workspace = join(directory, "native");
  mkdirSync(join(artifacts, "deliverable"), { recursive: true });
  mkdirSync(workspace);
  cpSync(join(assets, "task-fixture"), join(artifacts, "task-fixture"), { recursive: true });
  const notebookPath = join(artifacts, "deliverable", "queue-delay-analysis.ipynb");
  const summaryPath = join(artifacts, "deliverable", "summary.md");
  writeFileSync(notebookPath, JSON.stringify(notebook));
  writeFileSync(summaryPath, summary);
  const grade = parse(readFileSync(join(root, "evals", `${id}.grade.eval.yaml`), "utf8"))
    .stimuli[0].graders[0].config;
  return { assets, artifacts, workspace, notebookPath, summaryPath, grade };
}

function directCheck(context, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, [
    join(context.assets, "task-fixture", "check-notebook.mjs"),
    context.notebookPath, context.summaryPath,
  ], {
    cwd: context.artifacts, env: { ...environment, ...extraEnvironment },
    encoding: "utf8", timeout: 360000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function nativeGrade(context, extraEnvironment = {}) {
  // Native grading must execute from original inputs, not reuse direct-check exports.
  for (const name of ["figures", "queue-delay-analysis.executed.ipynb"]) {
    const generated = join(context.artifacts, "deliverable", name);
    if (existsSync(generated)) rmSync(generated, { recursive: true });
  }
  return createDefaultGraderRegistry().get("program").grade({
    trajectory: { workDir: context.workspace, assetsDir: context.assets, artifactDir: context.artifacts },
    config: { ...context.grade, program: process.execPath, env: extraEnvironment },
  });
}

function verifyExecuted(directory) {
  const executed = JSON.parse(readFileSync(join(directory, "queue-delay-analysis.executed.ipynb"), "utf8"));
  const cells = executed.cells.filter(cell => cell.cell_type === "code");
  assert.ok(cells.length > 0);
  assert.ok(cells.every(cell => Number.isInteger(cell.execution_count) && cell.execution_count > 0));
  const outputs = cells.flatMap(cell => cell.outputs);
  assert.equal(outputs.filter(output => output.output_type === "error").length, 0);
  assert.match(JSON.stringify(outputs), /CONTROL_EXECUTED rows=60000 stations=80/);
  const figures = readdirSync(join(directory, "figures")).filter(file => file.endsWith(".png"));
  assert.equal(figures.length, 8);
  for (const file of figures) {
    const bytes = readFileSync(join(directory, "figures", file));
    assert.ok(bytes.length > 1000);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
}

for (const id of ["detailed-analysis-authoring", "generic-analysis-authoring"]) {
  test(`${id}: actual notebook execution and PNG exports pass directly and natively`,
    { timeout: 360000 }, async t => {
      const context = prepare(t, id);
      const original = readFileSync(context.notebookPath);
      const direct = directCheck(context);
      assert.equal(direct.status, 0, direct.stdout + direct.stderr);
      verifyExecuted(join(context.artifacts, "deliverable"));
      const result = await nativeGrade(context);
      assert.equal(result.passed, true, JSON.stringify(result));
      assert.equal(hasGraderError(result), false, JSON.stringify(result));
      verifyExecuted(join(context.workspace, "execution", "deliverable"));
      assert.deepEqual(readFileSync(context.notebookPath), original);
    });

  test(`${id}: a real cell exception is a task failure rather than a grader error`,
    { timeout: 180000 }, async t => {
      const notebook = notebookControl();
      notebook.cells = notebook.cells.slice(0, 2);
      notebook.cells[1].source = 'raise ValueError("CONTROL_WRONG_CELL")';
      const context = prepare(t, id, notebook);
      const direct = directCheck(context);
      assert.equal(direct.status, 1, direct.stdout + direct.stderr);
      assert.match(direct.stderr, /CONTROL_WRONG_CELL/);
      const result = await nativeGrade(context);
      assert.equal(result.passed, false, JSON.stringify(result));
      assert.equal(hasGraderError(result), false, JSON.stringify(result));
    });
}

test("notebook missing PNG exports fail task grading after successful kernel execution",
  { timeout: 180000 }, async t => {
    const notebook = notebookControl();
    notebook.cells = notebook.cells.slice(0, 2);
    notebook.cells[1].source = 'print("CONTROL_NO_PNG")';
    const context = prepare(t, "detailed-analysis-authoring", notebook);
    const direct = directCheck(context);
    assert.equal(direct.status, 1, direct.stdout + direct.stderr);
    assert.match(direct.stderr, /Missing required PNG chart exports/);
    const result = await nativeGrade(context);
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(hasGraderError(result), false, JSON.stringify(result));
  });

test("protected grading corrects the original checker's missing-kernel misclassification",
  { timeout: 180000 }, async t => {
    const context = prepare(t, "detailed-analysis-authoring");
    const overrides = { QUEUE_DELAY_NOTEBOOK_KERNEL: "missing-control-kernel" };
    const direct = directCheck(context, overrides);
    assert.equal(direct.status, 1, direct.stdout + direct.stderr);
    assert.match(direct.stderr, /NoSuchKernel|No such kernel/);
    const result = await nativeGrade(context, overrides);
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(hasGraderError(result), true, JSON.stringify(result));
    assert.equal(existsSync(join(context.workspace, "execution", "deliverable", "figures")), false);
  });
