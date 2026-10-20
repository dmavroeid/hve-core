import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";
import { createDefaultGraderRegistry, hasGraderError } from "@microsoft/vally";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "preparation.json"), "utf8"));
const digest = value => createHash("sha256").update(value).digest("hex");
const spec = file => parse(readFileSync(join(root, "evals", file), "utf8"));
const cli = join(root, "node_modules", "@microsoft", "vally-cli", "dist", "index.js");
const environment = { ...process.env, DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
for (const key of ["NODE_OPTIONS", "NODE_TEST_CONTEXT", "SKILL_EVAL_INVENTORY_DIR",
  "EVALUATE_USE_HOST_COPILOT_HOME"]) delete environment[key];
const run = (args, options = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: "utf8", timeout: 90000,
    maxBuffer: 4 * 1024 * 1024, env: environment, ...options,
  });
  assert.ifError(result.error);
  return result;
};

test("all archived public fixtures, skills and trusted copies remain byte-identical", () => {
  for (const file of manifest.preservedFiles) {
    assert.equal(digest(readFileSync(join(root, file.path))), file.sha256, file.path);
  }
});

test("all frozen task-quality, visual and adherence instruction prefixes survive without old submissions", () => {
  assert.equal(manifest.reviewInstructions.length, 8);
  for (const entry of manifest.reviewInstructions) {
    const bytes = readFileSync(join(root, entry.path));
    assert.equal(digest(bytes), entry.sha256);
    assert.ok(entry.cases.length > 0);
    assert.doesNotMatch(bytes.toString(), /ASSESSMENT EVIDENCE|ORIGINAL TASK/);
  }
  assert.deepEqual([...new Set(manifest.reviewInstructions.map(entry => entry.category))].sort(),
    ["instructions", "quality-image", "quality-text"]);
});

for (const entry of manifest.cases) {
  test(`${entry.id}: unchanged prompt, separated roles and authenticated checker`, () => {
    const candidate = spec(`${entry.id}.eval.yaml`);
    assert.equal(digest(candidate.stimuli[0].prompt), entry.promptSha256);
    assert.ok(candidate.stimuli[0].graders.every(g => ["completed", "file-exists"].includes(g.type)));
    assert.deepEqual(candidate.defaults.executor.config.sessionPolicy.availableTools, []);
    assert.deepEqual(candidate.agent_environment.files, [{
      src: `../fixtures/${entry.id}/public`, dest: "task-fixture",
    }]);
    if (entry.executableChecker) {
      const grade = spec(`${entry.id}.grade.eval.yaml`);
      assert.equal(grade.agent_environment, undefined);
      assert.equal(grade.stimuli[0].name, candidate.stimuli[0].name);
      assert.equal(grade.stimuli[0].graders[0].config.args.at(-1),
        digest(readFileSync(join(root, entry.gradeAssets, "check-submission.mjs"))));
    } else {
      assert.equal(entry.id, "generic-data-catalog");
      assert.equal(existsSync(join(root, "evals", `${entry.id}.grade.eval.yaml`)), false);
    }
    if (entry.review) {
      const review = spec(`${entry.id}.review.eval.yaml`).stimuli[0];
      assert.equal(digest(JSON.stringify(review.graders)), entry.reviewGradersSha256);
      assert.equal(digest(JSON.stringify(review.rubric ?? null)), entry.rubricSha256);
      assert.equal(digest(review.prompt), entry.promptSha256);
    }
  });

  test(`${entry.id}: current native strict lint for every role`, { timeout: 180000 }, () => {
    for (const suffix of ["eval", ...(entry.executableChecker ? ["grade.eval"] : []),
      ...(entry.review ? ["review.eval"] : [])]) {
      const file = `evals/${entry.id}.${suffix}.yaml`;
      const result = run([cli, "lint", "--strict", "--eval-spec", file]);
      assert.equal(result.status, 0, file + "\n" + result.stdout + result.stderr);
    }

    test("protected p-map checker accepts the original valid control and rejects a wrong implementation", async t => {
      const entry = manifest.cases.find(item => item.id === "detailed-p-map");
      const scratch = mkdtempSync(join(tmpdir(), "evidence-behavior-"));
      t.after(() => rmSync(scratch, { recursive: true, force: true }));
      const artifacts = join(scratch, "artifacts");
      mkdirSync(join(artifacts, "deliverable"), { recursive: true });
      const candidate = join(artifacts, entry.artifact);
      const grade = spec(`${entry.id}.grade.eval.yaml`).stimuli[0].graders[0].config;
      const invoke = name => {
        const workspace = join(scratch, name); mkdirSync(workspace);
        return run(grade.args, { env: { ...environment, EVALUATE_ASSETS: join(root, entry.gradeAssets),
          EVALUATE_ARTIFACT_DIR: artifacts, EVALUATE_WORKSPACE: workspace } });
      };
      writeFileSync(candidate, readFileSync(join(root, "validation/controls/p-map-valid.mjs")));
      const good = invoke("good");
      assert.equal(good.status, 0, good.stdout + good.stderr);
      assert.equal(JSON.parse(good.stdout).passed, true);
      const native = async name => {
        const workspace = join(scratch, name); mkdirSync(workspace);
        return createDefaultGraderRegistry().get("program").grade({
          trajectory: { workDir: workspace, assetsDir: join(root, entry.gradeAssets), artifactDir: artifacts },
          config: { ...grade, program: process.execPath },
        });
      };
      const validNative = await native("native-good");
      assert.equal(validNative.passed, true, JSON.stringify(validNative));
      assert.equal(hasGraderError(validNative), false);
      writeFileSync(candidate, "export async function* orderedConcurrentMap() { yield 'wrong'; }\n");
      const wrong = invoke("wrong");
      assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
      const invalidNative = await native("native-wrong");
      assert.equal(invalidNative.passed, false);
      assert.equal(hasGraderError(invalidNative), false, JSON.stringify(invalidNative));
    });

    for (const id of ["detailed-data-catalog", "detailed-analysis-authoring", "detailed-c4-architecture"]) {
      test(`${id}: real missing prerequisite remains an operational error`, async t => {
        const entry = manifest.cases.find(item => item.id === id);
        const scratch = mkdtempSync(join(tmpdir(), "evidence-startup-"));
        t.after(() => rmSync(scratch, { recursive: true, force: true }));
        const artifacts = join(scratch, "artifacts"), workspace = join(scratch, "workspace");
        mkdirSync(join(artifacts, "deliverable"), { recursive: true }); mkdirSync(workspace);
        writeFileSync(join(artifacts, entry.artifact), id.includes("data-catalog")
          ? readFileSync(join(root, "validation/controls/catalog/valid-catalog.md")) : "{}");
        if (id.includes("analysis-authoring")) writeFileSync(join(artifacts, "deliverable/summary.md"), "Control");
        const grade = spec(`${id}.grade.eval.yaml`).stimuli[0].graders[0].config;
        const missing = join(scratch, "missing-executable");
        const result = run(grade.args, { env: { ...environment,
          EVALUATE_ASSETS: join(root, entry.gradeAssets), EVALUATE_ARTIFACT_DIR: artifacts,
          EVALUATE_WORKSPACE: workspace, CATALOG_PYTHON: missing,
          QUEUE_DELAY_NOTEBOOK_PYTHON: missing, MERMAID_CLI: missing, MERMAID_BROWSER_CONFIG: missing,
        } });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.passed, false);
        assert.equal(report.status, "error");
        const nativeWorkspace = join(scratch, "native-workspace"); mkdirSync(nativeWorkspace);
        const native = await createDefaultGraderRegistry().get("program").grade({
          trajectory: { workDir: nativeWorkspace, assetsDir: join(root, entry.gradeAssets), artifactDir: artifacts },
          config: { ...grade, program: process.execPath, env: { CATALOG_PYTHON: missing,
            QUEUE_DELAY_NOTEBOOK_PYTHON: missing, MERMAID_CLI: missing, MERMAID_BROWSER_CONFIG: missing } },
        });
        assert.equal(native.passed, false);
        assert.equal(hasGraderError(native), true, JSON.stringify(native));
      });
    }
  });

  test(`${entry.id}: both native order definitions dry-run without calls`, { timeout: 180000 }, t => {
    const scratch = mkdtempSync(join(tmpdir(), "evidence-plan-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    for (const file of readdirSync(join(root, "experiments")).filter(f => f.startsWith(entry.id + "-"))) {
      const result = run([cli, "experiment", "run", "--dry-run",
        "--executor-plugin", "../scripts/restricted-copilot-executor.mjs",
        `experiments/${file}`, "--param", "AGENT_MODEL=mock", "--param", "JUDGE_MODEL=mock",
        "--output-dir", join(scratch, file), "--workspace", join(scratch, file + "-workspace")]);
      assert.equal(result.status, 0, file + "\n" + result.stdout + result.stderr);
      const experiment = parse(readFileSync(join(root, "experiments", file), "utf8"));
      for (const variant of Object.keys(experiment.variants)) assert.ok(result.stdout.includes(variant));
    }
  });

  if (entry.executableChecker) test(`${entry.id}: missing delivery and corrupted checker fail without execution`, t => {
    const scratch = mkdtempSync(join(tmpdir(), "evidence-gate-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const artifacts = join(scratch, "artifacts"), workspace = join(scratch, "workspace");
    mkdirSync(artifacts); mkdirSync(workspace);
    const grade = spec(`${entry.id}.grade.eval.yaml`).stimuli[0].graders[0].config;
    const env = { ...environment, EVALUATE_ASSETS: join(root, entry.gradeAssets),
      EVALUATE_ARTIFACT_DIR: artifacts, EVALUATE_WORKSPACE: workspace };
    const missing = run(grade.args, { env });
    assert.equal(missing.status, 0);
    const absent = JSON.parse(missing.stdout);
    assert.equal(absent.passed, false);
    assert.equal(absent.status, undefined);
    const badArgs = [...grade.args]; badArgs[badArgs.length - 1] = "0".repeat(64);
    const corrupt = run(badArgs, { env });
    assert.equal(JSON.parse(corrupt.stdout).status, "error");
    assert.equal(existsSync(join(workspace, "execution")), false);
  });
}
