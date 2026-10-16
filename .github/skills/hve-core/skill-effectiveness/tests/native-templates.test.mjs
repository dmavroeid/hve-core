// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findPackageJSON } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { applyEnvironment, gradeInDisposableWorkspace, hasGraderError, PromptGrader, RunCommandGrader, resolveGradePass } from "@microsoft/vally";
import { CopilotSdkExecutor } from "@microsoft/vally/executor";
import { CopilotClient } from "@github/copilot-sdk";
import { installInventoryCapture } from "../scripts/native-inventory.mjs";
import { RestrictedCopilotExecutor, registerExecutors, restrictedFactories, validateSessionPolicy } from "../scripts/restricted-copilot-executor.mjs";

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(runtime, "assets");
const read = name => readFileSync(join(assets, name), "utf8");
const fill = text => text.replace(/<[^>\r\n]+>/g, value => ({
  "<task>": "task", "<task-name>": "task", "<candidate-skill>": "demo",
  "<artifact>": "result.txt", "<experiment-name>": "baseline-first",
})[value] ?? "example");

function fixture(t) {
  const temporary = mkdtempSync(join(runtime, ".native-package-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, "package with spaces");
  const write = (name, text) => {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  write("package.json", fill(read("package.template.json")));
  symlinkSync(join(runtime, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(runtime, "scripts", "native-inventory.mjs"), join(root, "scripts", "native-inventory.mjs"));
  copyFileSync(join(runtime, "scripts", "review-images.mjs"), join(root, "scripts", "review-images.mjs"));
  copyFileSync(join(runtime, "scripts", "restricted-copilot-executor.mjs"), join(root, "scripts", "restricted-copilot-executor.mjs"));
  write("skills/demo/SKILL.md", "---\nname: demo\ndescription: Local fixture.\n---\nCheck your work.\n");
  write("fixtures/task/public/request.txt", "Create deliverable/result.txt. Synthetic test input.");
  write("grading/task/check.mjs", `import { readFileSync } from "node:fs";
if (!readFileSync(process.argv[2], "utf8").trim()) process.exit(1);`);
  const spec = parse(fill(read("native-eval.template.yaml")));
  const review = parse(fill(read("native-review-eval.template.yaml")));
  const experiment = parse(fill(read("native-experiment.template.yaml")));
  write("evals/task.eval.yaml", stringify(spec));
  write("evals/task.review.eval.yaml", stringify(review));
  write("experiments/task.experiment.yaml", stringify(experiment));
  const environment = { ...process.env, DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" };
  for (const key of ["NODE_OPTIONS", "SKILL_EVAL_INVENTORY_DIR", "SKILL_EVAL_INVENTORY_PACKAGE",
    "EVALUATE_USE_HOST_COPILOT_HOME", "COPILOT_HOME_SETTINGS_JSON", "NODE_TEST_CONTEXT"]) delete environment[key];
  const run = (args, env = {}) => {
    const child = spawnSync(process.execPath, args, {
      cwd: root, env: { ...environment, ...env }, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(child.error);
    return child;
  };
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const script = (name, args, env) => {
    const [node, ...command] = scripts[name].split(" ");
    assert.equal(node, "node");
    return run([...command, ...args], env);
  };
  return { root, temporary, write, spec, review, experiment, run, script };
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

test("copied native templates lint and dry-run both role orders without capture or model calls", { timeout: 90000 }, t => {
  const f = fixture(t);
  const lint = f.script("vally", ["lint", "--strict", "--eval-spec", "evals/task.eval.yaml"]);
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  assert.deepEqual(f.spec.stimuli[0].graders.map(grader => grader.type),
    ["completed", "file-exists", "run-command"]);
  const reviewLint = f.script("vally", ["lint", "--strict", "--eval-spec", "evals/task.review.eval.yaml"]);
  assert.equal(reviewLint.status, 0, reviewLint.stdout + reviewLint.stderr);
  assert.deepEqual(f.review.stimuli[0].graders[0].config.evidence, ["repo"]);
  assert.deepEqual(f.experiment.vary, ["/environment/skills"]);
  assert.deepEqual(f.experiment.variants["a-baseline"].environment.skills, []);
  assert.deepEqual(f.experiment.variants["b-treatment"].environment.skills, ["../skills/demo"]);
  const reversed = { ...f.experiment, name: "treatment-first", baseline: "b-baseline", variants: {
    "a-treatment": f.experiment.variants["b-treatment"], "b-baseline": f.experiment.variants["a-baseline"],
  } };
  for (const experiment of [f.experiment, reversed]) {
    f.write("experiments/task.experiment.yaml", stringify(experiment));
    const output = join(f.temporary, experiment.name);
    const result = f.script("study:dry-run", ["experiments/task.experiment.yaml", "--param", "AGENT_MODEL=mock",
      "--output-dir", output, "--workspace", join(f.temporary, "workspaces", experiment.name)]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(experiment.name));
  }
  assert.equal(existsSync(join(f.root, "inventories")), false);
  assert.equal(existsSync(join(f.root, "RESULTS.md")), false);
});

test("native staging templates separate public inputs, offline checkers and saved review evidence", () => {
  const candidate = parse(fill(read("native-eval.template.yaml")));
  const review = parse(fill(read("native-review-eval.template.yaml")));
  assert.deepEqual(candidate.agent_environment.files, [{ src: "../fixtures/task/public", dest: "task-fixture" }]);
  assert.deepEqual(candidate.grading_environment.files, [{ src: "../grading/task", dest: "evaluator" }]);
  assert.deepEqual(candidate.stimuli[0].graders.map(grader => grader.type), ["completed", "file-exists", "run-command"]);
  assert.deepEqual(candidate.stimuli[0].graders.at(-1).config.args, ["evaluator/check.mjs", "deliverable/result.txt"]);
  assert.match(candidate.stimuli[0].prompt, /private evaluator is unavailable/);
  assert.doesNotMatch(candidate.stimuli[0].prompt, /check\.mjs|Public checks run:/);
  assert.equal(candidate.defaults.judge_model, undefined);
  assert.equal(candidate.defaults.judge_provider, undefined);
  assert.equal(candidate.stimuli[0].rubric, undefined);
  assert.equal(review.name, candidate.name);
  assert.equal(review.stimuli[0].name, candidate.stimuli[0].name);
  assert.deepEqual(review.stimuli[0].graders.map(grader => grader.type), ["prompt"]);
  assert.deepEqual(review.stimuli[0].graders[0].config.evidence, ["repo"]);
  for (const key of ["agent_environment", "grading_environment", "executor_plugins"]) assert.equal(review[key], undefined);
  assert.equal(review.defaults.executor, undefined);
});

test("native staging specs pass available CLI lint and mock experiment dry-run without SDK startup", { timeout: 180000 }, t => {
  const f = fixture(t);
  const cli = join(dirname(findPackageJSON("@microsoft/vally-cli", import.meta.url)), "dist", "index.js");
  for (const spec of ["evals/task.eval.yaml", "evals/task.review.eval.yaml"]) {
    const result = f.run([cli, "lint", "--strict", "--eval-spec", spec]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  f.spec.defaults.executor = "mock";
  delete f.experiment.executor_plugins;
  f.write("evals/task.eval.yaml", stringify(f.spec));
  const reversed = { ...f.experiment, name: "treatment-first", baseline: "b-baseline", variants: {
    "a-treatment": f.experiment.variants["b-treatment"], "b-baseline": f.experiment.variants["a-baseline"],
  } };
  for (const experiment of [f.experiment, reversed]) {
    f.write("experiments/task.experiment.yaml", stringify(experiment));
    const result = f.run([cli, "experiment", "run", "--dry-run", "experiments/task.experiment.yaml",
      "--param", "AGENT_MODEL=mock", "--output-dir", join(f.temporary, experiment.name)]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const variant of Object.keys(experiment.variants)) assert.ok(result.stdout.includes(variant));
  }
});

test("native saved grading replaces candidate checkers and preserves both arms and complete skills", async t => {
  const f = fixture(t);
  const input = readFileSync(join(f.root, "fixtures", "task", "public", "request.txt"), "utf8");
  const expected = readFileSync(join(f.root, "grading", "task", "check.mjs"), "utf8");
  const publicTool = "export const validate = value => value !== undefined;\n";
  f.write("skills/demo/validate.mjs", publicTool);
  f.write("EVALS.md", "Evaluator-only notes.");
  f.write("review-inputs/review.txt", "Reviewer-only input.");
  for (const [variant, environment] of Object.entries(f.experiment.variants)) {
    const submission = join(f.root, "submissions", variant);
    mkdirSync(submission, { recursive: true });
    await applyEnvironment({ ...f.spec.agent_environment, ...environment.environment },
      submission, join(f.root, "experiments"));
    for (const path of ["evaluator", "grading", "review-inputs", "EVALS.md", "scripts"]) {
      assert.equal(existsSync(join(submission, path)), false, `${variant}: ${path} must not be staged`);
    }
    assert.equal(readFileSync(join(submission, "task-fixture", "request.txt"), "utf8"), input);
    const skill = join(submission, "demo");
    assert.equal(existsSync(skill), variant === "b-treatment");
    if (existsSync(skill)) {
      assert.equal(readFileSync(join(skill, "SKILL.md"), "utf8"),
        readFileSync(join(f.root, "skills", "demo", "SKILL.md"), "utf8"));
      assert.equal(readFileSync(join(skill, "validate.mjs"), "utf8"), publicTool);
    }
    const substitute = 'throw new Error("Candidate substitute must not execute");';
    f.write(`submissions/${variant}/evaluator/check.mjs`, substitute);
    f.write(`submissions/${variant}/deliverable/result.txt`, "Valid synthetic output.");
    const result = await gradeInDisposableWorkspace({
      trajectory: { workDir: submission },
      graderFiles: f.spec.grading_environment.files,
      baseDir: join(f.root, "evals"),
      grade: async trajectory => {
        assert.notEqual(trajectory.workDir, submission);
        assert.equal(readFileSync(join(trajectory.workDir, "evaluator", "check.mjs"), "utf8"), expected);
        const grade = await new RunCommandGrader().grade({ trajectory,
          config: { ...f.spec.stimuli[0].graders.at(-1).config, command: process.execPath } });
        return { workDir: trajectory.workDir, grade };
      },
    });
    assert.equal(result.grade.passed, true, JSON.stringify(result.grade));
    assert.equal(existsSync(result.workDir), false);
    assert.equal(readFileSync(join(submission, "evaluator", "check.mjs"), "utf8"), substitute);
    assert.equal(readFileSync(join(submission, "task-fixture", "request.txt"), "utf8"), input);
  }
});

test("native staging fails explicitly for missing public inputs and trusted checker sources", async t => {
  const f = fixture(t);
  const submission = join(f.root, "submission");
  mkdirSync(submission);
  await assert.rejects(applyEnvironment({
    files: [{ src: "../fixtures/missing", dest: "task-fixture" }],
  }, submission, join(f.root, "evals")), /ENOENT|not found|does not exist/);
  mkdirSync(submission, { recursive: true });
  const substitute = 'throw new Error("Missing trusted source must not fall back to this file");';
  f.write("submission/evaluator/check.mjs", substitute);
  let invoked = false;
  await assert.rejects(gradeInDisposableWorkspace({
    trajectory: { workDir: submission },
    graderFiles: [{ src: "../grading/missing", dest: "evaluator" }],
    baseDir: join(f.root, "evals"),
    grade: async () => { invoked = true; },
  }), /ENOENT|not found|does not exist/);
  assert.equal(invoked, false, "missing trusted checker must stop before grading");
  assert.equal(readFileSync(join(submission, "evaluator", "check.mjs"), "utf8"), substitute);
});

test("native saved grading distinguishes valid alternatives, wrong output and checker startup errors", async t => {
  const f = fixture(t);
  f.write("grading/task/check.mjs", `import { readFileSync } from "node:fs";
const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (result.answer !== 42) process.exit(1);`);
  for (const [name, output, passed, startupError] of [
    ["valid", { answer: 42 }, true, false],
    ["alternative", { explanation: "A valid alternative representation.", answer: 42 }, true, false],
    ["wrong", { answer: 7 }, false, false],
    ["missing-output", undefined, false, false],
    ["checker-startup", { answer: 42 }, false, true],
  ]) {
    await t.test(name, async () => {
      const submission = join(f.root, "submissions", name);
      mkdirSync(submission, { recursive: true });
      if (output !== undefined) f.write(`submissions/${name}/deliverable/result.txt`, JSON.stringify(output));
      const grade = await gradeInDisposableWorkspace({
        trajectory: { workDir: submission },
        graderFiles: f.spec.grading_environment.files,
        baseDir: join(f.root, "evals"),
        grade: trajectory => new RunCommandGrader().grade({ trajectory, config: {
          ...f.spec.stimuli[0].graders.at(-1).config,
          command: startupError ? join(f.temporary, "missing-interpreter") : process.execPath,
        } }),
      });
      assert.equal(grade.passed, passed, JSON.stringify(grade));
      assert.equal(hasGraderError(grade), startupError, JSON.stringify(grade));
      if (startupError) {
        assert.match(JSON.stringify(grade), /ENOENT|not found|spawn/i);
      } else {
        if (name === "wrong") assert.equal(grade.score, 0);
        if (name === "missing-output") assert.match(JSON.stringify(grade), /ENOENT/);
      }
    });
  }
});

const policyConfig = (tools = []) => ({
  sessionPolicy: { availableTools: tools, permissions: { allow: [], deny: [] } },
});

test("restricted policy requires an exact explicit configuration and immutable lists", () => {
  const original = policyConfig();
  const policy = validateSessionPolicy(original);
  assert.deepEqual(policy, original.sessionPolicy);
  assert.notEqual(policy, original.sessionPolicy);
  assert.throws(() => policy.availableTools.push("shell"), TypeError);
  assert.throws(() => policy.permissions.allow.push("Shell(*)"), TypeError);
  const malformed = [undefined, null, [], {}, { ...original, extra: true },
    { sessionPolicy: {} },
    { sessionPolicy: { availableTools: [], permissions: { allow: [] } } },
    { sessionPolicy: { ...original.sessionPolicy, extra: [] } },
    { sessionPolicy: { ...original.sessionPolicy, permissions: { allow: [], deny: [], extra: [] } } }];
  for (const value of malformed) assert.throws(() => validateSessionPolicy(value));
  for (const value of [undefined, null, "", {}, [""], [" "], [" view"], [1], ["view", "view"], ["*"], ["view?"]]) {
    const config = policyConfig();
    config.sessionPolicy.availableTools = value;
    assert.throws(() => validateSessionPolicy(config));
  }
  for (const key of ["allow", "deny"]) {
    for (const value of [undefined, {}, [""], [false], ["Read(x)", "Read(x)"]]) {
      const config = policyConfig();
      config.sessionPolicy.permissions[key] = value;
      assert.throws(() => validateSessionPolicy(config));
    }
  }
  assert.deepEqual(original, policyConfig());
});

test("restricted executor rejects missing policy, invalid providers, default mode and resume without SDK startup", async () => {
  const executor = new RestrictedCopilotExecutor();
  const stimulus = { name: "unit", prompt: "Never send this prompt." };
  const options = { executorConfig: policyConfig(), timeout: 1000 };
  await assert.rejects(executor.execute(stimulus, { ...options, executorConfig: {} }), /sessionPolicy/);
  assert.throws(() => executor.validateConfig({ ...policyConfig(), provider: { invalid: true } }));
  for (const env of [undefined, {}, [], { FLAG: 1 }]) {
    await assert.rejects(executor.execute(stimulus, { ...options, env }), /environment\.env/);
  }
  for (const sessionID of ["prior-session", ""]) {
    await assert.rejects(executor.execute(stimulus, { ...options, env: { FLAG: "1" }, sessionID }), /resume/);
  }
  for (const timeout of [0, -1, Infinity, NaN]) {
    await assert.rejects(executor.execute(stimulus, { ...options, env: { FLAG: "1" }, timeout }), /timeout/);
  }
});

test("restricted execution delegates native options and results unchanged except adapter configuration", async t => {
  const executor = new RestrictedCopilotExecutor();
  const stimulus = Object.freeze({ name: "unit", prompt: "No model call." });
  const options = Object.freeze({
    env: Object.freeze({ DO_NOT_TRACK: "1" }), timeout: 1000,
    executorConfig: Object.freeze(policyConfig()),
    model: "synthetic", cwd: "native-owned-workspace",
  });
  const result = Object.freeze({ output: "native result" });
  const delegated = t.mock.method(CopilotSdkExecutor.prototype, "execute", async (input, nativeOptions) => {
    assert.equal(input, stimulus);
    assert.deepEqual(nativeOptions, { ...options, executorConfig: {} });
    assert.equal(nativeOptions.env, options.env);
    return result;
  });
  assert.equal(await executor.execute(stimulus, options), result);
  assert.equal(delegated.mock.callCount(), 1);
  assert.deepEqual(options.executorConfig, policyConfig());
  const failure = new Error("native execution failed");
  delegated.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(executor.execute(stimulus, options), error => error === failure);
});

test("restricted factories forward native environment and hooks and deny every host request on replacement clients", async () => {
  const context = new AsyncLocalStorage();
  const config = policyConfig(["view"]);
  config.sessionPolicy.permissions = { allow: ["Read(approved/**)"], deny: ["Shell(*)"] };
  const original = structuredClone(config);
  const creations = [];
  const sessions = [];
  let approvals = 0;
  const factories = restrictedFactories(context, options => {
    creations.push(options);
    return {
      createSession: async options => {
        sessions.push(options);
        return { rpc: { tools: {
          initializeAndValidate: async () => {},
          getCurrentMetadata: async () => ({ tools: options.availableTools.map(name => ({ name })) }),
        } } };
      },
      stop: async () => "native cleanup",
    };
  });
  assert.throws(() => factories.createClient(), /default clients/);
  assert.throws(() => factories.createEnvClient({}), /active validated execution/);
  const env = Object.freeze({ COPILOT_HOME: "native-owned-home", FLAG: "1" });
  const telemetry = Object.freeze({ otlpEndpoint: "synthetic" });
  const trace = () => ({ traceparent: "synthetic" });
  const input = Object.freeze({ sessionId: "fresh", onPermissionRequest: () => { approvals++; } });
  const run = { policy: validateSessionPolicy(config), timeoutMs: 1000 };
  for (let replacement = 0; replacement < 2; replacement++) {
    const client = context.run(run, () => factories.createEnvClient(env, telemetry, trace));
    await client.createSession(input);
    await assert.rejects(client.resumeSession("old"), /resume/);
    await assert.rejects(client.createSession({ managedSettings: {} }), /conflicting/);
    await assert.rejects(client.createSession({ availableTools: [] }), /conflicting/);
    assert.equal(await client.stop(), "native cleanup");
  }
  assert.equal(creations.length, 2);
  for (const options of creations) {
    assert.equal(options.env, env);
    assert.equal(options.telemetry, telemetry);
    assert.equal(options.onGetTraceContext, trace);
  }
  for (const options of sessions) {
    assert.equal(options.sessionId, "fresh");
    assert.deepEqual(options.availableTools, ["view"]);
    assert.deepEqual(options.managedSettings.permissions, {
      allow: ["Read(approved/**)"], deny: ["Shell(*)"], disableBypassPermissionsMode: "disable",
    });
    for (const kind of ["read", "write", "shell", "url", "mcp", "custom-tool", "future-kind"]) {
      assert.deepEqual(await options.onPermissionRequest({ kind }), {
        kind: "denied-no-approval-rule-and-could-not-request-from-user",
      });
    }
    options.availableTools.push("unexpected-mutation");
    options.managedSettings.permissions.allow.push("unexpected-mutation");
  }
  assert.equal(approvals, 0);
  assert.deepEqual(config, original);
  assert.deepEqual(run.policy.availableTools, ["view"]);
  assert.deepEqual(run.policy.permissions.allow, ["Read(approved/**)"]);
});

test("restricted concurrent factories capture their own policy, including an empty explicit tool set", async () => {
  const context = new AsyncLocalStorage();
  const received = [];
  const factories = restrictedFactories(context, () => ({
    createSession: async config => {
      await new Promise(resolve => setImmediate(resolve));
      received.push(config);
      return { rpc: { tools: {
        initializeAndValidate: async () => {},
        getCurrentMetadata: async () => ({ tools: config.availableTools.map(name => ({ name })) }),
      } } };
    },
  }));
  await Promise.all([[], ["view"], ["edit"]].map(async (tools, index) => {
    const client = await context.run({ policy: validateSessionPolicy(policyConfig(tools)), timeoutMs: 1000 }, async () => {
      await new Promise(resolve => setImmediate(resolve));
      return factories.createEnvClient({ RUN: `${index}` });
    });
    await client.createSession({ sessionId: `${index}` });
  }));
  for (const [index, tools] of [[], ["view"], ["edit"]].entries()) {
    assert.deepEqual(received.find(config => config.sessionId === `${index}`).availableTools, tools);
  }
});

test("restricted policy and diagnostic inventory capture compose before returning a session", async t => {
  const root = mkdtempSync(join(runtime, ".native-package-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = new AsyncLocalStorage();
  const calls = [];
  const session = {
    sessionId: "policy-and-inventory",
    rpc: {
      tools: {
        initializeAndValidate: async () => { calls.push("initialize"); },
        getCurrentMetadata: async () => ({ tools: [{ name: "view" }] }),
      },
      skills: { list: async () => { calls.push("skills"); return { skills: [{ name: "ambient", enabled: true }] }; } },
    },
    disconnect: async () => { throw new Error("unexpected disconnect"); },
  };
  let received;
  t.mock.method(CopilotClient.prototype, "createSession", async config => {
    received = config;
    return session;
  });
  const restore = await installInventoryCapture(runtime, root);
  try {
    const factories = restrictedFactories(context, () => Object.create(CopilotClient.prototype));
    const client = context.run({ policy: validateSessionPolicy(policyConfig(["view"])), timeoutMs: 1000 },
      () => factories.createEnvClient({ DO_NOT_TRACK: "1" }));
    const input = Object.freeze({ workingDirectory: "native-workspace", skillDirectories: Object.freeze([]) });
    assert.equal(await client.createSession(input), session);
    assert.deepEqual(received.availableTools, ["view"]);
    assert.equal(received.managedSettings.permissions.disableBypassPermissionsMode, "disable");
    assert.equal(received.onPermissionRequest({ kind: "shell" }).kind,
      "denied-no-approval-rule-and-could-not-request-from-user");
    assert.equal(input.availableTools, undefined);
    assert.deepEqual(calls, ["initialize", "skills", "initialize"]);
    const record = JSON.parse(readFileSync(join(root, `${session.sessionId}.json`), "utf8"));
    assert.equal(record.phase, "before-first-prompt");
    assert.deepEqual(record.skillDetails.skills, [{ name: "ambient", enabled: true }]);
    await assert.rejects(client.resumeSession("old"), /resume/);
  } finally {
    restore();
  }
});

test("restricted preflight rejects unsupported, unexpected and unavailable tool inventories before returning a session", async () => {
  const context = new AsyncLocalStorage();
  for (const tools of [null, undefined, [], [{ name: "shell" }], [{ name: "view" }, { name: "view" }], [{}]]) {
    let disconnected = 0;
    const factories = restrictedFactories(context, () => ({
      createSession: async () => ({
        rpc: { tools: {
          initializeAndValidate: async () => {},
          getCurrentMetadata: async () => ({ tools }),
        } },
        disconnect: async () => { disconnected++; },
      }),
    }));
    const client = context.run({ policy: validateSessionPolicy(policyConfig(["view"])), timeoutMs: 1000 },
      () => factories.createEnvClient({ FLAG: "1" }));
    await assert.rejects(client.createSession({}), /inventory/);
    assert.equal(disconnected, 1);
  }
});

test("restricted startup exceptions and hung RPC or cleanup remain bounded and preserve both errors", { timeout: 3000 }, async () => {
  const context = new AsyncLocalStorage();
  const failure = new Error("native managed-rule validation failed");
  for (const stage of ["creation", "creation-hang", "initialization", "inventory", "disconnect"]) {
    const factories = restrictedFactories(context, () => ({
      createSession: async () => {
        if (stage === "creation") throw failure;
        if (stage === "creation-hang") return new Promise(() => {});
        return {
          rpc: { tools: {
            initializeAndValidate: async () => {
              if (stage === "initialization") return new Promise(() => {});
              if (stage === "disconnect") throw failure;
            },
            getCurrentMetadata: async () => new Promise(() => {}),
          } },
          disconnect: async () => {
            if (stage === "disconnect") return new Promise(() => {});
          },
        };
      },
    }));
    const client = context.run({ policy: validateSessionPolicy(policyConfig()), timeoutMs: 15 },
      () => factories.createEnvClient({ FLAG: "1" }));
    await assert.rejects(client.createSession({}), error => {
      if (stage === "creation") assert.equal(error, failure);
      else if (stage === "disconnect") {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], failure);
        assert.match(error.errors[1].message, /disconnect timed out.*shutdown is unverified/);
      } else assert.match(error.message, /timed out.*shutdown is unverified/);
      return true;
    });
  }
});

test("restricted registration checks the exact target stack without starting an SDK client", () => {
  const actual = JSON.parse(readFileSync(findPackageJSON("@microsoft/vally", import.meta.url), "utf8"));
  if (actual.version === "0.19.0") {
    const registered = [];
    registerExecutors({ register: executor => registered.push(executor) });
    assert.equal(registered[0].name, "restricted-copilot-sdk");
  } else {
    assert.throws(() => registerExecutors({ register: () => assert.fail("incompatible stack registered") }),
      /requires @microsoft\/vally 0\.19\.0/);
  }
});

test("native execution preload requires an absolute evidence directory and preserves CLI errors", t => {
  const f = fixture(t);
  for (const directory of [undefined, "relative-evidence"]) {
    const result = f.script("study:run", ["--help"], directory ? { SKILL_EVAL_INVENTORY_DIR: directory } : {});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SKILL_EVAL_INVENTORY_DIR must be an absolute evidence directory/);
  }
  const inventories = join(f.temporary, "inventories");
  const invalid = f.script("study:run", ["--not-a-native-option"], { SKILL_EVAL_INVENTORY_DIR: inventories });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown option/i);
  assert.deepEqual(readdirSync(inventories), []);
  const copilot = JSON.parse(readFileSync(join(runtime, "node_modules", "@github", "copilot", "package.json"), "utf8"));
  assert.equal(copilot.optionalDependencies[`@github/copilot-${process.platform}-${process.arch}`], "1.0.89");
});

test("copied Node preload captures the session before returning it without a launcher", t => {
  const f = fixture(t);
  const prime = f.write("prime-sdk.mjs", `
import { CopilotClient } from "@github/copilot-sdk";
CopilotClient.prototype.createSession = async config => ({
  sessionId: config.sessionId,
  rpc: {
    tools: { initializeAndValidate: async () => {} },
    skills: { list: async () => ({ skills: [{ name: "ambient", enabled: true, path: "fixture/SKILL.md" }] }) }
  }
});
`);
  const inventories = join(f.temporary, "inventories");
  const result = f.run(["--import", pathToFileURL(prime).href, "--import=./scripts/native-inventory.mjs", "--input-type=module", "-e",
    `import assert from "node:assert/strict";
     import { CopilotClient } from "@github/copilot-sdk";
     assert.equal(process.env.SKILL_EVAL_INVENTORY_DIR, undefined);
     await CopilotClient.prototype.createSession.call({}, {sessionId: "copied-session", enableConfigDiscovery: true});`],
  { SKILL_EVAL_INVENTORY_DIR: inventories });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.includes(inventories), false);
  const record = JSON.parse(readFileSync(join(inventories, "copied-session.json"), "utf8"));
  assert.equal(record.sessionId, "copied-session");
  assert.equal(record.enableConfigDiscovery, true);
  assert.deepEqual(record.skillDetails.skills, [{ name: "ambient", enabled: true, path: "fixture/SKILL.md" }]);
});

test("native mock runs preserve identities, task failures and operational errors without a converter", { timeout: 120000 }, t => {
  const f = fixture(t);
  f.spec.defaults.executor = "mock";
  f.experiment.overrides.runs = 2;
  f.write("experiments/task.experiment.yaml", stringify(f.experiment));
  f.spec.agent_environment.files.push({ src: "../fixtures/mock", dest: "." });
  const successful = f.spec.stimuli[0];
  const zero = { type: "run-command", config: { command: process.execPath, args: ["-e", "process.exit(1)"], timeout: "10s" } };
  const emptyError = { type: "program", config: { program: process.execPath, args: ["-e",
    `console.log(JSON.stringify({name:"unavailable",kind:"code",status:"error",passed:false,score:0,evidence:""}))`], timeout: "10s" } };
  const missingChecker = { type: "program", config: { program: join(f.temporary, "missing-runtime.exe"), timeout: "10s" } };
  f.spec.stimuli.push(...[
    ["measured-zero", zero], ["empty-error", emptyError], ["missing-checker", missingChecker],
    ["missing-output", { type: "file-exists", config: { path: "deliverable/missing.txt" } }],
  ].map(([name, grader]) => ({ name, prompt: "Synthetic outcome, no model call.", graders: [grader] })));
  for (const stimulus of f.spec.stimuli) {
    f.write(`fixtures/mock/.mock-executor/${stimulus.name}.json`, JSON.stringify({
      output: "Synthetic result.", events: [{ type: "turn_end", data: {}, timestamp: new Date().toISOString() }],
    }));
  }
  f.write("fixtures/mock/deliverable/result.txt", "Synthetic output staged for native delivery checks.");
  f.write("evals/task.eval.yaml", stringify(f.spec));
  const execute = (name, expectedExit) => {
    const output = join(f.temporary, name);
    const result = f.script("study:run", ["experiments/task.experiment.yaml", "--param", "AGENT_MODEL=mock",
      "--output-dir", output, "--workspace", join(f.temporary, "workspaces", name), "--workers", "1"],
    { SKILL_EVAL_INVENTORY_DIR: join(f.temporary, "inventories", name) });
    assert.equal(result.status, expectedExit, result.stdout + result.stderr);
    const outputs = files(output);
    assert.ok(outputs.some(file => file.endsWith("report.md")));
    return outputs.filter(file => file.endsWith(".jsonl")).flatMap(file =>
      readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
        .filter(record => record.type === "trial-result"));
  };
  const records = execute("baseline-first", 1);
  assert.equal(records.length, 20);
  assert.equal(new Set(records.map(record => record.shardKey)).size, 20);
  for (const record of records) {
    assert.ok([0, 1].includes(record.trialIndex));
    assert.ok(["a-baseline", "b-treatment"].includes(record.variant));
    if (record.stimulus === "task") {
      assert.equal(record.gradeResult.passed, true);
      assert.equal(record.trajectory.output, "Synthetic result.");
      continue;
    }
    const detail = record.gradeResult.details[0];
    assert.equal(detail.passed, false);
    if (["empty-error", "missing-checker"].includes(record.stimulus)) {
      assert.equal(detail.status, "error");
      assert.equal(record.gradeResult.status, "error");
      if (record.stimulus === "empty-error") assert.equal(detail.evidence, "");
    } else {
      assert.notEqual(detail.status, "error");
      assert.equal(detail.score, 0);
    }
  }
  assert.deepEqual(records.filter(record => record.stimulus === "task").map(record => record.variant),
    ["a-baseline", "a-baseline", "b-treatment", "b-treatment"]);
  for (const variant of ["a-baseline", "b-treatment"]) {
    assert.deepEqual(records.filter(record => record.stimulus === "task" && record.variant === variant)
      .map(record => record.trialIndex).sort(), [0, 1]);
  }
  f.spec.stimuli = [successful];
  f.write("evals/task.eval.yaml", stringify(f.spec));
  f.experiment.name = "treatment-first";
  f.experiment.overrides.runs = 1;
  f.experiment.baseline = "b-baseline";
  f.experiment.variants = {
    "a-treatment": f.experiment.variants["b-treatment"], "b-baseline": f.experiment.variants["a-baseline"],
  };
  f.write("experiments/task.experiment.yaml", stringify(f.experiment));
  const reversed = execute("treatment-first", 0);
  assert.equal(reversed.length, 2);
  assert.deepEqual(reversed.map(record => record.variant), ["a-treatment", "b-baseline"]);
  assert.ok(reversed.every(record => record.trialIndex === undefined && typeof record.shardKey === "string"));
  assert.ok(reversed.every(record => record.experiment.baseline === "b-baseline"));
});

test("native code and prompt graders retain separate outcomes and supply actual artifact evidence", async t => {
  const f = fixture(t);
  const stimulus = f.review.stimuli[0];
  const semantic = stimulus.graders[0];
  f.write("review-inputs/source.txt", "The required answer is 42; prose or a table is acceptable.");
  f.write("grading/task/review-excluded.txt", "PRIVATE-EVALUATOR-MARKER");
  f.write("EVALS.md", "EVALUATOR-NOTES-MARKER");
  f.write("check.mjs", `import { readFileSync } from "node:fs";
if (!readFileSync("deliverable/result.txt", "utf8").includes("42")) process.exit(1);`);
  let calls = 0;
  const judge = new PromptGrader({
    supportsWorkspaceDelivery: true,
    async judge(options) {
      calls++;
      assert.match(options.userMessage, /example/);
      const evidence = options.workspace.evidenceFiles.map(path => readFileSync(path, "utf8")).join("\n");
      assert.match(evidence, /The required answer is 42/);
      assert.match(evidence, /deliverable\/result.txt/);
      assert.doesNotMatch(evidence, /PRIVATE-EVALUATOR-MARKER|EVALUATOR-NOTES-MARKER|check\.mjs/);
      const score = evidence.includes("UNSUPPORTED CONCLUSION") ? 1
        : evidence.includes("LIMITED EXPLANATION") ? 3 : 5;
      return { args: { overall_score: score, overall_reasoning: "Synthetic judge response for wiring only.",
        rubric_scores: stimulus.rubric.map(criterion => ({ criterion, score, reasoning: "Mock assessment." })) },
        latencyMs: 1 };
    },
  });
  for (const [output, codePass, judgePass] of [
    ["The answer is 42.", true, true], ["| Answer | 42 |", true, true],
    ["The answer is 42. LIMITED EXPLANATION", true, true],
    ["The answer is 42. UNSUPPORTED CONCLUSION", true, false],
    ["The answer is 7.", false, true],
  ]) {
    f.write("deliverable/result.txt", output);
    f.write("review-inputs/deliverable/result.txt", output);
    const trajectory = { workDir: f.root, output: "Do not grade only this final message.", events: [], metrics: {} };
    const code = await new RunCommandGrader().grade({ trajectory,
      config: { command: process.execPath, args: ["check.mjs"], expected_exit_code: 0, timeout: "10s" } });
    const review = await judge.grade({
      trajectory: { ...trajectory, workDir: join(f.root, "review-inputs") },
      stimulus, config: { ...semantic.config, model: "mock" },
    });
    assert.equal(code.passed, codePass);
    assert.equal(review.passed, judgePass);
    assert.equal(code.kind, "code");
    assert.equal(review.kind, "llm");
    const combined = { score: (2 + code.score + review.score) / 4, passed: code.passed && review.passed };
    assert.equal(f.spec.scoring.threshold, undefined);
    assert.equal(resolveGradePass(combined, f.spec.scoring.threshold), codePass && judgePass);
  }
  const missing = await judge.grade({
    trajectory: { workDir: join(f.root, "missing"), events: [], metrics: {} },
    stimulus, config: { ...semantic.config, model: "mock" },
  });
  assert.equal(missing.status, "error");
  assert.equal(calls, 5, "missing evidence must not call the judge");
});
