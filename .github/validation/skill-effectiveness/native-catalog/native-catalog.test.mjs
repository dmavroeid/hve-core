// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";

assert.equal(process.env.GITHUB_REPOSITORY, "dmavroeid/hve-core");
assert.ok(process.env.RUNNER_TEMP);
const skill = process.cwd();
const root = join(process.env.RUNNER_TEMP, "native-catalog-qualification");
const safe = join(root, "safe");
const image = process.env.TASK_RUNTIME_IMAGE;
const baseImage = process.env.CATALOG_BASE_IMAGE;
assert.match(image, /^sha256:[a-f0-9]{64}$/);
assert.match(baseImage, /^sha256:[a-f0-9]{64}$/);
mkdirSync(safe, { recursive: true });
const { parse, stringify } = createRequire(join(skill, "package.json"))("yaml");
const packageRoot = resolve(skill, "../../../..", ".evidence-preflight");
const assets = join(packageRoot, "grading", "detailed-data-catalog");
const gradeSpec = join(packageRoot, "evals", "detailed-data-catalog.grade.eval.yaml");
const gradeBytes = readFileSync(gradeSpec);
const definition = parse(gradeBytes.toString("utf8"));
const cli = join(skill, "node_modules", "@microsoft", "vally-cli", "dist", "index.js");
const env = {
  PATH: process.env.PATH, HOME: join(root, "home"),
  DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1",
};
mkdirSync(env.HOME);
const hash = value => createHash("sha256").update(value).digest("hex");
const summary = {
  status: "running", image, baseImage, scope: "Native CLI Docker grading of trusted catalog controls; mock producer only",
  cases: [], containers: [], nativeGradeOutputRetained: false, originalsPreserved: false, cleanup: "pending",
  automaticSnapshotBinding: "Not supplied by native grade; operator-owned selection remains required",
};
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
persist();
const docker = (...args) => execFileSync("docker", args, {
  env, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024,
});
const files = directory => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const originalFiles = new Map();
const snapshots = new Map();
const volumes = new Set();
const inspected = new Set();
const verified = new Set();
let valid;
let wrong;

function native(args, directory, input, signal, extraEnv = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "command.json"), JSON.stringify({
    program: process.execPath, args: [cli, ...args], cwd: root,
    inputSha256: input === undefined ? null : hash(input),
    additionalEnvironment: extraEnv,
  }, null, 2) + "\n");
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], timeout: 240000, signal,
    });
    const stdout = [], stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, terminated) => {
      const output = Buffer.concat(stdout), errors = Buffer.concat(stderr);
      writeFileSync(join(directory, "native.stdout.jsonl"), output);
      writeFileSync(join(directory, "native.stderr.log"), errors);
      resolveChild({ code, terminated, stdout: output.toString("utf8"), stderr: errors.toString("utf8") });
    });
    child.stdin.end(input);
  });
}

async function producer(name, content) {
  const fixture = join(root, name);
  const publicRoot = join(fixture, "public");
  mkdirSync(join(publicRoot, ".mock-executor"), { recursive: true });
  mkdirSync(join(publicRoot, "deliverable"));
  writeFileSync(join(publicRoot, "deliverable", "northlake-ds-catalog.md"), content);
  const taskName = definition.stimuli[0].name;
  writeFileSync(join(publicRoot, ".mock-executor", `${taskName}.json`),
    JSON.stringify({ output: "Trusted evaluator control, not a candidate/model trial.", events: [] }));
  const spec = join(fixture, "control.eval.yaml");
  writeFileSync(spec, stringify({
    name: definition.name, description: "Model-free trusted catalog control producer", version: "1.0.0",
    type: "capability", defaults: { executor: "mock", model: "mock", runs: 1 },
    agent_environment: { files: [{ src: "./public", dest: "." }] },
    stimuli: [{
      name: taskName, prompt: "Use staged trusted control only; no model call.",
      graders: [{ type: "completed" }, { type: "file-exists", config: { path: "deliverable/northlake-ds-catalog.md" } }],
    }],
  }));
  const resultDirectory = join(fixture, "producer");
  const result = await native(["eval", "--eval-spec", spec, "--output-dir", resultDirectory,
    "--workspace", join(fixture, "preserved"), "--workers", "1"], join(safe, "producer", name));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const candidates = [];
  for (const file of files(resultDirectory).filter(file => file.endsWith(".jsonl"))) {
    const bytes = readFileSync(file);
    originalFiles.set(file, bytes);
    const destination = join(safe, "originals", name, relative(resultDirectory, file));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    for (const line of bytes.toString("utf8").split(/(?<=\n)/).filter(line => line.trim())) {
      const record = JSON.parse(line);
      if (record.status === "success" && record.trajectory) candidates.push({ file, line, record });
    }
  }
  assert.equal(candidates.length, 1, "Exactly one unmodified native trial is required per control");
  const selected = candidates[0];
  const snapshot = selected.record.workspacePath ?? selected.record.trajectory.workDir;
  assert.equal(readFileSync(join(snapshot, "deliverable", "northlake-ds-catalog.md"), "utf8"), content);
  snapshots.set(snapshot, hash(content));
  cpSync(join(snapshot, "deliverable"), join(safe, "input-snapshots", name, "deliverable"), { recursive: true });
  writeFileSync(join(safe, "producer", name, "selection.json"), JSON.stringify({
    scope: "Supervised test selection, not a native automatic binding guarantee",
    originalFile: selected.file, originalFileSha256: hash(originalFiles.get(selected.file)),
    originalRecordSha256: hash(selected.line), nativeWorkspace: snapshot,
    deliverableSha256: hash(content), specSha256: hash(readFileSync(spec)),
  }, null, 2) + "\n");
  return { ...selected, snapshot };
}

function observe(name, selectedImage) {
  const ids = docker("ps", "-a", "--filter", `ancestor=${selectedImage}`,
    "--filter", "label=com.docker.compose.service=grade", "--format", "{{.ID}}")
    .trim().split("\n").filter(Boolean);
  for (const id of ids) {
    if (inspected.has(id)) continue;
    const [container] = JSON.parse(docker("inspect", id));
    writeFileSync(join(safe, `${name}-${id}-container.json`), JSON.stringify(container, null, 2) + "\n");
    const host = container.HostConfig;
    assert.equal(container.Image, selectedImage);
    assert.equal(container.Config.User, "1000:1000");
    assert.equal(host.ReadonlyRootfs, true);
    assert.equal(host.NetworkMode, "none");
    assert.deepEqual(host.CapDrop, ["ALL"]);
    assert.equal(host.CapAdd?.length ?? 0, 0);
    assert.ok(host.SecurityOpt.includes("no-new-privileges:true"));
    assert.equal(host.SecurityOpt.some(value => value.startsWith("seccomp=")), false);
    assert.equal(host.PidsLimit, 128);
    assert.equal(host.Memory, 536870912);
    assert.equal(host.NanoCpus, 1000000000);
    assert.ok(container.Mounts.every(mount => mount.Destination !== "/var/run/docker.sock"));
    assert.ok(container.Config.Env.every(value =>
      !/^(GITHUB_TOKEN|GH_TOKEN|COPILOT_GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AZURE_OPENAI_API_KEY)=/.test(value)));
    for (const mount of container.Mounts) if (mount.Type === "volume") volumes.add(mount.Name);
    inspected.add(id);
    if (name === "missing-python") {
      assert.ok(container.Config.Env.includes("CATALOG_PYTHON=/missing-catalog-python"));
    }
    summary.containers.push({ name, id, image: selectedImage,
      readonlyRoot: true, nonRoot: true, networkNone: true, noNewPrivileges: true });
    persist();
  }
}

async function grade(name, selected, snapshot, t,
  { badDigest = false, missingPython = false, probe = false, selectedImage = image } = {}) {
  const directory = join(safe, "grades", name);
  mkdirSync(directory, { recursive: true });
  const scratch = join(root, "scratch", name);
  mkdirSync(scratch, { recursive: true });
  let spec = gradeSpec;
  if (badDigest) {
    const changed = structuredClone(definition);
    changed.stimuli[0].graders[0].config.args[3] = "0".repeat(64);
    spec = join(directory, "bad-digest.eval.yaml");
    writeFileSync(spec, stringify(changed));
  }
  if (probe) spec = join(root, "module-probe.eval.yaml");
  const args = ["grade", "--eval-spec", spec, "--output", "jsonl", "--require-pass",
    "--backend", "docker", "--backend-args", `task-image=${baseImage}`, "--backend-args", `grade-image=${selectedImage}`,
    "--backend-args", "task-network=none", "--backend-args", "grade-network=none",
    "--backend-args", `compose-file=${join(root, "hardening.yml")}`,
    "--workspace", scratch, "--assets-dir", probe ? join(root, "module-probe-assets") : assets,
    "--artifact-dir", snapshot];
  if (missingPython) args.push("--backend-args", "grade-env=CATALOG_PYTHON");
  writeFileSync(join(directory, "selected-original-trial.jsonl"), selected.line);
  let observationError;
  const poll = setInterval(() => {
    if (!observationError) try { observe(name, selectedImage); } catch (error) { observationError = error; }
  }, 100);
  let result;
  try {
    result = await native(args, directory, selected.line, t.signal,
      missingPython ? { CATALOG_PYTHON: "/missing-catalog-python" } : {});
  } finally {
    clearInterval(poll);
  }
  if (observationError) throw observationError;
  assert.equal(result.terminated, null);
  assert.ok(summary.containers.some(container => container.name === name),
    `Actual native grade container must be inspected for ${name}`);
  writeFileSync(join(directory, "workspace-files.json"),
    JSON.stringify(files(scratch).map(file => relative(scratch, file)), null, 2) + "\n");
  const outputs = result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(outputs.length, 1, result.stdout + result.stderr);
  assert.ok(outputs[0].gradeResult, result.stdout + result.stderr);
  summary.cases.push({
    name, image: selectedImage, exitCode: result.code,
    passed: outputs[0].gradeResult.passed, status: outputs[0].gradeResult.status ?? null,
  });
  persist();
  return { ...result, outcome: outputs[0].gradeResult, scratch, directory };
}

before(async () => {
  assert.equal(JSON.parse(docker("image", "inspect", image))[0].Id, image);
  assert.equal(JSON.parse(docker("image", "inspect", baseImage))[0].Id, baseImage);
  assert.equal(hash(readFileSync(join(assets, "check-submission.mjs"))),
    definition.stimuli[0].graders[0].config.args[3]);
  writeFileSync(join(root, "hardening.yml"), stringify({ services: { grade: {
    read_only: true, pids_limit: 128, mem_limit: "512m", cpus: 1,
    tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=67108864"],
  } } }));
  mkdirSync(join(root, "module-probe-assets"));
  writeFileSync(join(root, "module-probe-assets", "probe.mjs"),
    'import { parse } from "yaml"; if (parse("value: 1").value !== 1) throw new Error("YAML parser failed");\n');
  const probe = structuredClone(definition);
  probe.stimuli[0].graders[0].config.args = ["--input-type=module", "-e", [
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'await import(pathToFileURL(join(process.env.EVALUATE_ASSETS, "probe.mjs")).href);',
    'console.log(JSON.stringify({name:"module-resolution",kind:"code",passed:true,score:1,evidence:"Staged checker dependency resolved"}));',
  ].join("\n")];
  writeFileSync(join(root, "module-probe.eval.yaml"), stringify(probe));
  const content = readFileSync(join(packageRoot, "validation", "controls", "catalog", "valid-catalog.md"), "utf8");
  assert.ok(content.includes("row_estimate: 1200"));
  valid = await producer("valid", content);
  wrong = await producer("wrong", content.replace("row_estimate: 1200", "row_estimate: 1"));
});

test("unadapted image cannot resolve YAML from the native readonly reference root",
  { timeout: 300000 }, async t => {
    const result = await grade("base-module-resolution", valid, valid.snapshot, t,
      { probe: true, selectedImage: baseImage });
    assert.equal(result.code, 1);
    assert.match(JSON.stringify(result.outcome), /ERR_MODULE_NOT_FOUND/);
    verified.add("base-module-resolution");
  });

test("grade-image ancestor dependency link resolves YAML without modifying trusted assets",
  { timeout: 300000 }, async t => {
    const result = await grade("grade-module-resolution", valid, valid.snapshot, t, { probe: true });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.outcome.passed, true);
    verified.add("grade-module-resolution");
  });

test("original valid catalog is graded through the native CLI Docker path and its execution output survives",
  { timeout: 300000 }, async t => {
    const result = await grade("valid", valid, valid.snapshot, t);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.outcome.passed, true);
    assert.notEqual(result.outcome.status, "error");
    const output = join(result.scratch, "execution", "deliverable", "northlake-ds-catalog.md");
    assert.ok(existsSync(output), "Native preserved grade workspace must retain actual checker execution output");
    assert.equal(hash(readFileSync(output)), snapshots.get(valid.snapshot));
    cpSync(join(result.scratch, "execution"), join(result.directory, "native-execution-output"), { recursive: true });
    summary.nativeGradeOutputRetained = true;
    verified.add("valid");
    persist();
  });

test("schema-valid wrong inventory is a task failure, not an operational error",
  { timeout: 300000 }, async t => {
    const result = await grade("wrong", wrong, wrong.snapshot, t);
    assert.equal(result.code, 1);
    assert.equal(result.outcome.passed, false);
    assert.notEqual(result.outcome.status, "error");
    verified.add("wrong");
  });

test("wrong trusted checker digest is rejected as an operational error",
  { timeout: 300000 }, async t => {
    const result = await grade("bad-digest", valid, valid.snapshot, t, { badDigest: true });
    assert.equal(result.code, 1);
    assert.equal(result.outcome.status, "error");
    assert.match(JSON.stringify(result.outcome), /Trusted checker integrity mismatch/);
    verified.add("bad-digest");
  });

test("missing Python is an operational error through native grade",
  { timeout: 300000 }, async t => {
    const result = await grade("missing-python", valid, valid.snapshot, t, { missingPython: true });
    assert.equal(result.code, 1);
    assert.equal(result.outcome.status, "error");
    verified.add("missing-python");
  });

test("native grade accepts an explicitly supplied different snapshot, exposing the supervised binding limit",
  { timeout: 300000 }, async t => {
    const result = await grade("mismatched-snapshot", wrong, valid.snapshot, t);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.outcome.passed, true);
    summary.mismatchedSnapshotAccepted = true;
    verified.add("mismatched-snapshot");
    persist();
  });

after(() => {
  let checksPassed = false;
  try {
    for (const [file, bytes] of originalFiles) assert.deepEqual(readFileSync(file), bytes);
    for (const [snapshot, digest] of snapshots) {
      assert.equal(hash(readFileSync(join(snapshot, "deliverable", "northlake-ds-catalog.md"))), digest);
    }
    assert.deepEqual(readFileSync(gradeSpec), gradeBytes);
    summary.originalsPreserved = true;
    assert.ok(summary.containers.length > 0, "At least one actual native grade container must be inspected");
    assert.equal(summary.cases.length, 7);
    assert.equal(verified.size, 7);
    assert.equal(summary.nativeGradeOutputRetained, true);
    assert.equal(summary.mismatchedSnapshotAccepted, true);
    checksPassed = true;
  } finally {
    summary.status = "failed";
    try {
      let fallback = false;
      for (const selectedImage of [image, baseImage]) {
        const remaining = docker("ps", "-a", "--filter", `ancestor=${selectedImage}`,
          "--filter", "label=com.docker.compose.service=grade", "--format", "{{.ID}}")
          .trim().split("\n").filter(Boolean);
        for (const id of remaining) { docker("rm", "-f", id); fallback = true; }
      }
      for (const volume of volumes) {
        if (docker("volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}").trim()) {
          docker("volume", "rm", volume);
          fallback = true;
        }
      }
      summary.cleanup = fallback ? "Native cleanup required explicit fallback" : "passed";
      if (checksPassed && !fallback) summary.status = "passed";
      assert.equal(fallback, false, "Native resources required fallback cleanup");
    } finally {
      persist();
    }
  }
});
