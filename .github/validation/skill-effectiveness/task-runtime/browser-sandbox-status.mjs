// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

export function assertSandboxStatus(status) {
  for (const [label, value] of [
    ["Layer 1 Sandbox", "Namespace"],
    ["PID namespaces", "Yes"],
    ["Network namespaces", "Yes"],
    ["Seccomp-BPF sandbox", "Yes"],
  ]) {
    const rows = status.split(/\r?\n/)
      .filter(line => line.startsWith(label + "\t"))
      .map(line => line.split("\t").map(value => value.trim()));
    assert.equal(rows.length, 1, `Expected one ${label} row`);
    assert.deepEqual(rows[0], [label, value]);
  }
  assert.match(status, /^You are adequately sandboxed\.$/m);
}
