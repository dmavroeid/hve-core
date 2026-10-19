// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const hash = value => createHash("sha256").update(value).digest("hex");
const files = execFileSync("git", ["ls-files", "."], { encoding: "utf8" }).trim().split("\n").sort();
assert.equal(files.length, 25);
const inventory = files.map(file => `${file} ${hash(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))}\n`).join("");
assert.equal(hash(inventory), "451a20fc8ec5b30cb54d72494abf4e3c44814eaf6485dd8ba2d07614893bccaf");
assert.equal(hash(readFileSync("package-lock.json")), "b9c750fbb43bcf37350da9f62722d737380f0e271a78210be6ad64cd63862da2");
assert.equal(process.version, "v24.14.0");
console.log("Current canonical skill, lockfile and frozen Node verified.");
