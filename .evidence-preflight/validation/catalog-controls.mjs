import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDefaultGraderRegistry, hasGraderError } from "@microsoft/vally";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "grading", "detailed-data-catalog");
const checker = join(assets, "task-fixture", "check.mjs");
const validator = join(assets, "task-fixture", "contract", "scripts", "validate_catalog.py");
const control = readFileSync(join(root, "validation", "controls", "catalog", "valid-catalog.md"), "utf8");
const grade = parse(readFileSync(join(root, "evals", "detailed-data-catalog.grade.eval.yaml"), "utf8"))
  .stimuli[0].graders[0].config;
const environment = { ...process.env };
delete environment.NODE_OPTIONS;
delete environment.NODE_TEST_CONTEXT;

function prepare(t, content) {
  const directory = mkdtempSync(join(tmpdir(), "catalog-controls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifacts = join(directory, "artifacts");
  const workspace = join(directory, "native");
  mkdirSync(join(artifacts, "deliverable"), { recursive: true });
  mkdirSync(workspace);
  cpSync(join(assets, "task-fixture"), join(artifacts, "task-fixture"), { recursive: true });
  const catalog = join(artifacts, "deliverable", "northlake-ds-catalog.md");
  writeFileSync(catalog, content);
  return { artifacts, workspace, catalog };
}

function execute(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd, env: environment, encoding: "utf8", timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function nativeGrade(context) {
  return createDefaultGraderRegistry().get("program").grade({
    trajectory: { workDir: context.workspace, assetsDir: assets, artifactDir: context.artifacts },
    config: { ...grade, program: process.execPath },
  });
}

test("catalog valid control passes the original Python-backed checker and native program grader",
  { timeout: 180000 }, async t => {
    const context = prepare(t, control);
    const direct = execute(process.execPath, [checker, context.catalog], context.artifacts);
    assert.equal(direct.status, 0, direct.stdout + direct.stderr);
    assert.match(direct.stdout, /passed contract and machine-fact checks/);
    const result = await nativeGrade(context);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(hasGraderError(result), false, JSON.stringify(result));
  });

test("catalog schema-valid wrong inventory value fails task grading, not checker startup",
  { timeout: 180000 }, async t => {
    assert.ok(control.includes("row_estimate: 1200"));
    const context = prepare(t, control.replace("row_estimate: 1200", "row_estimate: 1"));
    const schema = execute(process.env.CATALOG_PYTHON ?? "python",
      [validator, context.catalog], context.artifacts);
    assert.equal(schema.status, 0, schema.stdout + schema.stderr);
    const direct = execute(process.execPath, [checker, context.catalog], context.artifacts);
    assert.equal(direct.status, 1, direct.stdout + direct.stderr);
    assert.match(direct.stderr, /entity asset volume mismatch/);
    const result = await nativeGrade(context);
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(hasGraderError(result), false, JSON.stringify(result));
  });
