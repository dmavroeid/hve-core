// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function captureNativeInventory({ container, arm, image, safe, env, docker, publish }) {
  const originalDir = join(safe, "originals");
  mkdirSync(originalDir, { recursive: true });
  const file = join(originalDir, arm + "-" + randomUUID() + ".json");
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const record = { arm, containerId: container.Id, status: "running", bindingToken: randomUUID() };
  publish(record);
  let child;
  try {
    child = spawn("docker", ["exec", "--interactive", "--user", "1000:1000", container.Id,
      "env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "DO_NOT_TRACK=1", "VALLY_TELEMETRY_OPTOUT=1",
      "node", "/opt/vally-runtime/same-session-relay.mjs", arm], { env, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let protocolError, bytes, result, total = 0, stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-2048); });
    lines.on("line", line => {
      try {
        total += Buffer.byteLength(line);
        assert.ok(total <= 131072);
        const message = JSON.parse(line);
        if (message.type === "capture") {
          assert.equal(record.captureAccepted, undefined, "No duplicate or post-release capture");
          assert.equal(message.arm, arm);
          assert.match(message.actualSessionId, /^[a-f0-9-]{36}$/);
          assert.equal(message.executorClass, "RestrictedCopilotExecutor");
          assert.equal(message.executorName, "restricted-copilot-sdk");
          for (const key of ["promptCalls", "modelEvents", "catalogCalls", "toolsExecuted"]) assert.equal(message[key], 0);
          assert.equal(message.createSessionCalls, 1);
          assert.deepEqual(message.availableTools, []);
          assert.deepEqual(message.managedPermissions, { allow: [], deny: ["Shell(*)"], disableBypassPermissionsMode: "disable" });
          bytes = message.inventoryBytes;
          assert.equal(typeof bytes, "string");
          const inventory = JSON.parse(bytes);
          assert.equal(inventory.sessionId, message.actualSessionId);
          if (message.requestedSessionId !== null) assert.equal(inventory.sessionId, message.requestedSessionId);
          assert.equal(inventory.phase, "before-first-prompt");
          assert.equal(inventory.enableConfigDiscovery, true);
          assert.equal(message.requestExtensions, false);
          assert.ok(Array.isArray(inventory.skillDetails.skills));
          const skills = inventory.skillDetails.skills;
          assert.ok(skills.every(s => typeof s?.name === "string" && typeof s.enabled === "boolean"));
          assert.equal(skills.some(s => s.name === "canary-skill" && s.enabled), arm === "treatment");
          if (arm === "baseline") assert.equal(skills.length, 0);
          const [observed] = JSON.parse(docker("inspect", container.Id));
          assert.equal(observed.Image, image);
          assert.equal(observed.Id, container.Id);
          assert.equal(observed.Config.Labels["com.docker.compose.service"], "task");
          assert.equal(observed.Config.Labels["com.docker.compose.project"], container.Config.Labels["com.docker.compose.project"]);
          assert.ok(observed.Mounts.every(m => !file.startsWith(m.Source + "/") && m.Destination !== "/var/run/docker.sock"));
          writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
          assert.throws(() => writeFileSync(file, "FORGED", { flag: "wx" }), e => e.code === "EEXIST");
          Object.assign(record, { originalFile: file.split("/").at(-1), sha256: hash(readFileSync(file)),
            sessionId: inventory.sessionId, requestedSessionId: message.requestedSessionId,
            skillNames: skills.map(s => s.name), captureAccepted: true, released: true });
          publish();
          child.stdin.write(JSON.stringify({ type: "release", arm, sessionId: record.sessionId,
            sha256: record.sha256, bindingToken: record.bindingToken }) + "\n");
        } else if (message.type === "result") {
          assert.equal(record.released, true);
          assert.equal(result, undefined);
          result = message;
          assert.equal(result.status, "passed");
          assert.equal(result.actualSessionId, record.sessionId);
          assert.equal(result.hostSha256, record.sha256);
          assert.equal(result.bindingToken, record.bindingToken);
          assert.equal(result.createSessionCalls, 1);
          for (const key of ["promptCalls", "modelEvents", "catalogCalls", "toolsExecuted"]) assert.equal(result[key], 0);
          assert.equal(result.stopKind, "before-createSession-return");
          assert.equal(result.cleanup, "passed");
          child.stdin.end(JSON.stringify({ type: "finalize", sessionId: record.sessionId, sha256: record.sha256 }) + "\n");
        } else throw new Error("Unexpected same-session capture packet");
      } catch (error) { protocolError = error; child.kill("SIGTERM"); }
    });
    record.exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Same-session relay timed out")); }, 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    lines.close();
    record.result = result ?? null;
    if (stderr) record.diagnostic = stderr;
    if (protocolError) throw protocolError;
    assert.equal(record.exit.code, 0);
    assert.ok(result, "Actual session stop result required");
    assert.equal(readFileSync(file, "utf8"), bytes);
    assert.equal(hash(readFileSync(file)), record.sha256);
    record.originalUnchanged = true;
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.failure = { name: error.name, detail: String(error.message).slice(0, 1024) };
    if (child) child.kill("SIGTERM");
  }
  publish();
  return record;
}
