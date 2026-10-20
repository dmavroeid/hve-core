import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const artifact = process.argv[2];
if (!artifact) throw new Error("Usage: node check.mjs deliverable/architecture-pack.md");

const mermaidCli = process.env.MERMAID_CLI;
const browserConfig = process.env.MERMAID_BROWSER_CONFIG;
if (!mermaidCli || !browserConfig) throw new Error("Set MERMAID_CLI and MERMAID_BROWSER_CONFIG to your approved local renderer paths");

function fail(message) {
  throw new Error(message);
}

function render(block, name, directory) {
  const input = join(directory, `${name}.mmd`);
  const output = join(directory, `${name}.png`);
  writeFileSync(input, block + "\n");
  const result = spawnSync(process.execPath, [mermaidCli, "-i", input, "-o", output, "--size", "1600", "--backgroundColor", "white", "--puppeteerConfigFile", browserConfig], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.ifError(result.error);
  if (result.status !== 0) {
    fail(`Mermaid render failed for ${name}: ${result.stdout}\n${result.stderr}`);
  }
  if (!existsSync(output)) fail(`Mermaid render did not produce output for ${name}`);
}

const path = resolve(artifact);
if (!existsSync(path)) fail(`Artifact not found: ${path}`);
if (!existsSync(resolve(mermaidCli))) fail(`Mermaid CLI not found: ${mermaidCli}`);
if (!existsSync(resolve(browserConfig))) fail(`Mermaid browser config not found: ${browserConfig}`);

const markdown = readFileSync(path, "utf8");
if (!markdown.trim()) fail("Architecture pack is empty");

const blocks = [...markdown.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)];
const names = ["legend", "system-context", "container", "component", "deployment"];
if (blocks.length !== names.length) fail("Expected five Mermaid blocks: legend, context, container, component, deployment");
const rendered = join(dirname(path), "rendered");
mkdirSync(rendered, { recursive: true });
for (let index = 0; index < names.length; index++) {
  render(blocks[index][1].trim(), names[index], rendered);
}

console.log("Architecture pack passed contract and Mermaid render checks.");
