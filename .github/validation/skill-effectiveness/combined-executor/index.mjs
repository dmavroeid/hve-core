// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import net from "node:net";

export function registerExecutors(registry) {
  registry.register({
    name: "containment-canary",
    supportsPreparedWorkspace: true,
    supportsMultiTurn: true,
    async shutdown() {},
    async execute(stimulus, options) {
      const facts = [];
      const check = (name, fn) => { fn(); facts.push(name); };
      const deniedRead = path => assert.throws(() => readFileSync(path), error => ["ENOENT", "EACCES", "EPERM"].includes(error.code));
      const deniedWrite = path => assert.throws(() => writeFileSync(path, "SYNTHETIC-WRITE"), error => ["EROFS", "EACCES", "EPERM"].includes(error.code));
      const workspace = options.workDir ?? process.cwd();
      const controls = JSON.parse(readFileSync(join(workspace, "public-controls.json"), "utf8"));
      check("non-root-uid", () => assert.equal(process.getuid(), 1000));
      const status = readFileSync("/proc/self/status", "utf8");
      check("zero-effective-capabilities", () => assert.match(status, /^CapEff:\s+0+$/m));
      check("no-new-privileges", () => assert.match(status, /^NoNewPrivs:\s+1$/m));
      check("uid-escalation-denied", () => assert.throws(() => process.setuid(0), error => error.code === "EPERM"));
      check("host-file-read-denied", () => deniedRead(controls.hostFile));
      check("host-inventory-read-denied", () => deniedRead(controls.inventoryFile));
      check("private-checker-read-denied", () => deniedRead(controls.privateChecker));
      check("private-checker-not-staged", () => assert.equal(existsSync(join(workspace, "private-checker.mjs")), false));
      check("host-environment-not-projected", () => {
        for (const key of ["CONTAINMENT_HOST_CANARY", "SKILL_EVAL_INVENTORY_DIR", "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"]) assert.equal(process.env[key], undefined);
      });
      check("docker-socket-absent", () => assert.equal(existsSync("/var/run/docker.sock"), false));
      check("runtime-manifest-write-denied", () => deniedWrite("/opt/vally-runtime/package.json"));
      check("root-sibling-write-denied", () => deniedWrite("/containment-write-test"));
      check("public-input-readable", () => assert.equal(readFileSync(join(workspace, "public-input.txt"), "utf8"), "SYNTHETIC-PUBLIC-INPUT"));
      check("workspace-file-writable", () => {
        const path = join(workspace, "candidate-output.txt");
        writeFileSync(path, "SYNTHETIC-CANDIDATE-OUTPUT");
        assert.equal(readFileSync(path, "utf8"), "SYNTHETIC-CANDIDATE-OUTPUT");
      });
      check("public-input-writable", () => {
        const path = join(workspace, "public-input.txt");
        writeFileSync(path, "SYNTHETIC-CANDIDATE-EDIT");
        assert.equal(readFileSync(path, "utf8"), "SYNTHETIC-CANDIDATE-EDIT");
      });
      check("temporary-directory-writable", () => {
        const path = "/tmp/containment-positive.txt";
        writeFileSync(path, "SYNTHETIC-TEMP");
        assert.equal(readFileSync(path, "utf8"), "SYNTHETIC-TEMP");
      });
      check("child-executes-as-non-root", () => {
        const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.getuid()))"], { encoding: "utf8", timeout: 5000 });
        assert.equal(child.status, 0);
        assert.equal(child.stdout, "1000");
      });
      await new Promise((ok, fail) => {
        const client = net.connect(controls.port, controls.gateway);
        client.setTimeout(3000);
        client.once("connect", () => { client.destroy(); fail(new Error("Controlled host egress unexpectedly succeeded")); });
        client.once("timeout", () => { client.destroy(); fail(new Error("Egress timeout is not proof of denial")); });
        client.once("error", error => {
          try { assert.ok(["ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"].includes(error.code), "Explicit egress denial required"); facts.push("controlled-host-egress-denied"); ok(); }
          catch (failure) { fail(failure); }
        });
      });
      const sdkRoot = join(workspace, "sdk-runtime");
      mkdirSync(join(sdkRoot, "home"), { recursive: true });
      const child = spawnSync(process.execPath, ["/opt/vally-runtime/combined-sdk-session.mjs"], {
        cwd: "/opt/vally-runtime",
        env: { PATH: process.env.PATH, HOME: join(sdkRoot, "home"), TMPDIR: "/tmp",
          RUNNER_TEMP: sdkRoot, CI: "1", DO_NOT_TRACK: "1", VALLY_TELEMETRY_OPTOUT: "1" },
        encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024,
      });
      const sdkFile = join(sdkRoot, "combined-sdk-d70", "safe", "summary.json");
      const sdk = existsSync(sdkFile) ? JSON.parse(readFileSync(sdkFile, "utf8")) : null;
      writeFileSync(join(workspace, "sdk-result.json"), JSON.stringify({
        sdk, exitCode: child.status, signal: child.signal, startupError: child.error?.code ?? null,
        diagnostic: String(child.stderr ?? "").slice(-1024)
          .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s"'<>]*/gi, "[path]")
          .replace(/(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]"),
      }));
      writeFileSync(join(workspace, "candidate-facts.json"), JSON.stringify({ facts, modelCalls: 0, sdkStatus: sdk?.status ?? "unavailable" }));
      assert.equal(child.error, undefined, "SDK child must finish within its bound");
      assert.equal(child.status, 0, "Actual contained SDK harness must succeed; see sdk-result.json");
      assert.equal(sdk.status, "passed");
      assert.equal(sdk.cases.length, 6);
      assert.equal(sdk.promptMethodsCalled, 0);
      assert.equal(sdk.modelEvents, 0);
      assert.equal(sdk.cleanup, "passed");
      await new Promise(ok => setTimeout(ok, 2000));
      const { createDefaultExecutorRegistry } = await import("@microsoft/vally");
      return createDefaultExecutorRegistry().get("mock").execute(stimulus, options);
    },
  });
}
