// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { registerExecutors } from "./startup-backup-executor/index.mjs";

const own = dirname(fileURLToPath(import.meta.url));
function fixture({ networkNone = true } = {}) {
  const state = { sessions: 0, delivered: 0, facts: null };
  class CopilotClient {
    async createSession() {
      state.sessions++;
      return { sessionId: "synthetic-session", on() {},
        async send() { state.delivered++; }, async sendAndWait() { state.delivered++; } };
    }
  }
  const source = readFileSync(join(own, "startup-backup-hook.mjs"), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace('const { CopilotClient } = await import(pathToFileURL(resolve(sdkRoot, sdkPackage.exports["."].import.default)));', "const { CopilotClient } = sdk;")
    .replace(/^export /gm, "");
  const read = (file) => {
    if (file.endsWith("package.json")) return JSON.stringify({ version: "1.0.15", exports: { ".": { import: { default: "index.js" } } } });
    if (file === "/proc/self/status") return "CapEff:\t0000000000000000\nNoNewPrivs:\t1\n";
    if (file === "/proc/self/mountinfo") return "1 0 0:1 / / ro - overlay overlay ro";
    if (file.endsWith("memory.max")) return "536870912";
    if (file.endsWith("pids.max")) return "128";
    if (file.endsWith("cpu.max")) return "100000 100000";
    if (file.endsWith("synthetic-session.json")) return Buffer.from("SYNTHETIC-INDEPENDENT-BACKUP-CONTROL");
    throw new Error("Unexpected fixture read");
  };
  const context = vm.createContext({
    assert, sdk: { CopilotClient }, readFileSync: read,
    writeFileSync(file, bytes, options) {
      assert.ok(file.endsWith("startup-fence.json"));
      assert.equal(options.flag, "wx");
      state.facts = JSON.parse(bytes);
    },
    readdirSync: () => [".skill-effectiveness-evidence-abc123"],
    networkInterfaces: () => networkNone ? { lo: [] } : { lo: [], eth0: [] },
    join, resolve, process: { getuid: () => 1000, getgid: () => 1000, env: {} },
    createHash,
    registerProduction(registry) {
      registry.register({
        async execute() {
          const session = await new CopilotClient().createSession(context.config);
          return session[context.sendMethod]({ prompt: "MUST NEVER REACH TRANSPORT" });
        },
        async shutdown() {},
      });
    },
  });
  return { state, context, source };
}

function load(options) {
  const value = fixture(options);
  vm.runInContext(value.source + "\nglobalThis.executeProbe = execute;", value.context);
  vm.runInContext(`globalThis.config = {
    availableTools: [], managedSettings: { permissions: { allow: [], deny: ["Shell(*)"], disableBypassPermissionsMode: "disable" } },
    onPermissionRequest: () => ({kind: "reject"}), requestExtensions: false, workingDirectory: "/workspace"
  };`, value.context);
  return value;
}

test("host plugin registration does not import the container runtime or start SDK", async () => {
  let executor;
  registerExecutors({ register(value) { assert.equal(executor, undefined); executor = value; } });
  assert.equal(executor.name, "restricted-copilot-sdk");
  executor.validateConfig({ sessionPolicy: { availableTools: [], permissions: { allow: [], deny: ["Shell(*)"] } } });
  await executor.shutdown();
});

for (const sendMethod of ["send", "sendAndWait"]) {
  test(`actual hook fences ${sendMethod} before transport without faking a model response`, async () => {
    const { state, context } = load();
    context.sendMethod = sendMethod;
    await assert.rejects(context.executeProbe(), /NATIVE_STARTUP_BACKUP_PRE_SEND_STOP/);
    assert.equal(state.sessions, 1);
    assert.equal(state.delivered, 0);
    assert.equal(state.facts.deliveredPrompts, 0);
    assert.equal(state.facts.sendAttempts, 1);
    assert.equal(state.facts.modelEvents, 0);
    await assert.rejects(context.executeProbe(), /Exactly one fresh SDK startup/);
    assert.equal(state.sessions, 1);
    assert.equal(state.delivered, 0);
  });
}

test("actual hook rejects non-isolated networking before even starting SDK", async () => {
  const { state, context } = load({ networkNone: false });
  context.sendMethod = "sendAndWait";
  await assert.rejects(context.executeProbe());
  assert.equal(state.sessions, 0);
  assert.equal(state.delivered, 0);
  assert.equal(state.facts, null);
});

test("task overlay inherits native singleton security options instead of duplicating them", () => {
  const source = readFileSync(join(own, "startup-backup-run.mjs"), "utf8");
  const match = source.match(/const hardening = (\{[\s\S]*?\n  \});/);
  assert.ok(match);
  const overlay = vm.runInNewContext(`(${match[1]})`, { tag: "synthetic-test-image" });
  assert.equal(Object.hasOwn(overlay, "security_opt"), false);
  assert.equal(Object.hasOwn(overlay, "cap_drop"), false);
  assert.equal(overlay.read_only, true);
  assert.equal(overlay.pids_limit, 128);
  assert.equal(overlay.mem_limit, "512m");
  assert.equal(overlay.cpus, 1);
});
