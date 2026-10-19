// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(process.env.RUNNER_TEMP, "restricted-sdk-d66");
const safe = join(root, "safe");
mkdirSync(safe, { recursive: true });
const summary = { status: "running", scope: "Real restricted SDK no-prompt tool RPC; not OS containment or model execution", stage: "identity", promptMethodsCalled: 0, modelEvents: 0, arms: [], cleanup: "pending" };
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2));
persist();
const require = createRequire(join(process.cwd(), "package.json"));
const clients = [];
const sessions = [];
const bounded = async (operation, label) => {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), 12000); })]);
  } finally { clearTimeout(timer); }
};
try {
  for (const [name, version] of [["@microsoft/vally", "0.19.0"], ["@microsoft/vally-cli", "0.19.0"], ["@github/copilot-sdk", "1.0.15"], ["@github/copilot", "1.0.89"]]) {
    const manifest = join(process.cwd(), "node_modules", ...name.split("/"), "package.json");
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, version);
  }
  const sdkRoot = join(process.cwd(), "node_modules", "@github", "copilot-sdk");
  const sdkPackage = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  const { CopilotClient } = await import(pathToFileURL(resolve(sdkRoot, sdkPackage.exports["."].import.default)));
  const { restrictedFactories, validateSessionPolicy, registerExecutors } = await import(pathToFileURL(join(process.cwd(), "scripts", "restricted-copilot-executor.mjs")));
  registerExecutors({ register(executor) { assert.equal(executor.name, "restricted-copilot-sdk"); } });
  const cliPath = createRequire(require.resolve("@github/copilot/package.json")).resolve("@github/copilot-" + process.platform + "-" + process.arch);
  for (const arm of ["baseline", "treatment"]) {
    const work = join(root, arm), configDirectory = join(work, "config");
    mkdirSync(configDirectory, { recursive: true });
    const assigned = join(work, "assigned");
    mkdirSync(assigned);
    writeFileSync(join(assigned, "SKILL.md"), "---\nname: synthetic-assigned\ndescription: Synthetic fixture only\n---\nDo not make network or model requests.\n");
    const context = new AsyncLocalStorage();
    const policy = validateSessionPolicy({ sessionPolicy: { availableTools: [], permissions: { allow: [], deny: [] } } });
    const record = { arm, stage: "create", toolCount: null, attempts: [], resumeRejected: false, disconnected: false };
    summary.arms.push(record); persist();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, COPILOT_HOME: configDirectory, CI: "1", DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
    const factories = restrictedFactories(context, options => {
      const client = new CopilotClient({ ...options, cliPath, cwd: work, useLoggedInUser: false });
      clients.push(client);
      const create = client.createSession.bind(client);
      client.createSession = async config => {
        assert.deepEqual(config.availableTools, []);
        assert.deepEqual(config.managedSettings.permissions, { allow: [], deny: [], disableBypassPermissionsMode: "disable" });
        const session = await create(config);
        sessions.push(session);
        session.send = session.sendAndWait = async () => { summary.promptMethodsCalled++; throw new Error("Prompt method forbidden"); };
        return session;
      };
      return client;
    });
    await context.run({ policy, timeoutMs: 10000 }, async () => {
      const client = factories.createEnvClient(env);
      const session = await bounded(() => client.createSession({
        workingDirectory: work, configDirectory, enableConfigDiscovery: false,
        skillDirectories: arm === "treatment" ? [assigned] : [],
        onEvent(event) {
          if (event.type === "user.message" || event.type.startsWith("assistant.")) summary.modelEvents++;
        },
      }), "Restricted session startup");
      record.stage = "metadata"; persist();
      const metadata = await bounded(() => session.rpc.tools.getCurrentMetadata(), "Real tool metadata");
      assert.deepEqual(metadata.tools, []);
      record.toolCount = metadata.tools.length;
      await assert.rejects(client.resumeSession("synthetic-forbidden-resume"), /does not support session resume/);
      record.resumeRejected = true;
      const marker = join(work, "forbidden-write.txt");
      for (const probe of [
        { name: "bash", arguments: { command: "printf SYNTHETIC > forbidden-write.txt" } },
        { name: "view", arguments: { path: join(work, "assigned", "SKILL.md") } },
      ]) {
        record.stage = "native-tool-execute"; persist();
        let result;
        try {
          result = await bounded(() => session.rpc.tools.execute(probe), "Native excluded tool invocation");
        } catch (error) {
          assert.notEqual(error.message, "Native excluded tool invocation timed out");
          assert.match(error.message, /not (?:found|available|offered)|unknown tool|not in|not enabled|not permitted|denied|disallowed/i);
          record.attempts.push({ tool: probe.name, outcome: "rpc-rejection", rejectionCode: Number.isSafeInteger(error.code) ? error.code : null });
          persist();
          continue;
        }
        assert.ok(result && typeof result === "object", "Typed rejection required");
        assert.ok(["rejected", "denied"].includes(result.resultType), "Not a successful invocation or generic task failure");
        record.attempts.push({ tool: probe.name, outcome: result.resultType });
        persist();
      }
      assert.equal(existsSync(marker), false);
      assert.equal(record.attempts.length, 2);
      await bounded(() => session.disconnect(), "Restricted session disconnect");
      record.disconnected = true;
      sessions.splice(sessions.indexOf(session), 1);
      await bounded(() => client.stop(), "Restricted client stop");
      clients.splice(clients.indexOf(client), 1);
      record.stage = "passed"; persist();
    });
  }
  assert.equal(summary.promptMethodsCalled, 0);
  assert.equal(summary.modelEvents, 0);
  summary.status = "passed"; summary.stage = "complete";
} catch (error) {
  summary.status = "failed";
  summary.failure = { stage: summary.stage, name: error.name, code: Number.isSafeInteger(error.code) ? error.code : null,
    detail: String(error.message).slice(0, 2048).replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]").replace(/(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]") };
  process.exitCode = 1;
} finally {
  try {
    for (const session of sessions) await bounded(() => session.disconnect(), "Final session disconnect");
    for (const client of clients) await bounded(() => client.stop(), "Final client stop");
    summary.cleanup = "passed";
  } catch (error) { summary.cleanup = "failed"; summary.status = "failed"; summary.cleanupError = error.name; process.exitCode = 1; }
  persist();
}
