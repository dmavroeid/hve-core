// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const skill = process.cwd();
const own = dirname(fileURLToPath(import.meta.url));
const root = join(process.env.RUNNER_TEMP, "containment-d63");
mkdirSync(root, { recursive: true });
const safe = join(root, "safe");
mkdirSync(safe, { recursive: true });
const summary = { status: "running", stage: "initializing", scope: "Actual native Docker offline grading; no SDK/model session", cases: [], containers: [], cleanup: "pending" };
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2));
persist();
const clean = { PATH: process.env.PATH, HOME: join(root, "home"), DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
mkdirSync(clean.HOME, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const { parse, stringify } = createRequire(join(skill, "package.json"))("yaml");
const imageTag = "containment-d63:" + process.env.GITHUB_SHA;
let image, server, poll;
const projects = new Set(), volumes = new Set(), inspected = new Set();
const run = (program, args, options = {}) => {
  const child = spawnSync(program, args, { cwd: root, env: clean, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (child.error || child.status !== 0) {
    writeFileSync(join(root, "last-command.log"), String(child.stdout) + String(child.stderr));
    throw Object.assign(new Error("Command failed"), { code: child.error?.code ?? "COMMAND_EXIT", exitCode: child.status });
  }
  return child.stdout;
};
const docker = (...args) => run("docker", args);
const cli = join(skill, "node_modules", "@microsoft", "vally-cli", "dist", "index.js");
const native = (args, options) => run(process.execPath, [cli, ...args], options);
const asyncNative = (args, input, cwd) => new Promise((resolveChild, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...clean, CONTAINMENT_HOST_CANARY: "SYNTHETIC-NOT-A-CREDENTIAL" }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", oversized = false;
  const collect = (key, data) => {
    if (key === "stdout") stdout += data; else stderr += data;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 4 * 1024 * 1024) { oversized = true; child.kill("SIGTERM"); }
  };
  child.stdout.on("data", data => collect("stdout", data));
  child.stderr.on("data", data => collect("stderr", data));
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  child.once("error", reject);
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    writeFileSync(join(root, "native-last.log"), stdout + stderr);
    if (oversized || signal) reject(new Error("Native process exceeded limits"));
    else resolveChild({ code, stdout });
  });
  child.stdin.end(input);
});
const observe = () => {
  const ids = docker("ps", "-a", "--filter", "ancestor=" + image, "--filter", "label=com.docker.compose.project", "--format", "{{.ID}}").trim().split("\n").filter(Boolean);
  for (const id of ids) {
    if (inspected.has(id)) continue;
    const [c] = JSON.parse(docker("inspect", id));
    assert.equal(c.Image, image);
    const project = c.Config.Labels?.["com.docker.compose.project"];
    const role = c.Config.Labels?.["com.docker.compose.service"];
    assert.ok(project?.startsWith("vally-"));
    projects.add(project);
    for (const mount of c.Mounts) if (mount.Type === "volume") volumes.add(mount.Name);
    if (role === "grade") {
      assert.equal(c.Config.User, "1000:1000");
      assert.equal(c.HostConfig.ReadonlyRootfs, true);
      assert.equal(c.HostConfig.NetworkMode, "none");
      assert.deepEqual(c.HostConfig.CapDrop, ["ALL"]);
      assert.ok(c.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
      assert.equal(c.HostConfig.PidsLimit, 128);
      assert.equal(c.HostConfig.Memory, 536870912);
      assert.equal(c.HostConfig.NanoCpus, 1000000000);
      assert.ok(c.Mounts.every(m => m.Destination !== "/var/run/docker.sock"));
      summary.containers.push({ role, nonRoot: true, readonlyRoot: true, networkNone: true, capabilitiesDropped: true, noNewPrivileges: true, pids: 128, memoryBytes: 536870912, cpus: 1 });
      persist();
    }
    inspected.add(id);
  }
};
try {
  summary.stage = "checking-selected-frozen-appliance"; persist();
  image = process.env.TASK_RUNTIME_IMAGE;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.parse(docker("image", "inspect", image))[0].Id, image);
  summary.image = image;
  summary.stage = "native-producer"; persist();
  const fixture = join(root, "fixture");
  mkdirSync(fixture);
  mkdirSync(join(fixture, "public", ".mock-executor"), { recursive: true });
  mkdirSync(join(fixture, "public", "deliverable"));
  writeFileSync(join(fixture, "public", ".mock-executor", "containment.json"), JSON.stringify({ output: "Synthetic completed output", events: [] }));
  writeFileSync(join(fixture, "public", "deliverable", "result.txt"), '{"answer":42}');
  const spec = { name: "containment", description: "Synthetic native containment output", version: "1.0.0", type: "capability", defaults: { executor: "mock", model: "mock", runs: 1 },
    agent_environment: { files: [{ src: "./public", dest: "." }] },
    stimuli: [{ name: "containment", prompt: "Synthetic fixture only; no model call.", graders: [{ type: "completed" }, { type: "file-exists", config: { path: "deliverable/result.txt" } }] }] };
  writeFileSync(join(fixture, "candidate.eval.yaml"), stringify(spec));
  native(["eval", "--eval-spec", join(fixture, "candidate.eval.yaml"), "--output-dir", join(root, "producer"), "--workspace", join(root, "preserved"), "--workers", "1"]);
  const find = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? find(join(dir, e.name)) : [join(dir, e.name)]);
  const originals = find(join(root, "producer")).filter(f => f.endsWith(".jsonl")).map(file => ({ file, bytes: readFileSync(file) }));
  const records = originals.flatMap(o => o.bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  const record = records.find(r => r.status === "success" && r.trajectory);
  assert.ok(record, "Completed native record required");
  const snapshot = record.workspacePath ?? record.trajectory.workDir;
  assert.equal(readFileSync(join(snapshot, "deliverable", "result.txt"), "utf8"), '{"answer":42}');
  const hostFile = join(root, "host-only.txt"), inventoryFile = join(root, "host-inventory.json");
  writeFileSync(hostFile, "SYNTHETIC-HOST-CANARY");
  writeFileSync(inventoryFile, '{"synthetic":"host-only"}');
  let connections = 0;
  let serverError;
  server = net.createServer(socket => {
    connections++;
    socket.on("error", error => { serverError = error.code; });
    socket.end();
  });
  await new Promise(resolveServer => server.listen(0, "0.0.0.0", resolveServer));
  const port = server.address().port;
  await new Promise((ok, fail) => { const client = net.connect(port, "127.0.0.1"); client.on("end", ok); client.on("error", fail); client.resume(); });
  const before = connections;
  const bridge = JSON.parse(docker("network", "inspect", "bridge"))[0].IPAM.Config[0].Gateway;
  const assets = join(root, "trusted");
  mkdirSync(assets);
  const checkerBytes = readFileSync(join(own, "containment-canary.mjs"));
  writeFileSync(join(assets, "check.mjs"), checkerBytes);
  writeFileSync(join(assets, "canaries.json"), JSON.stringify({ hostFile, inventoryFile, hostAddress: bridge, port }));
  const template = readFileSync(join(skill, "assets", "native-grade-eval.template.yaml"), "utf8");
  const rendered = template.replaceAll("<task-name>", "containment").replaceAll("<checker-entry>", "check.mjs").replaceAll("<artifact>", "result.txt").replaceAll("<checker-sha256>", hash(checkerBytes));
  const grade = parse(rendered);
  assert.equal(grade.stimuli[0].graders[0].type, "program");
  const overrides = join(root, "hardening.yml");
  const hardening = { read_only: true, pids_limit: 128, mem_limit: "512m", cpus: 1, tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=67108864"] };
  writeFileSync(overrides, stringify({ services: { grade: hardening } }));
  summary.stage = "actual-native-contained-grading"; persist();
  let observationError;
  poll = setInterval(() => { if (!observationError) try { observe(); } catch (error) { observationError = error; } }, 150);
  for (const name of ["positive", "wrong-digest", "modified-checker"]) {
    const dir = join(root, name);
    mkdirSync(dir); mkdirSync(join(dir, "scratch"));
    const current = structuredClone(grade);
    if (name === "wrong-digest") current.stimuli[0].graders[0].config.args[3] = "0".repeat(64);
    if (name === "modified-checker") writeFileSync(join(assets, "check.mjs"), Buffer.concat([checkerBytes, Buffer.from("\n// synthetic mutation\n")]));
    writeFileSync(join(dir, "grade.eval.yaml"), stringify(current));
    const result = await asyncNative(["grade", "--eval-spec", join(dir, "grade.eval.yaml"), "--output", "jsonl", "--require-pass",
      "--backend", "docker", "--backend-args", "task-image=" + image, "--backend-args", "grade-image=" + image,
      "--backend-args", "task-network=none", "--backend-args", "grade-network=none", "--backend-args", "compose-file=" + overrides,
      "--workspace", join(dir, "scratch"), "--assets-dir", assets, "--artifact-dir", snapshot], JSON.stringify(record) + "\n", dir);
    if (observationError) throw observationError;
    assert.equal(result.code, name === "positive" ? 0 : 1);
    const outcomes = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].gradeResult.passed, name === "positive");
    if (name === "positive") {
      assert.equal(outcomes[0].gradeResult.details[0].evidence, "Authenticated task checker completed");
      summary.cases.push({ name, passed: true, authenticatedCanaryAssertions: 18, verdict: "native-program-authenticated-completion" });
    } else {
      assert.equal(outcomes[0].gradeResult.status, "error");
      assert.match(outcomes[0].gradeResult.details[0].evidence, /Trusted checker integrity mismatch/);
      summary.cases.push({ name, rejectedBeforeCanary: true, passed: true });
    }
    persist();
  }
  assert.equal(connections, before);
  assert.equal(serverError, undefined);
  assert.ok(summary.containers.length >= 1, "Actual positive grade container must be observed");
  for (const original of originals) assert.deepEqual(readFileSync(original.file), original.bytes);
  assert.equal(readFileSync(hostFile, "utf8"), "SYNTHETIC-HOST-CANARY");
  summary.originalsPreserved = true;
  summary.hostCanariesPreserved = true;
  summary.status = "passed";
  summary.stage = "complete";
} catch (error) {
  summary.status = "failed";
  summary.failure = { stage: summary.stage, name: error.name, code: error.code ?? null, exitCode: error.exitCode ?? null };
  const diagnostic = ["native-last.log", "last-command.log"].filter(name => existsSync(join(root, name)))
    .map(name => readFileSync(join(root, name), "utf8").slice(-2048)).join("\n");
  summary.failure.detail = (error.message + "\n" + diagnostic).slice(-3072)
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]")
    .replace(/(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]");
  console.error("Containment failed at " + summary.stage + ": " + error.name + " " + (error.code ?? ""));
  process.exitCode = 1;
} finally {
  if (poll) clearInterval(poll);
  if (server) await new Promise(resolveServer => server.close(resolveServer));
  try {
    if (image) {
      const ids = docker("ps", "-a", "--filter", "ancestor=" + image, "--format", "{{.ID}}").trim().split("\n").filter(Boolean);
      if (ids.length) { for (const id of ids) docker("rm", "-f", id); throw new Error("Native container cleanup incomplete"); }
      for (const volume of volumes) {
        const result = spawnSync("docker", ["volume", "inspect", volume], { env: clean, encoding: "utf8", timeout: 10000 });
        if (result.status === 0) { docker("volume", "rm", volume); throw new Error("Native volume cleanup incomplete"); }
        assert.match(result.stderr, /no such volume/i);
      }
    }
    summary.cleanup = "passed";
  } catch (error) {
    summary.cleanup = "failed";
    summary.status = "failed";
    summary.cleanupError = error.name;
    process.exitCode = 1;
  }
  persist();
}
