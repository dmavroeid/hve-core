// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(process.env.RUNNER_TEMP, "offered-sdk-d68"), safe = join(root, "safe");
mkdirSync(safe, { recursive: true });
const summary = { status: "running", scope: "Actual offered bash permission handler with raw SDK positive control; no model prompt", cases: [], promptMethodsCalled: 0, modelEvents: 0, cleanup: "pending" };
const persist = () => writeFileSync(join(safe, "summary.json"), JSON.stringify(summary, null, 2));
persist();
const require = createRequire(join(process.cwd(), "package.json"));
const sessions = new Set(), clients = new Set();
const bounded = async (operation, label) => {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), 12000); })]);
  } finally { clearTimeout(timer); }
};
const safeMessage = error => String(error.message).slice(0, 768).replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]").replace(/(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]");
try {
  for (const [name, version] of [["@microsoft/vally", "0.19.0"], ["@microsoft/vally-cli", "0.19.0"], ["@github/copilot-sdk", "1.0.15"], ["@github/copilot", "1.0.89"]]) {
    assert.equal(JSON.parse(readFileSync(join(process.cwd(), "node_modules", ...name.split("/"), "package.json"), "utf8")).version, version);
  }
  const sdkRoot = join(process.cwd(), "node_modules", "@github", "copilot-sdk");
  const manifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  const { CopilotClient } = await import(pathToFileURL(resolve(sdkRoot, manifest.exports["."].import.default)));
  const { restrictedFactories, validateSessionPolicy } = await import(pathToFileURL(join(process.cwd(), "scripts", "restricted-copilot-executor.mjs")));
  const cliPath = createRequire(require.resolve("@github/copilot/package.json")).resolve("@github/copilot-" + process.platform + "-" + process.arch);
  for (const name of ["positive-control", "baseline", "treatment"]) {
    const positive = name === "positive-control";
    const work = join(root, name), configDirectory = join(work, "config"), assigned = join(work, "assigned");
    mkdirSync(configDirectory, { recursive: true });
    mkdirSync(assigned);
    writeFileSync(join(assigned, "SKILL.md"), "---\nname: synthetic-assigned\ndescription: Synthetic fixture only\n---\nNo model request is permitted.\n");
    const marker = join(work, "permission-marker.txt");
    const record = { name, stage: "create", toolCount: null, permissionRequests: 0, decisionKinds: [], resultType: null, permissionDenied: false, markerPresent: null, disconnected: false };
    summary.cases.push(record); persist();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, COPILOT_HOME: configDirectory, CI: "1", DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
    const createClient = options => {
      const client = new CopilotClient({ ...options, cliPath, cwd: work, env, useLoggedInUser: false });
      clients.add(client);
      const create = client.createSession.bind(client);
      client.createSession = async config => {
        assert.deepEqual(config.availableTools, ["bash"]);
        if (!positive) assert.deepEqual(config.managedSettings.permissions, { allow: [], deny: [], disableBypassPermissionsMode: "disable" });
        const handler = config.onPermissionRequest;
        assert.equal(typeof handler, "function");
        const session = await create({
          ...config,
          onPermissionRequest: async (...args) => {
            record.permissionRequests++;
            const decision = await handler(...args);
            record.decisionKinds.push(["approved", "denied-no-approval-rule-and-could-not-request-from-user"].includes(decision?.kind) ? decision.kind : "other");
            persist();
            return decision;
          },
        });
        sessions.add(session);
        session.send = session.sendAndWait = async () => { summary.promptMethodsCalled++; throw new Error("Prompt method forbidden"); };
        return session;
      };
      return client;
    };
    let client, session;
    try {
      const context = new AsyncLocalStorage();
      const policy = validateSessionPolicy({ sessionPolicy: { availableTools: ["bash"], permissions: { allow: [], deny: [] } } });
      const factories = restrictedFactories(context, createClient);
      const config = {
        workingDirectory: work, configDirectory, enableConfigDiscovery: false, skillDirectories: name === "treatment" ? [assigned] : [],
        onEvent(event) { if (event.type === "user.message" || event.type.startsWith("assistant.")) summary.modelEvents++; },
      };
      if (positive) {
        client = createClient({});
        session = await bounded(() => client.createSession({ ...config, availableTools: ["bash"], onPermissionRequest: () => ({ kind: "approved" }) }), "Positive-control session");
        await bounded(() => session.rpc.tools.initializeAndValidate(), "Positive-control tools");
      } else {
        await context.run({ policy, timeoutMs: 10000 }, async () => {
          client = factories.createEnvClient(env);
          session = await bounded(() => client.createSession(config), "Actual restricted session");
        });
      }
      record.stage = "metadata"; persist();
      const metadata = await bounded(() => session.rpc.tools.getCurrentMetadata(), "Actual offered tools");
      record.toolCount = metadata.tools?.length ?? null;
      record.bashOffered = Array.isArray(metadata.tools) && metadata.tools.some(tool => tool.name === "bash");
      persist();
      assert.deepEqual(metadata.tools.map(tool => tool.name), ["bash"]);
      record.stage = "execute"; persist();
      const result = await bounded(() => session.rpc.tools.execute({
        name: "bash", arguments: { command: "printf SYNTHETIC > permission-marker.txt", description: "Write the synthetic permission-test marker" },
        toolCallId: "synthetic-" + name,
      }), "Actual offered bash invocation");
      const text = typeof result === "string" ? result : [result?.error, result?.textResultForLlm].filter(value => typeof value === "string").join("\n");
      record.resultType = typeof result?.resultType === "string" ? result.resultType : "untyped-result";
      if (record.resultType !== "success") record.diagnostic = text.slice(0, 768)
        .replace(/\u001b\[[0-9;]*m/g, "")
        .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]")
        .replace(/(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]");
      record.permissionDenied = /permission[\s\S]{0,100}denied|denied[\s\S]{0,100}permission|denied-no-approval|not approved|user rejected/i.test(text);
      record.notOffered = /unknown tool|tool[\s\S]{0,120}not (?:found|available|offered)/i.test(text);
      record.markerPresent = existsSync(marker);
      record.markerMatches = record.markerPresent && readFileSync(marker, "utf8") === "SYNTHETIC";
      persist();
      assert.equal(record.notOffered, false, "Offered-tool proof must not rely on unavailable tools");
      if (positive) {
        assert.equal(record.resultType, "success");
        assert.equal(record.markerMatches, true, "Positive command must execute");
      } else {
        assert.equal(record.markerPresent, false);
        assert.ok(record.permissionRequests > 0, "Actual production deny handler must be reached");
        assert.ok(record.decisionKinds.every(kind => kind === "denied-no-approval-rule-and-could-not-request-from-user"));
        assert.ok(record.resultType === "denied" || (["failure", "rejected"].includes(record.resultType) && record.permissionDenied),
          "Explicit offered-tool permission rejection required");
      }
      record.stage = "passed";
    } catch (error) {
      record.stage = "failed"; record.markerPresent = existsSync(marker);
      record.failure = { name: error.name, detail: safeMessage(error) };
    } finally {
      try {
        if (session) {
          await bounded(() => session.disconnect(), "Session disconnect");
          record.disconnected = true; sessions.delete(session);
        }
        if (client) { await bounded(() => client.stop(), "Client stop"); clients.delete(client); }
      } catch (error) { record.stage = "failed"; record.cleanupError = error.name; }
      persist();
    }
  }
  assert.ok(summary.cases.every(record => record.stage === "passed"), "Positive control and both restricted arms must pass");
  assert.equal(summary.promptMethodsCalled, 0);
  assert.equal(summary.modelEvents, 0);
  summary.status = "passed";
} catch (error) {
  summary.status = "failed"; summary.failure = { name: error.name, detail: safeMessage(error) }; process.exitCode = 1;
} finally {
  try {
    for (const session of sessions) await bounded(() => session.disconnect(), "Final session disconnect");
    for (const client of clients) await bounded(() => client.stop(), "Final client stop");
    summary.cleanup = "passed";
  } catch (error) { summary.cleanup = "failed"; summary.status = "failed"; summary.cleanupError = error.name; process.exitCode = 1; }
  persist();
}
