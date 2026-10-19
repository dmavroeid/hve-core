// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const hash = value => createHash("sha256").update(value).digest("hex");
const files = execFileSync("git", ["ls-files", "."], { encoding: "utf8" }).trim().split("\n").sort();
assert.equal(files.length, 24);
const inventory = files.map(file => `${file} ${hash(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))}\n`).join("");
assert.equal(hash(inventory), "a5090731b421f2b854545cedfb9cea60be10905fab48a56b72f34c2bb26ace19");
assert.equal(hash(readFileSync("package-lock.json")), "b9c750fbb43bcf37350da9f62722d737380f0e271a78210be6ad64cd63862da2");
assert.equal(process.version, "v24.14.0");
console.log("Frozen production source, lock and Node verified.");
