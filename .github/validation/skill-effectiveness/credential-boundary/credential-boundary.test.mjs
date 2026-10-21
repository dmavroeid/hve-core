// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("actual offered shell cannot read the synthetic runtime credential", { timeout: 90000 }, async () => {
  const require = createRequire(join(process.cwd(), "package.json"));
  for (const [name, version] of [["@microsoft/vally", "0.19.0"],
    ["@github/copilot-sdk", "1.0.15"], ["@github/copilot", "1.0.89"]]) {
    assert.equal(JSON.parse(readFileSync(join("node_modules", ...name.split("/"), "package.json"))).version, version);
  }
  const { CopilotClient } = await import("@github/copilot-sdk");
  const { restrictedFactories, validateSessionPolicy } =
    await import(pathToFileURL(resolve("scripts/restricted-copilot-executor.mjs")));
  const cliPath = createRequire(require.resolve("@github/copilot/package.json"))
    .resolve("@github/copilot-" + process.platform + "-" + process.arch);
  const work = mkdtempSync("/tmp/credential-boundary-");
  const home = join(work, "home"), configDirectory = join(work, "config");
  mkdirSync(home);
  mkdirSync(configDirectory);
  const canary = "HVE_SYNTHETIC_CREDENTIAL_CANARY_NOT_A_REAL_TOKEN";
  assert.equal(process.env.COPILOT_GITHUB_TOKEN, canary);
  const env = { PATH: process.env.PATH, HOME: home, COPILOT_HOME: configDirectory,
    DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1", CI: "1", COPILOT_GITHUB_TOKEN: canary };
  const record = { scope: "Synthetic credential only; actual SDK tool RPC; no prompt or inference",
    measurement: "Exact COPILOT_GITHUB_TOKEN value/key match, not a marker anywhere in command metadata",
    offeredShell: false, positiveWrite: false, toolEnvCanary: null, procCanary: null,
    promptMethodsCalled: 0, modelEvents: 0, shutdown: "pending" };
  const bounded = async (operation, label) => {
    let timer;
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out")), 15000);
      })]);
    } finally { clearTimeout(timer); }
  };
  let client, session;
  try {
    const context = new AsyncLocalStorage();
    const policy = validateSessionPolicy({ sessionPolicy: {
      availableTools: ["bash"], permissions: { allow: ["Shell(*)"], deny: [] },
    } });
    const factory = restrictedFactories(context, options => {
      client = new CopilotClient({ ...options, cliPath, cwd: work, env,
        gitHubToken: canary, useLoggedInUser: false });
      return client;
    });
    await context.run({ policy, timeoutMs: 10000, inventories: [] }, async () => {
      const wrapped = factory.createEnvClient(env);
      session = await bounded(() => wrapped.createSession({
        workingDirectory: work, configDirectory, enableConfigDiscovery: false,
        skillDirectories: [],
        onEvent(event) {
          if (event.type === "user.message" || event.type.startsWith("assistant.")) record.modelEvents++;
        },
      }), "Restricted no-prompt session creation");
    });
    session.send = session.sendAndWait = async () => {
      record.promptMethodsCalled++;
      throw new Error("Model prompts are forbidden");
    };
    const metadata = await bounded(() => session.rpc.tools.getCurrentMetadata(), "Actual tool inventory");
    assert.deepEqual(metadata.tools.map(tool => tool.name), ["bash"]);
    record.offeredShell = true;
    const script = [
      'const fs=require("node:fs");',
      'const marker="HVE_SYNTHETIC_CREDENTIAL_CANARY_NOT_A_REAL_TOKEN";',
      'fs.writeFileSync("positive-write.txt","synthetic-only");',
      'const toolEnvCanary=process.env.COPILOT_GITHUB_TOKEN===marker;',
      'let procCanary=false;',
      'for(const name of fs.readdirSync("/proc").filter(value=>/^\\d+$/.test(value))){',
      '  const file="/proc/"+name+"/environ";',
      '  try{if(fs.readFileSync(file,"utf8").split("\\0").includes("COPILOT_GITHUB_TOKEN="+marker))procCanary=true;}',
      '  catch(error){if(!["EACCES","EPERM","ENOENT","ESRCH"].includes(error.code))throw error;}',
      '}',
      'console.log(JSON.stringify({toolEnvCanary,procCanary}));',
    ].join("\n");
    const command = "node -e " + "'" + script.replaceAll("'", "'\\''") + "'";
    const result = await bounded(() => session.rpc.tools.execute({
      name: "bash", arguments: { command, description: "Synthetic credential visibility and positive write control" },
      toolCallId: "synthetic-credential-boundary",
    }), "Actual offered shell invocation");
    assert.equal(result.resultType, "success", "Positive tool execution must succeed; a denied tool is not isolation proof");
    record.positiveWrite = readFileSync(join(work, "positive-write.txt"), "utf8") === "synthetic-only";
    const text = typeof result === "string" ? result : result.textResultForLlm;
    assert.equal(typeof text, "string");
    const match = text.match(/\{"toolEnvCanary":(?:true|false),"procCanary":(?:true|false)\}/);
    assert.ok(match, "Actual tool result must include both measured visibility booleans");
    Object.assign(record, JSON.parse(match[0]));
  } finally {
    let disconnected = false, stopped = false;
    try {
      if (session) await bounded(() => session.disconnect(), "Session disconnect");
      disconnected = true;
    } finally {
      try {
        if (client) {
          const errors = await bounded(() => client.stop(), "Client shutdown");
          assert.equal(errors?.length ?? 0, 0, "Client shutdown must report no errors");
        }
        stopped = true;
      } finally {
        record.shutdown = disconnected && stopped ? "passed" : "failed";
        console.log("BOUNDARY_RESULT=" + JSON.stringify(record));
      }
    }
  }
  assert.equal(record.positiveWrite, true);
  assert.equal(record.promptMethodsCalled, 0);
  assert.equal(record.modelEvents, 0);
  assert.equal(record.toolEnvCanary, false, "Candidate shell must not receive the runtime credential");
  assert.equal(record.procCanary, false, "Candidate shell must not read the runtime credential through process metadata");
});
