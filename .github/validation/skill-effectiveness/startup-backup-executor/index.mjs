// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

let runtime;
export function registerExecutors(registry) {
  registry.register({
    name: "restricted-copilot-sdk",
    supportsPreparedWorkspace: true,
    supportsMultiTurn: true,
    supportsEnvVars: true,
    validateConfig(config) {
      assert.deepEqual(config, { sessionPolicy: {
        availableTools: [], permissions: { allow: [], deny: ["Shell(*)"] },
      } });
    },
    async execute(stimulus, options) {
      runtime ??= await import("/opt/vally-runtime/startup-backup-hook.mjs");
      return runtime.execute(stimulus, options);
    },
    async shutdown() {
      if (runtime) await runtime.shutdown();
    },
  });
}
