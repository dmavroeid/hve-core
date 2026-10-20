// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { assertSandboxStatus } from "./browser-sandbox-status.mjs";

const captured = [
  "Sandbox Status",
  "Layer 1 Sandbox\tNamespace",
  "PID namespaces\tYes",
  "Network namespaces\tYes",
  "Seccomp-BPF sandbox\tYes",
  "Seccomp-BPF sandbox supports TSYNC\tYes",
  "Ptrace Protection with Yama LSM (Broker)\tYes",
  "Ptrace Protection with Yama LSM (Non-broker)\tNo",
  "",
  "You are adequately sandboxed.",
].join("\n");

test("accepts the captured Chrome 155 namespace status layout", () => {
  assertSandboxStatus(captured);
});

test("rejects disabled layers despite a reassuring footer", () => {
  for (const row of [
    "Layer 1 Sandbox\tNamespace",
    "PID namespaces\tYes",
    "Network namespaces\tYes",
    "Seccomp-BPF sandbox\tYes",
  ]) {
    assert.throws(() => assertSandboxStatus(captured.replace(row, row.split("\t")[0] + "\tNo")));
  }
  assert.throws(() => assertSandboxStatus("You are adequately sandboxed."));
});

test("rejects absent, duplicate or contradictory sandbox status rows", () => {
  assert.throws(() => assertSandboxStatus(captured.replace("PID namespaces\tYes", "")));
  assert.throws(() => assertSandboxStatus(captured + "\nPID namespaces\tYes"));
  assert.throws(() => assertSandboxStatus(captured + "\nSeccomp-BPF sandbox\tNo"));
});
