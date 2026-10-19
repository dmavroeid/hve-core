// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { captureInventory } from "/opt/vally-runtime/scripts/native-inventory.mjs";
import { RestrictedCopilotExecutor, registerExecutors as registerProduction } from "/opt/vally-runtime/scripts/restricted-copilot-executor.mjs";

const sdkRoot = "/opt/vally-runtime/node_modules/@github/copilot-sdk";
const sdkPackage = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8"));
assert.equal(sdkPackage.version, "1.0.15");
const { CopilotClient } = await import(pathToFileURL(resolve(sdkRoot, sdkPackage.exports["."].import.default)));
const originalCreate = CopilotClient.prototype.createSession;
let execution, calls = 0, promptCalls = 0, modelEvents = 0, catalogCalls = 0;
const wait = async file => {
  const deadline = Date.now() + 6000;
  while (!existsSync(file)) {
    assert.ok(Date.now() < deadline, "Trusted same-session barrier timed out");
    await sleep(20);
  }
  return JSON.parse(readFileSync(file, "utf8"));
};
CopilotClient.prototype.listModels = async () => {
  catalogCalls++;
  throw new Error("MODEL_CATALOG_FORBIDDEN_IN_PREFLIGHT");
};
CopilotClient.prototype.createSession = async function (config) {
  assert.ok(execution, "Actual production execute must own session creation");
  assert.equal(++calls, 1, "No bootstrap or replacement SDK session");
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.managedSettings.permissions, {
    allow: [], deny: ["Shell(*)"], disableBypassPermissionsMode: "disable",
  });
  assert.deepEqual(config.onPermissionRequest(), { kind: "reject" });
  assert.equal(config.enableConfigDiscovery, true);
  assert.equal(config.requestExtensions, false);
  const session = await originalCreate.call(this, config);
  const actualSessionId = session.sessionId;
  if (execution.requestedSessionId !== null) assert.equal(actualSessionId, execution.requestedSessionId);
  session.on(event => {
    if (event.type === "user.message" || event.type.startsWith("assistant.")) modelEvents++;
  });
  session.send = session.sendAndWait = async () => {
    promptCalls++;
    throw new Error("MODEL_SEND_FORBIDDEN_IN_PREFLIGHT");
  };
  let disconnected = false;
  try {
    const file = await captureInventory(session, config, "/tmp/same-session-inventory");
    const inventoryBytes = readFileSync(file, "utf8");
    const inventory = JSON.parse(inventoryBytes);
    assert.equal(inventory.sessionId, actualSessionId);
    assert.equal(inventory.phase, "before-first-prompt");
    const tools = await session.rpc.tools.getCurrentMetadata();
    assert.deepEqual(tools.tools, []);
    writeFileSync("/tmp/same-session-ready.json", JSON.stringify({
      actualSessionId, requestedSessionId: execution.requestedSessionId,
      executorClass: execution.executorClass, executorName: execution.executorName,
      createSessionCalls: calls, promptCalls, modelEvents, catalogCalls, toolsExecuted: 0,
      inventoryBytes, availableTools: config.availableTools,
      managedPermissions: config.managedSettings.permissions, requestExtensions: config.requestExtensions,
    }), { flag: "wx" });
    const release = await wait("/tmp/same-session-release.json");
    assert.equal(release.sessionId, actualSessionId);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    await session.disconnect();
    disconnected = true;
    const result = { status: "passed", actualSessionId, requestedSessionId: execution.requestedSessionId,
      hostSha256: release.sha256, bindingToken: release.bindingToken,
      createSessionCalls: calls, promptCalls, modelEvents, catalogCalls, toolsExecuted: 0,
      cleanup: "passed", stopKind: "before-createSession-return" };
    writeFileSync("/tmp/same-session-stopped.json", JSON.stringify(result), { flag: "wx" });
    const finalize = await wait("/tmp/same-session-finalize.json");
    assert.equal(finalize.sessionId, actualSessionId);
    assert.equal(finalize.sha256, release.sha256);
    execution.result = result;
    throw new Error(`MODEL_FREE_SAME_SESSION_PREFLIGHT_STOP:${actualSessionId}:${release.sha256}`);
  } finally {
    if (!disconnected) await session.disconnect();
  }
};

export function registerExecutors(registry) {
  registerProduction(registry);
  const executor = registry.get("restricted-copilot-sdk");
  assert.ok(executor instanceof RestrictedCopilotExecutor);
  const actualExecute = executor.execute.bind(executor);
  executor.execute = async (stimulus, options) => {
    assert.equal(execution, undefined, "Exactly one native production execution per arm");
    execution = { executorClass: executor.constructor.name, executorName: executor.name,
      requestedSessionId: options.sessionLog?.sessionID ?? null };
    try {
      return await actualExecute(stimulus, options);
    } finally {
      writeFileSync("/workspace/same-session-facts.json", JSON.stringify({
        ...execution, createSessionCalls: calls, promptCalls, modelEvents, catalogCalls,
      }), { flag: "wx" });
    }
  };
}
