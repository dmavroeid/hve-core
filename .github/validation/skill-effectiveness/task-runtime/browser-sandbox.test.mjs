// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import test from "node:test";
import { assertSandboxStatus } from "./browser-sandbox-status.mjs";

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
    const privilegeProbe = execFileSync(process.env.CATALOG_PYTHON, ["-c", [
      "import ctypes, errno",
      "libc = ctypes.CDLL(None, use_errno=True)",
      "assert libc.chroot(b'/') == -1 and ctypes.get_errno() == errno.EPERM",
      "assert libc.mount(b'none', b'/tmp', b'tmpfs', 0, None) == -1 and ctypes.get_errno() == errno.EPERM",
      "print('outer chroot and mount remain denied')",
    ].join("\n")], { encoding: "utf8", timeout: 5000 });
    assert.match(privilegeProbe, /outer chroot and mount remain denied/);
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
    assertSandboxStatus(sandbox);
  });
