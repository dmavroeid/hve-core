import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDefaultGraderRegistry, hasGraderError } from "@microsoft/vally";
import sharp from "sharp";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = { ...process.env };
delete environment.NODE_OPTIONS;
delete environment.NODE_TEST_CONTEXT;
const names = ["legend", "system-context", "container", "component", "deployment"];
const blocks = [
  'flowchart LR\n  person["Person"] --> software["Software system"]',
  'flowchart LR\n  caller["API caller"] --> dab["Data API builder"]\n  dab --> database[("Database")]',
  'flowchart LR\n  client["REST client"] --> service["ASP.NET service"]\n  service --> database[("SQL database")]',
  'flowchart LR\n  controller["REST controller"] --> authorization["Authorization"]\n  authorization --> resolver["Query resolver"]',
  'flowchart LR\n  host["Application host"] --> service["DAB process"]\n  service --> sql["Database host"]',
];
const document = values => values.map((value, index) =>
  `## ${names[index]}\n\n\`\`\`mermaid\n${value}\n\`\`\`\n`).join("\n");

function prepare(t, id, content) {
  const directory = mkdtempSync(join(tmpdir(), "trusted-c4-controls-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifacts = join(directory, "artifacts");
  const workspace = join(directory, "native");
  const assets = join(root, "grading", id);
  mkdirSync(join(artifacts, "deliverable"), { recursive: true });
  mkdirSync(workspace);
  const submission = join(artifacts, "deliverable", "architecture-pack.md");
  if (content !== undefined) writeFileSync(submission, content);
  const grade = parse(readFileSync(join(root, "evals", `${id}.grade.eval.yaml`), "utf8"))
    .stimuli[0].graders[0].config;
  return { artifacts, workspace, assets, submission, grade, id };
}

function direct(context, extraEnv = {}) {
  const result = spawnSync(process.execPath,
    [join(context.assets, "task-fixture", "check.mjs"), context.submission], {
      cwd: context.artifacts, env: { ...environment, ...extraEnv },
      encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
    });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function native(context, extraEnv = {}) {
  return createDefaultGraderRegistry().get("program").grade({
    trajectory: {
      workDir: context.workspace, assetsDir: context.assets, artifactDir: context.artifacts,
    },
    config: { ...context.grade, program: process.execPath, env: extraEnv },
  });
}

async function inspectImages(directory, label) {
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith(".png")).sort(),
    names.map(name => `${name}.png`).sort());
  const images = [];
  for (const name of names) {
    const file = join(directory, `${name}.png`);
    const bytes = readFileSync(file);
    const metadata = await sharp(bytes).metadata();
    const statistics = await sharp(bytes).stats();
    assert.equal(metadata.format, "png");
    assert.ok(metadata.width > 0 && metadata.height > 0);
    assert.ok(statistics.channels.some(channel => channel.stdev > 2), "Nonblank rendered pixels");
    images.push({
      name, bytes: bytes.length, width: metadata.width, height: metadata.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const output = process.env.C4_CONTROL_EVIDENCE_DIR;
  assert.ok(output, "Explicit control-evidence output directory is required");
  mkdirSync(output, { recursive: true });
  cpSync(directory, join(output, label), { recursive: true });
  writeFileSync(join(output, `${label}.json`), JSON.stringify(images, null, 2) + "\n");
}

for (const id of ["detailed-c4-architecture", "generic-c4-architecture"]) {
  test(`${id}: five trusted Mermaid diagrams render directly and through native grading`,
    { timeout: 360000 }, async t => {
      const context = prepare(t, id, document(blocks));
      const result = direct(context);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      await inspectImages(join(context.artifacts, "deliverable", "rendered"), `${id}-direct`);
      rmSync(join(context.artifacts, "deliverable", "rendered"), { recursive: true });
      const graded = await native(context);
      assert.equal(graded.passed, true, JSON.stringify(graded));
      assert.equal(hasGraderError(graded), false, JSON.stringify(graded));
      await inspectImages(join(context.workspace, "execution", "deliverable", "rendered"), `${id}-native`);
    });

  test(`${id}: four diagrams are a measured contract failure`,
    { timeout: 30000 }, async t => {
      const context = prepare(t, id, document(blocks.slice(0, 4)));
      const result = direct(context);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Expected five Mermaid blocks/);
      const graded = await native(context);
      assert.equal(graded.passed, false, JSON.stringify(graded));
      assert.equal(hasGraderError(graded), false, JSON.stringify(graded));
    });

  test(`${id}: absent delivery fails without invoking the renderer`,
    { timeout: 30000 }, async t => {
      const context = prepare(t, id, undefined);
      const graded = await native(context, { MERMAID_CLI: "" });
      assert.equal(graded.passed, false, JSON.stringify(graded));
      assert.equal(hasGraderError(graded), false, JSON.stringify(graded));
      assert.match(JSON.stringify(graded), /Required deliverable missing/);
    });

  test(`${id}: invalid Mermaid syntax remains an operationally ambiguous renderer error`,
    { timeout: 180000 }, async t => {
      const context = prepare(t, id, document(["this is not Mermaid syntax", ...blocks.slice(1)]));
      const result = direct(context);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Mermaid render failed/);
      const graded = await native(context);
      assert.equal(graded.passed, false, JSON.stringify(graded));
      assert.equal(hasGraderError(graded), true, JSON.stringify(graded));
      assert.match(JSON.stringify(graded), /ambiguous renderer failure/);
    });
}

test("unavailable browser executable is operational error, not measured architecture failure",
  { timeout: 180000 }, async t => {
    const context = prepare(t, "detailed-c4-architecture", document(blocks));
    const config = join(context.workspace, "unavailable-browser.json");
    writeFileSync(config, JSON.stringify({ executablePath: join(context.workspace, "missing-browser") }));
    const extraEnv = { MERMAID_BROWSER_CONFIG: config };
    const result = direct(context, extraEnv);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Mermaid render failed/);
    const graded = await native(context, extraEnv);
    assert.equal(graded.passed, false, JSON.stringify(graded));
    assert.equal(hasGraderError(graded), true, JSON.stringify(graded));
  });

test("five semantically irrelevant diagrams still pass the syntax-only checker",
  { timeout: 360000 }, async t => {
    const context = prepare(t, "detailed-c4-architecture",
      document(names.map(() => 'flowchart LR\n  apples["Apples"] --> oranges["Oranges"]')));
    const graded = await native(context);
    assert.equal(graded.passed, true, JSON.stringify(graded));
    assert.equal(hasGraderError(graded), false, JSON.stringify(graded));
    await inspectImages(join(context.workspace, "execution", "deliverable", "rendered"), "irrelevant-diagrams");
  });
