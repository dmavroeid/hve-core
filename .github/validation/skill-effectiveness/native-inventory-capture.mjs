// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function taskReadinessAction(state) {
  if (state?.Status === "created" && state.Running === false) return "wait";
  if (state?.Status === "running" && state.Running === true) return "probe";
  throw new Error(`Native task has non-starting/non-running state: ${state?.Status ?? "missing"}`);
}

export async function captureNativeInventory({ container, arm, image, safe, env, docker, publish }) {
  const originalDir = join(safe, "originals");
  mkdirSync(originalDir, { recursive: true });
  const hostFile = join(originalDir, arm + "-" + randomUUID() + ".json");
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const record = { arm, containerId: container.Id, status: "running", captureAccepted: false,
    released: false, forgeriesRejected: 0, bindingToken: randomUUID() };
  publish(record);
  let child;
  try {
    child = spawn("docker", ["exec", "--interactive", "--user", "1000:1000", container.Id,
      "env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/workspace/home",
      "TMPDIR=/tmp", "DO_NOT_TRACK=1", "VALLY_TELEMETRY_OPTOUT=1",
      "node", "/opt/vally-runtime/inventory-child.mjs", arm],
    { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let protocolError, bytes, result, total = 0, stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-2048); });
    lines.on("line", line => {
      try {
        total += Buffer.byteLength(line);
        assert.ok(total <= 131072, "Bounded capture protocol required");
        const message = JSON.parse(line);
        if (message.type === "capture") {
          if (record.released) { record.forgeriesRejected++; publish(); return; }
          assert.equal(record.captureAccepted, false, "Duplicate pre-release capture");
          assert.equal(message.arm, arm);
          assert.ok(typeof message.sessionId === "string" && message.sessionId.length > 0);
          assert.equal(message.toolsExecuted, 0);
          assert.equal(message.promptCalls, 0);
          assert.equal(message.modelEvents, 0);
          assert.ok(Array.isArray(message.skills) && message.skills.every(s => typeof s?.name === "string" && typeof s.enabled === "boolean"));
          assert.equal(message.skills.some(s => s.name === "inventory-prototype-focus" && s.enabled), arm === "treatment");
          const [observed] = JSON.parse(docker("inspect", container.Id));
          assert.equal(observed.Image, image);
          assert.equal(observed.Id, container.Id);
          assert.equal(observed.Config.Labels["com.docker.compose.project"], container.Config.Labels["com.docker.compose.project"]);
          assert.equal(observed.Config.Labels["com.docker.compose.service"], "task");
          assert.ok(observed.Mounts.every(m => !hostFile.startsWith(m.Source + "/") && m.Destination !== "/var/run/docker.sock"));
          bytes = JSON.stringify({ arm, containerId: container.Id,
            nativeProject: observed.Config.Labels["com.docker.compose.project"],
            sessionId: message.sessionId, phase: "before-task-release",
            toolsExecuted: 0, inventory: message.skills }, null, 2);
          writeFileSync(hostFile, bytes, { flag: "wx", mode: 0o600 });
          assert.throws(() => writeFileSync(hostFile, "FORGED", { flag: "wx" }), e => e.code === "EEXIST");
          record.originalFile = hostFile.split("/").at(-1);
          record.sha256 = hash(readFileSync(hostFile));
          record.sessionId = message.sessionId;
          record.skillNames = message.skills.map(s => s.name);
          record.captureAccepted = true;
          publish();
          record.released = true;
          child.stdin.write(JSON.stringify({ type: "release", arm, sessionId: message.sessionId,
            hostFile, sha256: record.sha256 }) + "\n");
        } else if (message.type === "result") {
          assert.equal(record.released, true, "No candidate result before protected publication");
          assert.equal(result, undefined, "Duplicate final result");
          result = message;
        } else throw new Error("Unexpected capture message");
      } catch (error) { protocolError = error; child.kill("SIGTERM"); }
    });
    record.exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Native capture timed out")); }, 90000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    lines.close();
    record.result = result ?? null;
    if (stderr) record.diagnostic = stderr.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]");
    if (protocolError) throw protocolError;
    assert.equal(record.exit.code, 0);
    assert.equal(result.status, "passed");
    assert.equal(result.cleanup, "passed");
    assert.equal(result.promptCalls, 0);
    assert.equal(result.modelEvents, 0);
    assert.equal(result.toolsExecuted, 1);
    assert.equal(result.tampering.attacks.length, 4);
    assert.equal(result.tampering.taskCopyReplaced, true);
    assert.equal(record.forgeriesRejected, result.tampering.channelForgery.written ? 1 : 0);
    assert.equal(record.forgeriesRejected, 1, "Actual candidate stdout forgery must be rejected");
    assert.equal(readFileSync(hostFile, "utf8"), bytes);
    assert.equal(hash(readFileSync(hostFile)), record.sha256);
    record.originalUnchanged = true;
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.failure = { name: error.name, detail: String(error.message).slice(0, 1024) };
    if (child) child.kill("SIGTERM");
  }
  try {
    const binding = { arm, status: record.status, containerId: container.Id, sessionId: record.sessionId ?? null,
      sha256: record.sha256 ?? null, bindingToken: record.bindingToken };
    docker("exec", "--user", "1000:1000", container.Id, "node", "-e",
      'require("node:fs").writeFileSync("/tmp/native-capture-complete.json", process.argv[1], {flag:"wx"})',
      JSON.stringify(binding));
  } catch (error) {
    record.status = "failed";
    record.signalFailure = { name: error.name, detail: String(error.message).slice(0, 512) };
  }
  publish();
  return record;
}
