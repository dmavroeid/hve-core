// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerExecutors as registerProduction } from "/opt/vally-runtime/scripts/restricted-copilot-executor.mjs";

const sdkRoot = "/opt/vally-runtime/node_modules/@github/copilot-sdk";
const sdkPackage = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8"));
assert.equal(sdkPackage.version, "1.0.15");
const { CopilotClient } = await import(pathToFileURL(resolve(sdkRoot, sdkPackage.exports["."].import.default)));
const originalCreate = CopilotClient.prototype.createSession;
let sessions = 0, sendAttempts = 0, modelEvents = 0, catalogCalls = 0;

CopilotClient.prototype.listModels = async () => {
  catalogCalls++;
  throw new Error("MODEL_CATALOG_FORBIDDEN_IN_STARTUP_CHECK");
};
CopilotClient.prototype.resumeSession = async () => {
  throw new Error("SESSION_RESUME_FORBIDDEN_IN_STARTUP_CHECK");
};
CopilotClient.prototype.createSession = async function (config) {
  assert.equal(++sessions, 1, "Exactly one fresh SDK startup per native task");
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.managedSettings.permissions, {
    allow: [], deny: ["Shell(*)"], disableBypassPermissionsMode: "disable",
  });
  assert.deepEqual(config.onPermissionRequest(), { kind: "reject" });
  assert.equal(config.requestExtensions, false);
  assert.equal(config.workingDirectory, "/workspace");
  const status = readFileSync("/proc/self/status", "utf8");
  const rootMount = readFileSync("/proc/self/mountinfo", "utf8").split("\n")
    .map(line => line.split(" ")).find(fields => fields[4] === "/");
  const hardening = {
    uid: process.getuid(), gid: process.getgid(),
    readonlyRoot: rootMount?.[5].split(",").includes("ro") === true,
    noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
    capabilitiesDropped: /^CapEff:\s+0+$/m.test(status),
    networkNone: Object.keys(networkInterfaces()).every(name => name === "lo"),
    memoryBytes: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
    pids: readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(),
    cpu: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
  };
  assert.deepEqual(hardening, {
    uid: 1000, gid: 1000, readonlyRoot: true, noNewPrivileges: true,
    capabilitiesDropped: true, networkNone: true,
    memoryBytes: "536870912", pids: "128", cpu: "100000 100000",
  });
  for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "SKILL_EVAL_INVENTORY_DIR"]) {
    assert.equal(process.env[key], undefined, "Host credential/audit environment must not be projected");
  }
  const session = await originalCreate.call(this, config);
  session.on(event => {
    if (event.type === "user.message" || event.type.startsWith("assistant.")) modelEvents++;
  });
  // The native turn calls sendAndWait; neither public send entry may reach the SDK transport.
  session.send = session.sendAndWait = async () => {
    assert.equal(++sendAttempts, 1);
    assert.equal(modelEvents, 0);
    assert.equal(catalogCalls, 0);
    const directories = readdirSync(config.workingDirectory).filter(name => name.startsWith(".skill-effectiveness-evidence-"));
    assert.equal(directories.length, 1);
    const original = join(config.workingDirectory, directories[0], encodeURIComponent(session.sessionId) + ".json");
    const bytes = readFileSync(original);
    assert.deepEqual(readFileSync(join(config.workingDirectory, directories[0], "startup-backups", encodeURIComponent(session.sessionId) + ".json")), bytes);
    writeFileSync(join(config.workingDirectory, "startup-fence.json"), JSON.stringify({
      schema: "native-startup-backup-check.v1", synthetic: true,
      sessionId: session.sessionId, sessions, sendAttempts, deliveredPrompts: 0,
      modelEvents, catalogCalls, availableTools: config.availableTools, hardening,
      auditDirectory: directories[0],
      inventorySha256: createHash("sha256").update(bytes).digest("hex"),
    }, null, 2) + "\n", { flag: "wx" });
    throw new Error("NATIVE_STARTUP_BACKUP_PRE_SEND_STOP");
  };
  return session;
};

let executor;
registerProduction({ register(value) {
  assert.equal(executor, undefined);
  executor = value;
} });
export async function execute(stimulus, options) {
  return executor.execute(stimulus, options);
}
export async function shutdown() {
  await executor.shutdown();
}
