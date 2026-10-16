// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function bounded(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out; shutdown is unverified`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function persist(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  let created = false, handle, failure;
  try {
    const bytes = JSON.stringify(record, null, 2) + "\n";
    handle = fs.openSync(temporary, "wx", 0o600);
    created = true;
    fs.writeFileSync(handle, bytes);
    fs.closeSync(handle);
    handle = undefined;
    // Publish complete bytes without replacing an existing session record.
    fs.linkSync(temporary, file);
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try { fs.closeSync(handle); } catch (error) {
      failure = new AggregateError([failure, error], "Inventory persistence and file close failed");
    }
  }
  if (created) {
    try { fs.unlinkSync(temporary); } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Inventory publication and temporary-file cleanup failed") : error;
    }
  }
  if (failure) throw failure;
}

function errorRecord(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    ...(error instanceof AggregateError ? { errors: error.errors.map(errorRecord) } : {}),
    ...(error?.cause ? { cause: errorRecord(error.cause) } : {}),
  };
}

function validateTimeout(timeoutMs) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000,
    "Inventory timeout must be positive and at most 10000ms");
}

function scrubInventoryEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === "SKILL_EVAL_INVENTORY_DIR") delete process.env[key];
  }
}

export async function captureInventory(session, config, directory, { timeoutMs = 10000 } = {}) {
  validateTimeout(timeoutMs);
  assert.ok(typeof session.sessionId === "string" && session.sessionId.length > 0, "Session ID required for inventory capture");
  await bounded(() => session.rpc.tools.initializeAndValidate(), timeoutMs, "Inventory initialization");
  const inventory = await bounded(() => session.rpc.skills.list(), timeoutMs, "Inventory skill list");
  assert.ok(Array.isArray(inventory.skills) && inventory.skills.every(skill =>
    typeof skill?.name === "string" && typeof skill.enabled === "boolean"),
  "Runtime skill inventory or enabled-state missing");
  const file = path.join(directory, `${encodeURIComponent(session.sessionId)}.json`);
  persist(file, {
    at: new Date().toISOString(), sessionId: session.sessionId, phase: "before-first-prompt",
    workingDirectory: config.workingDirectory ?? null,
    configDirectory: config.configDirectory ?? null,
    requestedSkillDirectories: config.skillDirectories ?? [],
    enableConfigDiscovery: config.enableConfigDiscovery ?? null,
    skillDetails: inventory,
    limitation: "Diagnostic startup inventory only. Not tamper-proof or isolation enforcement; no later-context guarantee or spending control.",
  });
  return file;
}

// Native persisted history can omit the transient skill inventory.
export async function installInventoryCapture(packageRoot, directory, { preflight = false, timeoutMs = 10000 } = {}) {
  scrubInventoryEnvironment();
  validateTimeout(timeoutMs);
  assert.ok(directory && path.isAbsolute(directory), "Inventory evidence directory must be absolute");
  fs.mkdirSync(directory, { recursive: true });
  const runtime = path.join(packageRoot, "node_modules", "@microsoft", "vally");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8")).version, "0.19.0");
  const require = createRequire(path.join(runtime, "package.json"));
  const sdkRoot = path.resolve(require.resolve("@github/copilot-sdk"), "..", "..", "..");
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
  assert.equal(sdkPackage.name, "@github/copilot-sdk");
  assert.equal(sdkPackage.version, "1.0.15");
  const { CopilotClient } = await import(pathToFileURL(path.resolve(sdkRoot, sdkPackage.exports["."].import.default)));
  const createSession = CopilotClient.prototype.createSession;
  CopilotClient.prototype.createSession = async function (config) {
    const session = await createSession.call(this, config);
    try {
      await captureInventory(session, config, directory, { timeoutMs });
      if (preflight) throw new Error("MODEL_FREE_NATIVE_PREFLIGHT_STOP");
      return session;
    } catch (error) {
      const errors = [error];
      try { await bounded(() => session.disconnect(), timeoutMs, "Inventory failed-session disconnect"); } catch (cleanupError) {
        errors.push(cleanupError);
      }
      try {
        persist(path.join(directory, `${encodeURIComponent(session.sessionId)}.failure.json`), {
          at: new Date().toISOString(), sessionId: session.sessionId, phase: "before-first-prompt",
          status: "error", errors: errors.map(errorRecord),
          limitation: "Diagnostic failure record only; shutdown and evidence protection are unverified.",
        });
      } catch (persistenceError) {
        errors.push(persistenceError);
      }
      throw new AggregateError(errors,
        `Native inventory capture stopped before prompting: ${errors.map(error => error?.message ?? String(error)).join("; ")}`);
    }
  };
  return () => { CopilotClient.prototype.createSession = createSession; };
}

const preloaded = process.execArgv.some((argument, index) => {
  const entry = argument === "--import" ? process.execArgv[index + 1]
    : argument.startsWith("--import=") ? argument.slice("--import=".length) : null;
  return entry && (entry === import.meta.url || pathToFileURL(path.resolve(entry)).href === import.meta.url);
});
if (preloaded) {
  const directory = process.env.SKILL_EVAL_INVENTORY_DIR;
  scrubInventoryEnvironment();
  assert.ok(directory && path.isAbsolute(directory), "SKILL_EVAL_INVENTORY_DIR must be an absolute evidence directory");
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await installInventoryCapture(packageRoot, directory);
}
