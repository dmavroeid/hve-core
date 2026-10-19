// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const arm = process.argv[2];
assert.ok(["baseline", "treatment"].includes(arm));
const messages = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const receive = async type => {
  const { value, done } = await messages.next();
  assert.equal(done, false);
  const message = JSON.parse(value);
  assert.equal(message.type, type);
  return message;
};
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const capture = JSON.parse(readFileSync("/tmp/same-session-ready.json", "utf8"));
emit({ type: "capture", arm, ...capture });
const release = await receive("release");
assert.equal(release.sessionId, capture.actualSessionId);
writeFileSync("/tmp/same-session-release.json", JSON.stringify(release), { flag: "wx" });
const deadline = Date.now() + 6000;
while (!existsSync("/tmp/same-session-stopped.json")) {
  assert.ok(Date.now() < deadline, "Actual production session did not disconnect at preflight stop");
  await sleep(20);
}
emit({ type: "result", ...JSON.parse(readFileSync("/tmp/same-session-stopped.json", "utf8")) });
const finalize = await receive("finalize");
assert.equal(finalize.sessionId, capture.actualSessionId);
writeFileSync("/tmp/same-session-finalize.json", JSON.stringify(finalize), { flag: "wx" });
await messages.return();
