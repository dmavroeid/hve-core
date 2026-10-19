// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createHash } from "node:crypto";
import { captureNativeInventory } from "./native-inventory-capture.mjs";

const skill = process.cwd(), own = dirname(fileURLToPath(import.meta.url));
const root = join(process.env.RUNNER_TEMP, "native-inventory-d72"), safe = join(root, "safe");
mkdirSync(safe, { recursive: true });
const summary = { status: "running", stage: "initializing", scope: "Test-only protected SDK inventory bridge in actual native task lifecycles; no model prompts", cases: [], captures: [], containers: [], cleanup: "pending" };
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2));
persist();
const clean = { PATH: process.env.PATH, HOME: join(root, "home"), DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
mkdirSync(clean.HOME);
const { stringify } = createRequire(join(skill, "package.json"))("yaml");
const imageTag = "native-inventory-d72:" + process.env.GITHUB_SHA;
let image, server, poll, observerError, activeArm;
const pending = new Map(), attached = new Set(), captureTasks = [];
const volumes = new Set(), inspected = new Set();
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
const native = args => new Promise((ok, fail) => {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root, env: { ...clean, CONTAINMENT_HOST_CANARY: "SYNTHETIC-NOT-A-CREDENTIAL", SKILL_EVAL_INVENTORY_DIR: join(root, "host-private") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", exceeded = false;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
    output += data;
    if (Buffer.byteLength(output) > 4 * 1024 * 1024) { exceeded = true; child.kill("SIGTERM"); }
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 480000);
  child.once("error", error => { clearTimeout(timer); fail(error); });
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    writeFileSync(join(root, "native-last.log"), output);
    if (signal || exceeded) fail(new Error("Native process exceeded limits"));
    else ok(code);
  });
});
const observe = () => {
  for (const id of docker("ps", "-a", "--filter", "ancestor=" + image, "--filter", "label=com.docker.compose.project", "--format", "{{.ID}}").trim().split("\n").filter(Boolean)) {
    if (inspected.has(id)) continue;
    const [container] = JSON.parse(docker("inspect", id));
    assert.equal(container.Image, image);
    assert.match(container.Config.Labels["com.docker.compose.project"], /^vally-[a-f0-9]{8}$/);
    for (const mount of container.Mounts) if (mount.Type === "volume") volumes.add(mount.Name);
    const role = container.Config.Labels["com.docker.compose.service"];
    if (role === "task") {
      assert.equal(container.Config.User, "1000:1000");
      assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.HostConfig.NetworkMode, "none");
      assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]);
      assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
      assert.equal(container.HostConfig.PidsLimit, 128);
      assert.equal(container.HostConfig.Memory, 536870912);
      assert.equal(container.HostConfig.NanoCpus, 1000000000);
      assert.ok(container.Mounts.every(mount => mount.Destination !== "/var/run/docker.sock" && !mount.Source.includes("host-private")));
      summary.containers.push({ role, nonRoot: true, readonlyRoot: true, networkNone: true, capabilitiesDropped: true, noNewPrivileges: true, pids: 128, memoryBytes: 536870912, cpus: 1 });
      pending.set(container.Id, { container, arm: activeArm });
      persist();
    }
    inspected.add(id);
  }
  for (const [id, { container, arm }] of pending) {
    if (attached.has(id)) continue;
    const ready = spawnSync("docker", ["exec", "--user", "1000:1000", id, "test", "-f", "/tmp/native-capture-ready"],
      { env: clean, encoding: "utf8", timeout: 5000 });
    if (ready.error) throw ready.error;
    if (ready.status !== 0) {
      if (/No such container|not running|OCI runtime exec failed/i.test(ready.stderr)) throw new Error("Native task exited before trusted capture readiness");
      assert.equal(ready.status, 1, "Unexpected native barrier readiness failure");
      continue;
    }
    assert.ok(["baseline", "treatment"].includes(arm));
    assert.equal(summary.captures.some(c => c.arm === arm), false, "One actual native task per parent-selected arm");
    attached.add(id);
    captureTasks.push(captureNativeInventory({ container, arm, image, safe, env: clean, docker,
      publish(record) { if (record) summary.captures.push(record); persist(); },
    }).then(record => { if (record.status !== "passed") observerError = new Error("Native protected capture failed"); }));
  }
};
try {
  summary.stage = "building-frozen-appliance"; persist();
  const context = join(root, "context");
  mkdirSync(context);
  for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(context, name), readFileSync(join(skill, name)));
  writeFileSync(join(context, "Dockerfile"), readFileSync(join(own, "inventory-prototype.Dockerfile")));
  writeFileSync(join(context, "restricted-copilot-executor.mjs"), readFileSync(join(skill, "scripts", "restricted-copilot-executor.mjs")));
  writeFileSync(join(context, "inventory-child.mjs"), readFileSync(join(own, "inventory-child.mjs")));
  writeFileSync(join(context, "SKILL.md"), "---\nname: inventory-prototype-focus\ndescription: Synthetic inventory fixture only\n---\nNo model prompt permitted.\n");
  run("docker", ["build", "--platform", "linux/amd64", "--pull", "--iidfile", join(root, "image-id"), "-t", imageTag, context], { timeout: 600000 });
  image = readFileSync(join(root, "image-id"), "utf8").trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  summary.image = image;
  const privateRoot = join(root, "host-private"), fixture = join(root, "fixture"), publicRoot = join(fixture, "public");
  mkdirSync(privateRoot);
  mkdirSync(join(publicRoot, ".mock-executor"), { recursive: true });
  const hostFile = join(privateRoot, "host-only.txt"), inventoryFile = join(privateRoot, "inventory.json"), privateChecker = join(privateRoot, "private-checker.mjs");
  const originals = new Map([[hostFile, "SYNTHETIC-HOST-ONLY"], [inventoryFile, '{"synthetic":"host-only"}'], [privateChecker, "// SYNTHETIC-PRIVATE-CHECKER"]]);
  for (const [path, bytes] of originals) writeFileSync(path, bytes);
  let connections = 0, serverError;
  server = net.createServer(socket => { connections++; socket.on("error", error => { serverError = error.code; }); socket.end(); });
  await new Promise((ok, fail) => { server.once("error", fail); server.listen(0, "0.0.0.0", ok); });
  const port = server.address().port;
  await new Promise((ok, fail) => { const client = net.connect(port, "127.0.0.1"); client.on("error", fail); client.on("end", ok); client.resume(); });
  const before = connections;
  const gateway = JSON.parse(docker("network", "inspect", "bridge"))[0].IPAM.Config[0].Gateway;
  writeFileSync(join(publicRoot, "public-controls.json"), JSON.stringify({ hostFile, inventoryFile, privateChecker, port, gateway }));
  writeFileSync(join(publicRoot, "public-input.txt"), "SYNTHETIC-PUBLIC-INPUT");
  writeFileSync(join(publicRoot, ".mock-executor", "candidate.json"), JSON.stringify({ output: "Synthetic completed candidate canaries", events: [{ type: "turn_end", data: {} }] }));
  const plugin = join(root, "candidate-executor");
  cpSync(join(own, "native-inventory-executor"), plugin, { recursive: true });
  const spec = { name: "candidate", description: "Synthetic task-role containment only", version: "1.0.0", type: "capability",
    defaults: { executor: "containment-canary", model: "mock", runs: 1 },
    agent_environment: { files: [{ src: "./public", dest: "." }] },
    stimuli: [{ name: "candidate", prompt: "Synthetic executor only; no model call.", graders: [{ type: "completed" }, { type: "file-exists", config: { path: "candidate-facts.json" } }] }] };
  const skillDir = join(fixture, "canary-skill");
  mkdirSync(skillDir);
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: canary-skill\ndescription: Synthetic containment control\n---\nSynthetic fixture only.\n");
  const hardening = { image: imageTag, read_only: true, pids_limit: 128, mem_limit: "512m", cpus: 1, tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=67108864"] };
  const overlay = join(root, "hardened.compose.yaml");
  writeFileSync(overlay, stringify({ services: { task: { ...hardening, profiles: ["vally-task"] }, grade: { ...hardening, profiles: ["vally-grade"] } } }));
  const backend = ["--backend", "docker", "--backend-args", "task-image=" + imageTag, "--backend-args", "grade-image=" + imageTag,
    "--backend-args", "task-network=none", "--backend-args", "grade-network=none", "--backend-args", "compose-file=" + overlay];
  summary.stage = "actual-native-task-execution"; persist();
  poll = setInterval(() => { if (!observerError) { try { observe(); } catch (error) { observerError = error; } } }, 150);
  const find = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? find(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const arm of ["baseline", "treatment"]) {
    activeArm = arm;
    spec.environment = { skills: arm === "treatment" ? ["./canary-skill"] : [] };
    const evalFile = join(fixture, arm + ".eval.yaml");
    writeFileSync(evalFile, stringify(spec));
    const code = await native(["eval", evalFile, "--executor-plugin", plugin, "--output-dir", join(root, "out", arm),
      "--workspace", join(root, "preserved", arm), ...backend]);
    await Promise.all(captureTasks);
    if (observerError) throw observerError;
    assert.equal(code, 0, "Native arm lifecycle must succeed");
    const records = find(join(root, "out", arm)).filter(file => file.endsWith(".jsonl"))
      .flatMap(file => readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean))
      .map(line => ({ line, record: JSON.parse(line) })).filter(({ record }) => record.status && "trajectory" in record);
    assert.equal(records.length, 1, "Exactly one actual native original per arm");
    const { record, line } = records[0];
    assert.equal(record.status, "success");
    assert.ok(record.trajectory);
    const workspace = record.workspacePath ?? record.trajectory.workDir;
    const facts = JSON.parse(readFileSync(join(workspace, "candidate-facts.json"), "utf8"));
    const binding = JSON.parse(readFileSync(join(workspace, "native-capture-binding.json"), "utf8"));
    const capture = summary.captures.find(c => c.arm === arm);
    assert.ok(capture);
    assert.equal(binding.arm, arm);
    assert.equal(binding.containerId, capture.containerId);
    assert.equal(binding.sessionId, capture.sessionId);
    assert.equal(binding.sha256, capture.sha256);
    assert.equal(binding.bindingToken, capture.bindingToken);
    assert.equal(capture.status, "passed");
    const nativeRecordHash = createHash("sha256").update(line).digest("hex");
    const nativeRecordDir = join(safe, "native-records");
    mkdirSync(nativeRecordDir, { recursive: true });
    writeFileSync(join(nativeRecordDir, arm + ".json"), line, { flag: "wx" });
    assert.equal(facts.facts.length, 18);
    assert.equal(new Set(facts.facts).size, 18);
    assert.equal(facts.modelCalls, 0);
    assert.equal(readFileSync(join(workspace, "candidate-output.txt"), "utf8"), "SYNTHETIC-CANDIDATE-OUTPUT");
    summary.cases.push({ arm, status: record.status, canaryAssertions: facts.facts, modelCalls: 0,
      captureSessionId: capture.sessionId, containerId: capture.containerId, inventorySha256: capture.sha256,
      nativeRecordHash, bindingToken: capture.bindingToken, nativeGradingPassed: record.gradeResult.passed });
    persist();
    assert.equal(record.gradeResult.passed, true);
  }
  clearInterval(poll); poll = undefined;
  assert.equal(summary.captures.length, 2);
  assert.equal(summary.cases.length, 2);
  assert.ok(summary.containers.length >= 2, "Both actual task containers must be observed");
  assert.equal(connections, before);
  assert.equal(serverError, undefined);
  for (const [path, bytes] of originals) assert.equal(readFileSync(path, "utf8"), bytes);
  summary.hostCanariesPreserved = true;
  summary.hostNetworkPositiveControl = true;
  summary.status = "passed"; summary.stage = "complete";
} catch (error) {
  summary.status = "failed";
  const collect = dir => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? collect(join(dir, entry.name)) : entry.name === "sdk-result.json" ? [JSON.parse(readFileSync(join(dir, entry.name), "utf8"))] : []) : [];
  summary.sdkDiagnostics = collect(join(root, "preserved"));
  const diagnostic = ["native-last.log", "last-command.log"].filter(name => existsSync(join(root, name))).map(name => readFileSync(join(root, name), "utf8").slice(-2048)).join("\n");
  summary.failure = { stage: summary.stage, name: error.name, code: error.code ?? null, exitCode: error.exitCode ?? null,
    detail: (error.message + "\n" + diagnostic).slice(-3072).replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]").replace(/(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]") };
  process.exitCode = 1;
} finally {
  if (poll) clearInterval(poll);
  if (server) await new Promise(ok => server.close(ok));
  try {
    if (image) {
      const ids = docker("ps", "-a", "--filter", "ancestor=" + image, "--format", "{{.ID}}").trim().split("\n").filter(Boolean);
      if (ids.length) { for (const id of ids) docker("rm", "-f", id); throw new Error("Native container cleanup incomplete"); }
      for (const volume of volumes) {
        const result = spawnSync("docker", ["volume", "inspect", volume], { env: clean, encoding: "utf8", timeout: 10000 });
        if (result.status === 0) { docker("volume", "rm", volume); throw new Error("Native volume cleanup incomplete"); }
        assert.match(result.stderr, /no such volume/i);
      }
      docker("image", "rm", imageTag);
    }
    summary.cleanup = "passed";
  } catch (error) { summary.cleanup = "failed"; summary.status = "failed"; summary.cleanupError = error.name; process.exitCode = 1; }
  persist();
}
