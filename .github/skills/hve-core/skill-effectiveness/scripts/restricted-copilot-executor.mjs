// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { CopilotClient } from "@github/copilot-sdk";
import { CopilotSdkExecutor } from "@microsoft/vally/executor";

function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} must be an object containing only ${keys.join(", ")}`);
  }
}

function list(value, label, tools = false) {
  if (!Array.isArray(value) || Array.from(value).some(entry => typeof entry !== "string"
    || !entry.trim() || entry !== entry.trim() || (tools && /[*?]/.test(entry)))
    || new Set(value).size !== value.length) {
    throw new Error(`${label} requires distinct nonempty strings${tools ? " without wildcard tool names" : ""}`);
  }
  return Object.freeze([...value]);
}

export function validateSessionPolicy(config) {
  object(config, ["provider", "sessionPolicy"], "executor.config");
  const policy = config.sessionPolicy;
  object(policy, ["availableTools", "permissions"], "sessionPolicy");
  object(policy.permissions, ["allow", "deny"], "sessionPolicy.permissions");
  return Object.freeze({
    availableTools: list(policy.availableTools, "sessionPolicy.availableTools", true),
    permissions: Object.freeze({
      allow: list(policy.permissions.allow, "sessionPolicy.permissions.allow"),
      deny: list(policy.permissions.deny, "sessionPolicy.permissions.deny"),
    }),
  });
}

async function bounded(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out; shutdown is unverified`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function restrictedFactories(context, createClient = options => new CopilotClient(options)) {
  return {
    createClient() {
      throw new Error("restricted-copilot-sdk requires fresh environment-scoped sessions; default clients are unsupported");
    },
    createEnvClient(env, telemetry, onGetTraceContext) {
      const run = context.getStore();
      if (!run) throw new Error("restricted-copilot-sdk client creation requires an active validated execution");
      const { policy, timeoutMs } = run;
      const client = createClient({ env, telemetry, onGetTraceContext });
      const createSession = client.createSession.bind(client);
      client.resumeSession = async () => {
        throw new Error("restricted-copilot-sdk does not support session resume");
      };
      client.createSession = async config => {
        if (config.managedSettings !== undefined || config.availableTools !== undefined) {
          throw new Error("restricted-copilot-sdk rejects conflicting injected session restrictions");
        }
        let session;
        try {
          session = await bounded(() => createSession({
            ...config,
            availableTools: [...policy.availableTools],
            managedSettings: {
              permissions: {
                allow: [...policy.permissions.allow],
                deny: [...policy.permissions.deny],
                disableBypassPermissionsMode: "disable",
              },
            },
            onPermissionRequest: () => ({ kind: "denied-no-approval-rule-and-could-not-request-from-user" }),
          }), timeoutMs, "Restricted session creation");
          await bounded(() => session.rpc.tools.initializeAndValidate(), timeoutMs, "Restricted tool initialization");
          const metadata = await bounded(() => session.rpc.tools.getCurrentMetadata(), timeoutMs, "Restricted tool inventory");
          if (!Array.isArray(metadata?.tools) || metadata.tools.some(tool => typeof tool?.name !== "string")) {
            throw new Error("Restricted tool inventory is unavailable or malformed");
          }
          const actual = metadata.tools.map(tool => tool.name);
          if (actual.length !== policy.availableTools.length || new Set(actual).size !== actual.length
            || actual.some(name => !policy.availableTools.includes(name))) {
            throw new Error("Restricted tool inventory does not match the explicit allowlist; unsupported or unexpected tools");
          }
          return session;
        } catch (error) {
          if (session) {
            try {
              await bounded(() => session.disconnect(), timeoutMs, "Restricted failed-session disconnect");
            } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], "Restricted session preflight and disconnect failed; shutdown is unverified");
            }
          }
          throw error;
        }
      };
      return client;
    },
  };
}

export class RestrictedCopilotExecutor extends CopilotSdkExecutor {
  name = "restricted-copilot-sdk";
  #context;

  constructor() {
    const context = new AsyncLocalStorage();
    super(restrictedFactories(context));
    this.#context = context;
  }

  validateConfig(config) {
    validateSessionPolicy(config);
    super.validateConfig(config.provider === undefined ? {} : { provider: config.provider });
  }

  async execute(stimulus, options) {
    this.validateConfig(options.executorConfig);
    if (options.sessionID !== undefined) throw new Error("restricted-copilot-sdk does not support session resume");
    if (!options.env || typeof options.env !== "object" || Array.isArray(options.env)
      || Object.keys(options.env).length === 0
      || Object.values(options.env).some(value => typeof value !== "string")) {
      throw new Error("restricted-copilot-sdk requires explicit nonempty environment.env");
    }
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
      throw new Error("restricted-copilot-sdk requires a positive finite native timeout");
    }
    const policy = validateSessionPolicy(options.executorConfig);
    const nativeConfig = options.executorConfig.provider === undefined ? {} : { provider: options.executorConfig.provider };
    return this.#context.run({ policy, timeoutMs: Math.min(options.timeout, 10000) },
      () => super.execute(stimulus, { ...options, executorConfig: nativeConfig }));
  }
}

export function registerExecutors(registry) {
  for (const [name, expected] of [
    ["@microsoft/vally", "0.19.0"], ["@github/copilot-sdk", "1.0.15"], ["@github/copilot", "1.0.89"],
  ]) {
    const actual = JSON.parse(readFileSync(findPackageJSON(name, import.meta.url), "utf8")).version;
    if (actual !== expected) {
      throw new Error(`restricted-copilot-sdk requires ${name} ${expected}; installed ${actual}. Complete exact-stack integration before use.`);
    }
  }
  registry.register(new RestrictedCopilotExecutor());
}
