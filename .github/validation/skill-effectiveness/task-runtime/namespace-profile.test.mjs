// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { rendererProfile } from "./namespace-profile.mjs";

test("renderer exception preserves every default property and existing rule", () => {
  const base = {
    defaultAction: "SCMP_ACT_ERRNO",
    architectures: ["SCMP_ARCH_X86_64"],
    syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }],
  };
  const before = structuredClone(base);
  const result = rendererProfile(base);
  assert.deepEqual(base, before);
  assert.deepEqual(result.syscalls.slice(0, -1), before.syscalls);
  assert.deepEqual(result.syscalls.at(-1), {
    names: ["clone", "setns", "unshare", "chroot"], action: "SCMP_ACT_ALLOW", args: [],
  });
  assert.equal(result.syscalls.length, before.syscalls.length + 1);
});

test("permissive or malformed default policies are rejected", () => {
  assert.throws(() => rendererProfile({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [] }));
  assert.throws(() => rendererProfile({ defaultAction: "SCMP_ACT_ERRNO" }));
});
