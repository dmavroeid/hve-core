// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import { statSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const executablePath = await puppeteer.executablePath({ headless: "shell" });
if (!statSync(executablePath).isFile()) throw new Error("Install the pinned Chrome Headless Shell before configuring it");
writeFileSync(new URL("./browser-config.json", import.meta.url),
  JSON.stringify({ executablePath, headless: "shell" }, null, 2) + "\n");
console.log("Pinned Chrome Headless Shell configuration written to browser-config.json");
