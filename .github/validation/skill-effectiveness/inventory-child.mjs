// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { CopilotClient } from "@github/copilot-sdk";
import { restrictedFactories, validateSessionPolicy } from "./scripts/restricted-copilot-executor.mjs";

const arm = process.argv[2];
assert.ok(["baseline", "treatment"].includes(arm));
const emit = record => process.stdout.write(JSON.stringify(record) + "\n");
const input = createInterface({ input: process.stdin });
let resolveRelease;
const release = new Promise(resolve => { resolveRelease = resolve; });
input.once("line", line => resolveRelease(JSON.parse(line)));
const bounded = async operation => {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Inventory operation timed out")), 15000);
    })]);
  } finally { clearTimeout(timer); }
};
let client, session, promptCalls = 0, modelEvents = 0, toolsExecuted = 0;
const outcome = { type: "result", arm, status: "running", cleanup: "pending" };
try {
  const require = createRequire(import.meta.url);
  const cliPath = createRequire(require.resolve("@github/copilot/package.json"))
    .resolve("@github/copilot-" + process.platform + "-" + process.arch);
  mkdirSync("/workspace/config", { recursive: true });
  const context = new AsyncLocalStorage();
  const policy = validateSessionPolicy({ sessionPolicy: {
    availableTools: ["bash"], permissions: { allow: ["Shell(*)"], deny: [] },
  } });
  const factories = restrictedFactories(context, options => new CopilotClient({
    ...options, cliPath, cwd: "/workspace", useLoggedInUser: false,
  }));
  await context.run({ policy, timeoutMs: 10000 }, async () => {
    client = factories.createEnvClient({
      PATH: process.env.PATH, HOME: "/workspace/home", TMPDIR: "/tmp",
      COPILOT_HOME: "/workspace/config", CI: "1", DO_NOT_TRACK: "1",
    });
    session = await bounded(() => client.createSession({
      workingDirectory: "/workspace", configDirectory: "/workspace/config",
      enableConfigDiscovery: false,
      skillDirectories: arm === "treatment" ? ["/opt/vally-runtime/prototype-skill"] : [],
      onEvent(event) { if (event.type === "user.message" || event.type.startsWith("assistant.")) modelEvents++; },
    }));
  });
  session.send = session.sendAndWait = async () => { promptCalls++; throw new Error("Model prompts forbidden"); };
  const inventory = await bounded(() => session.rpc.skills.list());
  assert.ok(Array.isArray(inventory.skills));
  emit({ type: "capture", arm, sessionId: session.sessionId,
    toolsExecuted, promptCalls, modelEvents, skills: inventory.skills });
  const ack = await bounded(() => release);
  assert.equal(ack.type, "release");
  assert.equal(ack.arm, arm);
  assert.equal(ack.sessionId, session.sessionId);
  assert.match(ack.sha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof ack.hostFile, "string");
  const attackSource = `
    const fs = require("node:fs"), assert = require("node:assert/strict");
    const host = ${JSON.stringify(ack.hostFile)}, attacks = [];
    const blocked = (name, fn) => {
      let denied = false;
      try { fn(); } catch (error) {
        assert.ok(["ENOENT", "EACCES", "EPERM", "EROFS"].includes(error.code));
        attacks.push({name, code:error.code}); denied = true;
      }
      assert.equal(denied, true, name + " unexpectedly succeeded");
    };
    const fake = "/workspace/inventory-forged.json";
    fs.writeFileSync(fake, JSON.stringify({sessionId:"forged",skills:[]}));
    blocked("host-read", () => fs.readFileSync(host));
    blocked("host-overwrite", () => fs.writeFileSync(host, "FORGED"));
    blocked("host-delete", () => fs.unlinkSync(host));
    blocked("host-rename-substitution", () => fs.renameSync(fake, host));
    fs.writeFileSync(fake, "CANDIDATE-MODIFIED");
    fs.unlinkSync(fake);
    fs.writeFileSync(fake, JSON.stringify({sessionId:"substituted",skills:[]}));
    let channelForgery;
    try {
      fs.writeFileSync("/proc/${process.pid}/fd/1",
        JSON.stringify({type:"capture",arm:"forged",sessionId:"forged",skills:[]})+"\\n");
      channelForgery = {written:true};
    } catch (error) {
      assert.ok(["ENOENT","EACCES","EPERM"].includes(error.code));
      channelForgery = {written:false,code:error.code};
    }
    fs.writeFileSync("/workspace/attack-result.json",
      JSON.stringify({attacks,channelForgery,taskCopyReplaced:true}));
  `;
  const encoded = Buffer.from(attackSource).toString("base64");
  toolsExecuted++;
  const result = await bounded(() => session.rpc.tools.execute({
    name: "bash", toolCallId: "inventory-tamper-" + arm,
    arguments: { command: `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`,
      description: "Attempt synthetic host-inventory tampering and retain controls" },
  }));
  outcome.resultType = result?.resultType ?? "untyped";
  if (outcome.resultType !== "success") outcome.diagnostic = String(result?.error ?? result?.textResultForLlm ?? "").slice(0, 1024)
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]");
  assert.equal(outcome.resultType, "success");
  outcome.tampering = JSON.parse(readFileSync("/workspace/attack-result.json", "utf8"));
  assert.equal(outcome.tampering.attacks.length, 4);
  assert.equal(promptCalls, 0);
  assert.equal(modelEvents, 0);
  outcome.toolsExecuted = toolsExecuted;
  outcome.promptCalls = promptCalls;
  outcome.modelEvents = modelEvents;
  outcome.status = "passed";
} catch (error) {
  outcome.status = "failed";
  outcome.failure = { name: error.name, detail: String(error.message).slice(0, 1024)
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]") };
  process.exitCode = 1;
} finally {
  try {
    if (session) await bounded(() => session.disconnect());
    if (client) await bounded(() => client.stop());
    outcome.cleanup = "passed";
  } catch (error) {
    outcome.status = "failed"; outcome.cleanup = "failed"; outcome.cleanupError = error.name; process.exitCode = 1;
  }
  input.close();
  emit(outcome);
}
