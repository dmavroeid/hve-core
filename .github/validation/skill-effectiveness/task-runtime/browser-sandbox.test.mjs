// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import test from "node:test";

test("renderer container keeps non-root, privilege, readonly and network denials",
  { timeout: 10000 }, async () => {
    assert.equal(process.getuid(), 1000);
    const status = readFileSync("/proc/self/status", "utf8");
    assert.match(status, /^NoNewPrivs:\s+1$/m);
    assert.match(status, /^CapEff:\s+0+$/m);
    assert.match(status, /^CapBnd:\s+0+$/m);
    assert.match(status, /^Seccomp:\s+2$/m);
    assert.equal(existsSync("/var/run/docker.sock"), false);
    assert.equal(Object.keys(process.env).some(key =>
      /^(GITHUB_TOKEN|GH_TOKEN|COPILOT_GITHUB_TOKEN|AZURE_OPENAI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/.test(key)), false);
    assert.throws(() => writeFileSync("/opt/vally-runtime/readonly-probe", "unexpected"),
      error => ["EROFS", "EACCES"].includes(error.code));
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = createConnection({ host: "1.1.1.1", port: 80 });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
      socket.setTimeout(1500, () => {
        socket.destroy();
        reject(Object.assign(new Error("No network connection before deadline"), { code: "ETIMEDOUT" }));
      });
    }), error => ["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "EACCES", "EPERM"].includes(error.code));
  });

test("actual Chromium reports namespace and seccomp sandboxes enabled",
  { timeout: 60000 }, async t => {
    const require = createRequire("/opt/vally-runtime/validation/mermaid-runtime/package.json");
    const { default: puppeteer } = await import(require.resolve("puppeteer"));
    const config = JSON.parse(readFileSync(process.env.MERMAID_BROWSER_CONFIG, "utf8"));
    assert.equal(config.headless, true);
    const browser = await puppeteer.launch(config);
    t.after(() => browser.close());
    const args = browser.process().spawnargs;
    assert.equal(args.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox)(?:=|$)/.test(arg)), false);
    const page = await browser.newPage();
    await page.goto("chrome://sandbox", { waitUntil: "load", timeout: 30000 });
    const sandbox = await page.evaluate(() => document.body.innerText);
    console.log("Browser sandbox status:\n" + sandbox);
    writeFileSync("/tmp/browser-sandbox.json", JSON.stringify({
      version: await browser.version(), args, sandbox,
    }, null, 2) + "\n");
    assert.match(sandbox, /Namespace\s+sandbox\s+Yes/i);
    assert.match(sandbox, /Seccomp-BPF\s+sandbox\s+Yes/i);
    assert.match(sandbox, /adequately sandboxed/i);
  });
