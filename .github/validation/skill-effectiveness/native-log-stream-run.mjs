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
const root = join(process.env.RUNNER_TEMP, "native-log-stream"), safe = join(root, "safe");
mkdirSync(safe, { recursive: true });
const summary = {
  status: "running", stage: "initializing", scope: "Synthetic native service-log eligibility only; not startup-inventory adoption",
  sdkSessions: 0, modelCalls: 0, native: null, facts: null, logs: null, cleanup: "pending",
};
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
persist();
const clean = { PATH: process.env.PATH, HOME: join(root, "home"), DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
mkdirSync(clean.HOME);
const { stringify } = createRequire(join(skill, "package.json"))("yaml");
const tag = "native-log-stream:" + process.env.GITHUB_SHA;
let image, initialVolumes;
function run(program, args, options = {}) {
  const child = spawnSync(program, args, { cwd: root, env: clean, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (child.error || child.status !== 0) {
    writeFileSync(join(root, "last-command.log"), String(child.stdout) + String(child.stderr));
    throw Object.assign(new Error("Command failed"), { code: child.error?.code ?? "COMMAND_EXIT", exitCode: child.status });
  }
  return child.stdout;
}
const docker = (...args) => run("docker", args);
const lines = value => value.trim().split(/\r?\n/).filter(Boolean);
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function boundedRead(file, maxBytes) {
  assert.ok(statSync(file).size <= maxBytes, "Evidence exceeds its byte bound");
  return readFileSync(file, "utf8");
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
  writeFileSync(join(context, "Dockerfile"), readFileSync(join(own, "native-log-stream.Dockerfile")));
  run("docker", ["build", "--platform", "linux/amd64", "--pull", "--iidfile", join(root, "image-id"), "-t", tag, context], { timeout: 420000 });
  image = readFileSync(join(root, "image-id"), "utf8").trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  summary.image = image;
  const fixture = join(root, "fixture"), publicRoot = join(fixture, "public"), plugin = join(root, "probe-executor");
  mkdirSync(publicRoot, { recursive: true });
  writeFileSync(join(publicRoot, "input.txt"), "Synthetic native log eligibility fixture.\n");
  cpSync(join(own, "native-log-stream-executor"), plugin, { recursive: true });
  const spec = {
    name: "native-log-stream-eligibility", description: "Synthetic descriptor probe; no SDK session or model", version: "1.0.0", type: "capability",
    defaults: { executor: { name: "native-log-stream-probe", config: {} }, model: "gpt-4.1", runs: 1, timeout: "60s" },
    agent_environment: { files: [{ src: "./public", dest: "." }], env: { DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" } },
    stimuli: [{ name: "descriptor", prompt: "Synthetic descriptor eligibility only; no model invocation.", graders: [{ type: "completed" }] }],
  };
  const evalFile = join(fixture, "probe.eval.yaml");
  writeFileSync(evalFile, stringify(spec));
  const hardening = { image: tag, read_only: true, pids_limit: 128, mem_limit: "512m", cpus: 1, tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=67108864"] };
  const overlay = join(root, "hardened.compose.yaml");
  writeFileSync(overlay, stringify({ services: { task: { ...hardening, profiles: ["vally-task"] }, grade: { ...hardening, profiles: ["vally-grade"] } } }));
  const out = join(root, "out");
  summary.stage = "native-eligibility-probe"; persist();
  const exitCode = await native(["eval", "--eval-spec", evalFile, "--executor-plugin", plugin, "--output-dir", out,
    "--workspace", join(root, "preserved"), "--backend", "docker",
    "--backend-args", "task-image=" + tag, "--backend-args", "grade-image=" + tag,
    "--backend-args", "task-network=none", "--backend-args", "grade-network=none", "--backend-args", "compose-file=" + overlay]);
  assert.equal(exitCode, 1, "The synthetic executor must retain its intentional native error");
  const reportFiles = files(out);
  const records = reportFiles.filter(file => file.endsWith(".jsonl"))
    .flatMap(file => boundedRead(file, 1024 * 1024).split(/\r?\n/).filter(Boolean))
    .map(line => ({ line, record: JSON.parse(line) })).filter(({ record }) => record.status && "trajectory" in record);
  assert.equal(records.length, 1);
  const { line, record } = records[0];
  assert.equal(record.status, "error");
  assert.equal(record.error, "NATIVE_LOG_STREAM_PROBE_STOP");
  assert.equal(record.trajectory, null);
  assert.equal(record.gradeResult, null);
  summary.native = { status: record.status, intentionalStop: true, trajectory: null, gradeResult: null,
    sha256: createHash("sha256").update(line).digest("hex") };
  const facts = JSON.parse(boundedRead(join(record.workspacePath, "native-log-stream-facts.json"), 8192));
  assert.deepEqual(Object.keys(facts).sort(), ["schema", "synthetic", "sdkSessions", "modelCalls", "hardening", "descriptor", "eligibility", "emission"].sort());
  assert.equal(facts.schema, "native-log-stream-probe.v1");
  assert.equal(facts.synthetic, true);
  assert.equal(facts.sdkSessions, 0);
  assert.equal(facts.modelCalls, 0);
  assert.ok(["rejected", "eligible-for-retention-check"].includes(facts.eligibility.status));
  assert.deepEqual(facts.hardening, {
    uid: 1000, gid: 1000, readonlyRoot: true, noNewPrivileges: true,
    capabilitiesDropped: true, networkNone: true, memoryBytes: "536870912",
    pids: "128", cpu: "100000 100000",
  });
  summary.facts = facts;
  const consoleLogs = reportFiles.filter(file => file.endsWith("task-compose.log"));
  assert.equal(consoleLogs.length, 1, "Native CLI must retain the actual supplementary task log");
  const consoleText = boundedRead(consoleLogs[0], 1024 * 1024);
  summary.logs = {
    supplementaryRetained: true, bytes: Buffer.byteLength(consoleText),
    sha256: createHash("sha256").update(consoleText).digest("hex"),
    ordinaryExecControlPresent: consoleText.includes("NATIVE_EXEC_STDERR_CONTROL"),
    syntheticFrameRetained: facts.emission.sent ? consoleText.includes(facts.emission.token) : null,
  };
  assert.equal(summary.logs.ordinaryExecControlPresent, false);
  if (facts.emission.sent) assert.equal(summary.logs.syntheticFrameRetained, true);
  summary.status = "completed";
  summary.stage = "complete";
} catch (error) {
  summary.status = "failed";
  summary.failure = { stage: summary.stage, name: error.name, code: error.code ?? null, exitCode: error.exitCode ?? null };
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
    summary.cleanup = "failed";
    summary.cleanupError = error.name;
    summary.status = "failed";
    process.exitCode = 1;
  }
  persist();
}
