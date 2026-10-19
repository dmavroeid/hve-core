// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants, openSync, closeSync, statSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const expectedAccessErrors = new Set(["EACCES", "EPERM", "ENOENT", "ENXIO"]);

function attemptOpen(flags) {
  try {
    return { handle: openSync("/proc/1/fd/2", flags | constants.O_NONBLOCK), errorCode: null };
  } catch (error) {
    if (!expectedAccessErrors.has(error.code)) throw error;
    return { handle: null, errorCode: error.code };
  }
}

export function registerExecutors(registry) {
  registry.register({
    name: "native-log-stream-probe",
    supportsPreparedWorkspace: true,
    supportsEnvVars: true,
    validateConfig(config) { assert.deepEqual(config, {}); },
    async execute(stimulus, options) {
      assert.equal(stimulus.prompt, "Synthetic descriptor eligibility only; no model invocation.");
      const status = readFileSync("/proc/self/status", "utf8");
      const rootMount = readFileSync("/proc/self/mountinfo", "utf8").split("\n")
        .map(line => line.split(" ")).find(fields => fields[4] === "/");
      const facts = {
        schema: "native-log-stream-probe.v1",
        synthetic: true,
        sdkSessions: 0,
        modelCalls: 0,
        hardening: {
          uid: process.getuid(),
          gid: process.getgid(),
          readonlyRoot: rootMount?.[5].split(",").includes("ro") === true,
          noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
          capabilitiesDropped: /^CapEff:\s+0+$/m.test(status),
          networkNone: Object.keys(networkInterfaces()).every(name => name === "lo"),
          memoryBytes: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
          pids: readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(),
          cpu: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
        },
        descriptor: { kind: null, ownerUid: null, ownerGid: null, mode: null, writeOpen: false, writeError: null, readOpen: false, readError: null },
        eligibility: { status: "rejected", reason: null },
        emission: { sent: false, token: null },
      };
      assert.deepEqual(facts.hardening, {
        uid: 1000, gid: 1000, readonlyRoot: true, noNewPrivileges: true,
        capabilitiesDropped: true, networkNone: true, memoryBytes: "536870912",
        pids: "128", cpu: "100000 100000",
      });
      await new Promise((resolve, reject) => process.stderr.write("NATIVE_EXEC_STDERR_CONTROL\n", error => error ? reject(error) : resolve()));
      let info;
      try {
        info = statSync("/proc/1/fd/2");
      } catch (error) {
        if (!expectedAccessErrors.has(error.code)) throw error;
        facts.descriptor.writeError = error.code;
        facts.eligibility.reason = "descriptor-metadata-inaccessible";
      }
      if (info) {
        Object.assign(facts.descriptor, {
          kind: info.isFIFO() ? "pipe" : "other",
          ownerUid: info.uid, ownerGid: info.gid, mode: info.mode & 0o777,
        });
        if (!info.isFIFO()) {
          facts.eligibility.reason = "unsupported-descriptor-type";
        } else {
          const writer = attemptOpen(constants.O_WRONLY);
          facts.descriptor.writeError = writer.errorCode;
          facts.descriptor.writeOpen = writer.handle !== null;
          if (writer.handle === null) {
            facts.eligibility.reason = "write-open-denied";
          } else {
            try {
              if (info.uid === process.getuid()) {
                facts.eligibility.reason = "candidate-owns-pipe";
              } else {
                const reader = attemptOpen(constants.O_RDONLY);
                facts.descriptor.readOpen = reader.handle !== null;
                facts.descriptor.readError = reader.errorCode;
                if (reader.handle !== null) {
                  closeSync(reader.handle);
                  facts.eligibility.reason = "candidate-can-read-queued-bytes";
                } else if (!["EACCES", "EPERM"].includes(reader.errorCode)) {
                  facts.eligibility.reason = "queue-protection-unverified";
                } else {
                  facts.emission.token = randomUUID();
                  const frame = JSON.stringify({ type: "synthetic-native-log-probe", token: facts.emission.token }) + "\n";
                  assert.equal(writeSync(writer.handle, frame), Buffer.byteLength(frame));
                  facts.emission.sent = true;
                  facts.eligibility = { status: "eligible-for-retention-check", reason: "write-only-foreign-owned-pipe" };
                }
              }
            } finally {
              closeSync(writer.handle);
            }
          }
        }
      }
      assert.ok(facts.eligibility.reason);
      writeFileSync(join(options.workDir, "native-log-stream-facts.json"), JSON.stringify(facts) + "\n", { flag: "wx" });
      throw new Error("NATIVE_LOG_STREAM_PROBE_STOP");
    },
    async shutdown() {},
  });
}
