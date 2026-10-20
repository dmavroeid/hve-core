import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNotebookAndSummary } from "./checker-lib.mjs";

const [notebookArg, summaryArg] = process.argv.slice(2);
assert.ok(notebookArg && summaryArg, "Usage: node check-notebook.mjs NOTEBOOK.ipynb SUMMARY.md");

const python = process.env.QUEUE_DELAY_NOTEBOOK_PYTHON ?? "python";
const notebookPath = path.resolve(notebookArg);
const summaryPath = path.resolve(summaryArg);
const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(path.dirname(notebookPath), "..");
const executedNotebookPath = path.join(path.dirname(notebookPath), "queue-delay-analysis.executed.ipynb");
if (!existsSync(notebookPath) || !existsSync(summaryPath)) {
  console.error("Missing required candidate notebook or summary");
  process.exit(1);
}

try {
  const run = spawnSync(python, [
    path.join(fixtureDirectory, "execute-notebook.py"),
    notebookPath,
    executedNotebookPath,
  ], {
    cwd: workspaceDirectory,
    encoding: "utf8",
    timeout: 330000,
    env: {
      ...process.env,
      QUEUE_DELAY_NOTEBOOK_FIXTURE_DIR: fixtureDirectory,
      QUEUE_DELAY_NOTEBOOK_WORKSPACE_DIR: workspaceDirectory,
    },
    maxBuffer: 16 * 1024 * 1024,
  });

  assert.ifError(run.error);
  if (run.status === 1) {
    console.error(run.stdout + run.stderr);
    process.exit(1);
  }
  assert.equal(run.status, 0, [
    "Notebook execution failed.",
    run.stdout.trim(),
    run.stderr.trim(),
  ].filter(Boolean).join("\n\n"));

  validateNotebookAndSummary(executedNotebookPath, summaryPath);

  const executed = JSON.parse(readFileSync(executedNotebookPath, "utf8"));
  const errors = executed.cells
    .filter(cell => cell.cell_type === "code")
    .flatMap(cell => Array.isArray(cell.outputs) ? cell.outputs : [])
    .filter(output => output.output_type === "error");
  assert.equal(errors.length, 0, "Executed notebook contains cell errors");
} catch (error) {
  console.error(error);
  process.exit(2);
}

console.log("Notebook executed, retained, and PNGs verified. Analytical correctness and visual quality require substantive review.");
