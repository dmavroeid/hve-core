// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const skill = process.cwd(), own = dirname(fileURLToPath(import.meta.url));
const root = join(process.env.RUNNER_TEMP, "inventory-d71"), safe = join(root, "safe");
const originals = join(safe, "originals");
mkdirSync(safe, { recursive: true });
mkdirSync(originals);
const summary = { status: "running", scope: "Test-only Docker parent capture barrier, not Vally-native integration",
  assumptions: ["Immutable trusted bootstrap/config", "No candidate code or tools before parent publication"],
  cases: [], cleanup: "pending" };
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const env = { PATH: process.env.PATH, HOME: join(root, "home"), DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
mkdirSync(env.HOME);
const imageTag = "inventory-d71:" + process.env.GITHUB_SHA;
const names = new Set(), processes = new Set();
let image;
const run = (program, args, timeout = 120000) => {
  const result = spawnSync(program, args, { env, encoding: "utf8", cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    writeFileSync(join(root, "last-command.log"), String(result.stdout) + String(result.stderr));
    throw new Error(`Command failed: ${program}, ${result.error?.code ?? result.status}`);
  }
  return result.stdout;
};
function validateCapture(record, arm) {
  assert.equal(record.type, "capture");
  assert.equal(record.arm, arm);
  assert.ok(typeof record.sessionId === "string" && record.sessionId.length > 0);
  assert.equal(record.toolsExecuted, 0);
  assert.equal(record.promptCalls, 0);
  assert.equal(record.modelEvents, 0);
  assert.ok(Array.isArray(record.skills) && record.skills.every(s =>
    typeof s?.name === "string" && typeof s.enabled === "boolean"));
}
persist();
try {
  const valid = { type: "capture", arm: "baseline", sessionId: "fixture",
    toolsExecuted: 0, promptCalls: 0, modelEvents: 0, skills: [] };
  for (const bad of [null, { ...valid, arm: "forged" }, { ...valid, sessionId: "" },
    { ...valid, toolsExecuted: 1 }, { ...valid, skills: [{}] }]) {
    assert.throws(() => validateCapture(bad, "baseline"));
  }
  summary.invalidCaptureNegatives = 5;
  const context = join(root, "context");
  mkdirSync(context);
  for (const file of ["package.json", "package-lock.json"]) writeFileSync(join(context, file), readFileSync(join(skill, file)));
  for (const file of ["inventory-child.mjs", "inventory-prototype.Dockerfile"]) {
    writeFileSync(join(context, file === "inventory-prototype.Dockerfile" ? "Dockerfile" : file), readFileSync(join(own, file)));
  }
  writeFileSync(join(context, "restricted-copilot-executor.mjs"), readFileSync(join(skill, "scripts", "restricted-copilot-executor.mjs")));
  writeFileSync(join(context, "SKILL.md"), "---\nname: inventory-prototype-focus\ndescription: Synthetic inventory fixture only\n---\nNo model prompt permitted.\n");
  run("docker", ["build", "--platform", "linux/amd64", "--pull", "--iidfile", join(root, "image-id"),
    "-t", imageTag, context], 600000);
  image = readFileSync(join(root, "image-id"), "utf8").trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  summary.image = image;
  for (const arm of ["baseline", "treatment"]) {
    const name = "inventory-d71-" + randomUUID();
    names.add(name);
    const workspace = join(root, arm), hostFile = join(originals, arm + "-" + randomUUID() + ".json");
    mkdirSync(join(workspace, "home"), { recursive: true });
    run("chmod", ["-R", "777", workspace]);
    const record = { arm, status: "running", captureAccepted: false, released: false, forgeriesRejected: 0 };
    summary.cases.push(record); persist();
    const child = spawn("docker", ["run", "--rm", "--interactive", "--name", name,
      "--label", "inventory-prototype=" + name, "--user", "1000:1000", "--read-only", "--network", "none",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128",
      "--memory", "512m", "--cpus", "1", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864",
      "--mount", `type=bind,source=${workspace},target=/workspace`,
      "--entrypoint", "node", imageTag, "/opt/vally-runtime/inventory-child.mjs", arm],
    { env, stdio: ["pipe", "pipe", "pipe"] });
    processes.add(child);
    let protocolError, acceptedBytes, result, total = 0, stderr = "";
    const lines = createInterface({ input: child.stdout });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-2048); });
    lines.on("line", line => {
      try {
        total += Buffer.byteLength(line);
        assert.ok(total <= 131072, "Bounded prototype protocol required");
        const message = JSON.parse(line);
        if (message.type === "capture") {
          if (record.released) { record.forgeriesRejected++; persist(); return; }
          assert.equal(record.captureAccepted, false, "Duplicate pre-release inventory");
          validateCapture(message, arm);
          assert.equal(existsSync(join(workspace, "attack-result.json")), false, "No task activity before publication");
          assert.equal(message.skills.some(s => s.name === "inventory-prototype-focus" && s.enabled), arm === "treatment");
          const [container] = JSON.parse(run("docker", ["inspect", name]));
          assert.equal(container.Image, image);
          assert.equal(container.Config.Labels["inventory-prototype"], name);
          assert.equal(container.Config.User, "1000:1000");
          assert.equal(container.HostConfig.ReadonlyRootfs, true);
          assert.equal(container.HostConfig.NetworkMode, "none");
          assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]);
          assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
          assert.equal(container.HostConfig.PidsLimit, 128);
          assert.equal(container.HostConfig.Memory, 536870912);
          assert.equal(container.HostConfig.NanoCpus, 1000000000);
          assert.ok(container.Mounts.every(m => m.Type === "tmpfs" || (m.Type === "bind" && m.Source === workspace && m.Destination === "/workspace")));
          record.hardeningInspected = true;
          acceptedBytes = JSON.stringify({ arm, containerId: container.Id, phase: "before-task-release",
            sessionId: message.sessionId, inventory: message.skills, toolsExecuted: 0 }, null, 2);
          writeFileSync(hostFile, acceptedBytes, { flag: "wx", mode: 0o600 });
          assert.throws(() => writeFileSync(hostFile, "DUPLICATE", { flag: "wx" }), e => e.code === "EEXIST");
          record.sha256 = hash(readFileSync(hostFile));
          record.sessionId = message.sessionId;
          record.skillNames = message.skills.map(s => s.name);
          record.captureAccepted = true;
          persist();
          record.released = true;
          child.stdin.write(JSON.stringify({ type: "release", arm, sessionId: message.sessionId, hostFile, sha256: record.sha256 }) + "\n");
        } else if (message.type === "result") {
          assert.equal(result, undefined, "Duplicate final result");
          assert.equal(record.released, true, "No task result before host publication");
          result = message;
        } else throw new Error("Unexpected prototype message");
      } catch (error) {
        protocolError = error; child.kill("SIGTERM");
      }
    });
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Prototype container timed out")); }, 180000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    processes.delete(child);
    lines.close();
    record.result = result ?? null;
    record.exit = exit;
    if (stderr) record.diagnostic = stderr.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]");
    persist();
    if (protocolError) throw protocolError;
    assert.equal(exit.code, 0);
    assert.equal(result.status, "passed");
    assert.equal(result.cleanup, "passed");
    assert.equal(result.promptCalls, 0);
    assert.equal(result.modelEvents, 0);
    assert.equal(result.toolsExecuted, 1);
    assert.equal(result.tampering.attacks.length, 4);
    assert.equal(result.tampering.taskCopyReplaced, true);
    assert.equal(record.forgeriesRejected, result.tampering.channelForgery.written ? 1 : 0);
    assert.equal(readFileSync(hostFile, "utf8"), acceptedBytes);
    assert.equal(hash(readFileSync(hostFile)), record.sha256);
    record.originalUnchanged = true;
    record.status = "passed";
    persist();
  }
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.failure = { name: error.name, detail: String(error.message).slice(0, 1024) };
  process.exitCode = 1;
} finally {
  for (const child of processes) child.kill("SIGTERM");
  try {
    for (const name of names) {
      const ids = run("docker", ["ps", "-a", "--filter", "label=inventory-prototype=" + name, "--format", "{{.ID}}"]).trim();
      if (ids) { run("docker", ["rm", "-f", name]); throw new Error("Prototype container cleanup incomplete"); }
    }
    if (image) run("docker", ["image", "rm", imageTag]);
    summary.cleanup = "passed";
  } catch (error) {
    summary.cleanup = "failed"; summary.status = "failed"; summary.cleanupError = error.name; process.exitCode = 1;
  }
  persist();
}
