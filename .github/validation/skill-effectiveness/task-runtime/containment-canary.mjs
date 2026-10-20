// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import net from "node:net";

const assets = process.env.EVALUATE_ASSETS;
const artifact = process.env.EVALUATE_ARTIFACT_DIR;
const workspace = process.env.EVALUATE_WORKSPACE;
const config = JSON.parse(readFileSync(join(assets, "canaries.json"), "utf8"));
const facts = {};
const denied = (name, action, codes) => {
  let code;
  try { action(); } catch (error) { code = error.code; }
  assert.ok(codes.includes(code), name);
  facts[name] = true;
};
assert.equal(process.getuid(), 1000);
facts.nonRoot = true;
const status = readFileSync("/proc/self/status", "utf8");
assert.match(status, /^CapEff:\s+0+$/m);
assert.match(status, /^NoNewPrivs:\s+1$/m);
facts.noCapabilities = true;
facts.noNewPrivileges = true;
denied("uidEscalationDenied", () => process.setuid(0), ["EPERM"]);
denied("hostFileReadDenied", () => readFileSync(config.hostFile), ["ENOENT", "EACCES"]);
denied("hostInventoryReadDenied", () => readFileSync(config.inventoryFile), ["ENOENT", "EACCES"]);
assert.equal(process.env.CONTAINMENT_HOST_CANARY, undefined);
assert.equal(process.env.SKILL_EVAL_INVENTORY_DIR, undefined);
for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_GITHUB_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"]) {
  assert.equal(process.env[name], undefined, "credential variable projected");
}
facts.hostEnvironmentExcluded = true;
assert.equal(existsSync("/var/run/docker.sock"), false);
facts.dockerSocketExcluded = true;
denied("checkerOverwriteDenied", () => writeFileSync(join(assets, "check.mjs"), "replaced"), ["EROFS", "EACCES", "EPERM"]);
denied("checkerSiblingWriteDenied", () => writeFileSync(join(assets, "new.txt"), "new"), ["EROFS", "EACCES", "EPERM"]);
denied("submissionOverwriteDenied", () => writeFileSync(join(artifact, "deliverable/result.txt"), "replaced"), ["EROFS", "EACCES", "EPERM"]);
denied("submissionSiblingWriteDenied", () => writeFileSync(join(artifact, "new.txt"), "new"), ["EROFS", "EACCES", "EPERM"]);
denied("runtimeDependencyWriteDenied", () => writeFileSync("/opt/vally-runtime/package.json", "{}"), ["EROFS", "EACCES", "EPERM"]);
assert.deepEqual(JSON.parse(readFileSync(process.argv[2], "utf8")), { answer: 42 });
facts.correctSubmission = true;
writeFileSync(join(workspace, "scratch-positive"), "allowed");
assert.equal(readFileSync(join(workspace, "scratch-positive"), "utf8"), "allowed");
facts.scratchWritable = true;
writeFileSync("/tmp/containment-positive", "allowed");
facts.temporaryWritable = true;
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.getuid()))"], {
  encoding: "utf8", timeout: 5000,
});
assert.equal(child.status, 0);
assert.equal(child.stdout, "1000");
facts.executableGradingAllowed = true;
const networkCode = await new Promise((resolve, reject) => {
  const socket = net.connect({ host: config.hostAddress, port: config.port });
  socket.setTimeout(3000);
  socket.once("connect", () => { socket.destroy(); reject(new Error("Host network reachable")); });
  socket.once("error", error => { socket.destroy(); resolve(error.code); });
  socket.once("timeout", () => { socket.destroy(); reject(new Error("Network probe inconclusive")); });
});
assert.ok(["ENETUNREACH", "EHOSTUNREACH", "EACCES", "EPERM"].includes(networkCode));
facts.controlledHostNetworkDenied = true;
assert.equal(Object.keys(facts).length, 18);
await new Promise(resolve => setTimeout(resolve, 2000));
writeFileSync(join(workspace, "containment-facts.json"), JSON.stringify(facts));
