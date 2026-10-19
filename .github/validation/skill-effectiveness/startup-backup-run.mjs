// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const skill = process.cwd(), own = dirname(fileURLToPath(import.meta.url));
const root = join(process.env.RUNNER_TEMP, "native-startup-backup"), safe = join(root, "safe");
mkdirSync(safe, { recursive: true });
const summary = {
  status: "running", stage: "initializing",
  scope: "Actual native SDK startup, supervised backup/verification and workspace retention; deliberate task errors, no model delivery or grading acceptance",
  cases: [], cleanup: "pending",
};
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
persist();
const clean = { PATH: process.env.PATH, HOME: join(root, "home"), DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
mkdirSync(clean.HOME);
const { stringify } = createRequire(join(skill, "package.json"))("yaml");
const tag = "native-startup-backup:" + process.env.GITHUB_SHA;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let image, initialVolumes;
function run(program, args, options = {}) {
  const child = spawnSync(program, args, { cwd: root, env: clean, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (child.error || child.status !== 0) {
    writeFileSync(join(root, "last-command.log"), String(child.stdout) + String(child.stderr));
    throw Object.assign(new Error(`Command failed: ${program} ${args[0]}`), { code: child.error?.code ?? "COMMAND_EXIT", exitCode: child.status });
  }
  return child.stdout;
}
const docker = (...args) => run("docker", args);
const lines = value => value.trim().split(/\r?\n/).filter(Boolean);
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function read(file, maxBytes = 1024 * 1024) {
  assert.ok(statSync(file).isFile() && statSync(file).size <= maxBytes, "Evidence must be a bounded regular file");
  return readFileSync(file);
}
async function native(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(skill, "node_modules", "@microsoft", "vally-cli", "dist", "index.js"), ...args],
      { cwd: root, env: clean, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", exceeded = false;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
      output += data;
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) { exceeded = true; child.kill("SIGTERM"); }
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(join(root, "native-last.log"), output);
      if (signal || exceeded) reject(new Error("Native process exceeded limits"));
      else resolve(code);
    });
  });
}
try {
  initialVolumes = new Set(lines(docker("volume", "ls", "--format", "{{.Name}}")));
  summary.stage = "building-frozen-appliance"; persist();
  const context = join(root, "context");
  mkdirSync(context);
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(context, name), readFileSync(join(skill, name)));
  for (const name of ["restricted-copilot-executor.mjs", "native-inventory.mjs"]) {
    writeFileSync(join(context, name), readFileSync(join(skill, "scripts", name)));
  }
  writeFileSync(join(context, "startup-backup-hook.mjs"), readFileSync(join(own, "startup-backup-hook.mjs")));
  writeFileSync(join(context, "Dockerfile"), readFileSync(join(own, "startup-backup.Dockerfile")));
  run("docker", ["build", "--platform", "linux/amd64", "--pull", "--iidfile", join(root, "image-id"), "-t", tag, context], { timeout: 420000 });
  image = readFileSync(join(root, "image-id"), "utf8").trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  summary.image = image;
  const fixture = join(root, "fixture"), publicRoot = join(fixture, "public"), plugin = join(root, "startup-backup-executor");
  mkdirSync(publicRoot, { recursive: true });
  writeFileSync(join(publicRoot, "input.txt"), "Synthetic startup backup fixture.\n");
  cpSync(join(own, "startup-backup-executor"), plugin, { recursive: true });
  const spec = {
    name: "native-startup-backup", description: "Actual production executor; intentional no-prompt stop", version: "1.0.0", type: "capability",
    defaults: { executor: { name: "restricted-copilot-sdk", config: { sessionPolicy: {
      availableTools: [], permissions: { allow: [], deny: ["Shell(*)"] },
    } } }, model: "gpt-4.1", runs: 1, timeout: "120s" },
    agent_environment: { files: [{ src: "./public", dest: "." }], env: { DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" }, skills: [] },
    stimuli: [{ name: "candidate", prompt: "This synthetic prompt must never be delivered.", artifacts: { include: ["deliverable/**"] }, graders: [{ type: "completed" }] }],
  };
  const canary = join(fixture, "canary-skill");
  mkdirSync(canary);
  writeFileSync(join(canary, "SKILL.md"), "---\nname: canary-skill\ndescription: Synthetic startup control\n---\nSynthetic fixture only.\n");
  const hardening = {
    image: tag, read_only: true, pids_limit: 128, mem_limit: "512m", cpus: 1,
    tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=67108864"],
  };
  const overlay = join(root, "hardened.compose.yaml");
  writeFileSync(overlay, stringify({ services: { task: { ...hardening, profiles: ["vally-task"] }, grade: { ...hardening, profiles: ["vally-grade"] } } }));
  const backend = ["--backend", "docker", "--backend-args", "task-image=" + tag, "--backend-args", "grade-image=" + tag,
    "--backend-args", "task-network=none", "--backend-args", "grade-network=none", "--backend-args", "compose-file=" + overlay];
  for (const arm of ["baseline", "treatment"]) {
    summary.stage = "native-startup-and-retention-" + arm; persist();
    spec.agent_environment.skills = arm === "treatment" ? ["./canary-skill"] : [];
    const evalFile = join(fixture, arm + ".eval.yaml"), out = join(root, "out", arm);
    writeFileSync(evalFile, stringify(spec));
    const exitCode = await native(["eval", "--eval-spec", evalFile, "--executor-plugin", plugin, "--output-dir", out,
      "--workspace", join(root, "preserved", arm), ...backend]);
    assert.equal(exitCode, 1, "The native no-prompt error must remain an error");
    const records = files(out).filter(file => file.endsWith(".jsonl"))
      .flatMap(file => lines(read(file).toString("utf8"))).map(line => ({ line, record: JSON.parse(line) }))
      .filter(({ record }) => record.status && "trajectory" in record);
    assert.equal(records.length, 1);
    const { record, line } = records[0];
    assert.equal(record.status, "error");
    assert.equal(record.error, "NATIVE_STARTUP_BACKUP_PRE_SEND_STOP");
    assert.equal(record.trajectory, null);
    assert.equal(record.gradeResult, null);
    const factsFile = join(record.workspacePath, "startup-fence.json");
    const facts = JSON.parse(read(factsFile, 16384));
    assert.equal(facts.schema, "native-startup-backup-check.v1");
    assert.equal(facts.synthetic, true);
    assert.equal(facts.sessions, 1);
    assert.equal(facts.sendAttempts, 1);
    for (const key of ["deliveredPrompts", "modelEvents", "catalogCalls"]) assert.equal(facts[key], 0);
    assert.deepEqual(facts.availableTools, []);
    assert.match(facts.auditDirectory, /^\.skill-effectiveness-evidence-[A-Za-z0-9]+$/);
    assert.ok(typeof facts.sessionId === "string" && facts.sessionId.length > 0);
    const audit = join(record.workspacePath, facts.auditDirectory), name = encodeURIComponent(facts.sessionId) + ".json";
    const originalFile = join(audit, name), backupFile = join(audit, "startup-backups", name);
    const reportFile = join(audit, encodeURIComponent(facts.sessionId) + ".verification.json");
    const original = read(originalFile), backup = read(backupFile), inventory = JSON.parse(original), report = JSON.parse(read(reportFile));
    assert.deepEqual(backup, original);
    const originalStat = statSync(originalFile, { bigint: true }), backupStat = statSync(backupFile, { bigint: true });
    assert.ok(originalStat.dev !== backupStat.dev || originalStat.ino !== backupStat.ino);
    assert.equal(hash(original), facts.inventorySha256);
    assert.equal(inventory.sessionId, facts.sessionId);
    assert.equal(inventory.phase, "before-first-prompt");
    assert.equal(inventory.workingDirectory, "/workspace");
    const enabled = inventory.skillDetails.skills.filter(value => value.enabled).map(value => value.name).sort();
    assert.deepEqual(enabled, arm === "treatment" ? ["canary-skill"] : []);
    assert.equal(report.sessionId, facts.sessionId);
    assert.equal(report.phase, "after-native-execution");
    assert.equal(report.status, "verified");
    for (const key of ["expectedSha256", "originalSha256", "backupSha256"]) assert.equal(report[key], facts.inventorySha256);
    assert.equal(files(audit).length, 3, "Only original, independent backup and completion report");
    const armEvidence = join(safe, arm);
    mkdirSync(armEvidence);
    for (const [source, destination] of [
      [originalFile, "startup.json"], [backupFile, "startup-backup.json"],
      [reportFile, "completion-verification.json"], [factsFile, "startup-fence.json"],
    ]) writeFileSync(join(armEvidence, destination), read(source), { flag: "wx" });
    writeFileSync(join(armEvidence, "native-record.json"), line + "\n", { flag: "wx" });
    summary.cases.push({
      arm, sessionId: facts.sessionId, sdkSessions: 1, blockedSendAttempts: 1, deliveredPrompts: 0, modelEvents: 0,
      enabledSkills: enabled, inventorySha256: facts.inventorySha256, independentlyStoredBytes: true,
      completionVerification: "verified", nativeWorkspaceRetained: true,
      nativeRecordSha256: hash(line), nativeStatus: record.status, trajectory: null, gradeResult: null,
      hardening: facts.hardening, declaredArtifactInclude: ["deliverable/**"],
    });
    persist();
  }
  assert.equal(summary.cases.length, 2);
  assert.notEqual(summary.cases[0].sessionId, summary.cases[1].sessionId);
  summary.status = "passed"; summary.stage = "complete";
} catch (error) {
  summary.status = "failed";
  summary.failure = {
    stage: summary.stage, name: error.name, code: error.code ?? null, exitCode: error.exitCode ?? null,
    detail: error.message.slice(0, 2048).replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]"),
  };
  process.exitCode = 1;
} finally {
  try {
    if (image) {
      const remaining = lines(docker("ps", "-a", "--filter", "ancestor=" + image, "--format", "{{.ID}}"));
      if (remaining.length) {
        for (const id of remaining) docker("rm", "-f", id);
        throw new Error("Native container cleanup incomplete");
      }
      const addedVolumes = lines(docker("volume", "ls", "--format", "{{.Name}}")).filter(name => !initialVolumes.has(name));
      assert.equal(addedVolumes.length, 0, "Native trial left volumes behind");
      docker("image", "rm", tag);
    }
    summary.cleanup = "passed";
  } catch (error) {
    summary.cleanup = "failed"; summary.cleanupError = error.name; summary.status = "failed"; process.exitCode = 1;
  }
  persist();
}
