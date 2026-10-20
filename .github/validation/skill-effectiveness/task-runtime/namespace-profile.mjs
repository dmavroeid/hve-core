// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function rendererProfile(base) {
  assert.equal(base.defaultAction, "SCMP_ACT_ERRNO");
  assert.ok(Array.isArray(base.syscalls));
  const profile = structuredClone(base);
  profile.syscalls.push({
    names: ["clone", "setns", "unshare", "chroot"],
    action: "SCMP_ACT_ALLOW",
    args: [],
  });
  assert.deepEqual({ ...profile, syscalls: profile.syscalls.slice(0, -1) }, base);
  return profile;
}

async function response(url) {
  return fetch(url, {
    headers: { "User-Agent": "hve-runtime-qualification" },
    signal: AbortSignal.timeout(30000),
  });
}

async function source(url) {
  const result = await response(url);
  assert.equal(result.status, 200, `${url}: HTTP ${result.status}`);
  return result.text();
}

async function main() {
  const directory = resolve(process.argv[2]);
  mkdirSync(directory, { recursive: true });
  const version = JSON.parse(execFileSync("docker", ["version", "--format", "{{json .}}"], {
    encoding: "utf8",
  }));
  const security = JSON.parse(execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
    encoding: "utf8",
  }));
  assert.ok(security.includes("name=seccomp,profile=builtin"));
  assert.match(version.Server.GitCommit, /^[0-9a-f]{7,40}$/);
  const commitUrl = `https://api.github.com/repos/moby/moby/commits/${version.Server.GitCommit}`;
  const commit = JSON.parse(await source(commitUrl)).sha;
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(commit.startsWith(version.Server.GitCommit));
  let url;
  let original;
  for (const path of [
    "vendor/github.com/moby/profiles/seccomp/default.json",
    "profiles/seccomp/default.json",
  ]) {
    url = `https://raw.githubusercontent.com/moby/moby/${commit}/${path}`;
    const result = await response(url);
    console.log(`${url}: HTTP ${result.status}`);
    if (result.status === 404) continue;
    assert.equal(result.status, 200, `${url}: HTTP ${result.status}`);
    original = await result.text();
    break;
  }
  assert.equal(typeof original, "string", "No matching engine-owned default profile found");
  const base = JSON.parse(original);
  const profile = rendererProfile(base);
  writeFileSync(resolve(directory, "docker-version.json"), JSON.stringify(version, null, 2) + "\n");
  writeFileSync(resolve(directory, "docker-default.json"), original);
  writeFileSync(resolve(directory, "docker-profile-LICENSE"),
    await source(`https://raw.githubusercontent.com/moby/moby/${commit}/LICENSE`));
  writeFileSync(resolve(directory, "renderer-seccomp.json"), JSON.stringify(profile, null, 2) + "\n");
  writeFileSync(resolve(directory, "profile-provenance.json"), JSON.stringify({
    engineCommit: commit,
    engineSecurityOptions: security,
    source: url,
    sha256: createHash("sha256").update(original).digest("hex"),
    addedRule: profile.syscalls.at(-1),
    otherChanges: false,
    scope: "Renderer-only test; not the native candidate or general grader profile",
  }, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
