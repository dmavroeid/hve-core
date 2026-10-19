// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
let runtime;
export function registerExecutors(registry) {
  registry.register({
    name: "restricted-copilot-sdk",
    supportsPreparedWorkspace: true,
    supportsMultiTurn: true,
    async execute(stimulus, options) {
      runtime ??= await import("/opt/vally-runtime/same-session-hook.mjs");
      return runtime.execute(stimulus, options);
    },
    async shutdown() { if (runtime) await runtime.shutdown(); },
  });
}
