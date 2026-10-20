import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function readNotebook(notebookPath) {
  const notebook = JSON.parse(readFileSync(notebookPath, "utf8"));
  assert.ok(Array.isArray(notebook.cells), "Notebook must contain a cells array");
  return notebook;
}

function normalizedCells(notebook) {
  return notebook.cells.map(cell => ({
    ...cell,
    cell_type: cell.cell_type,
    sourceText: Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? ""),
    outputs: Array.isArray(cell.outputs) ? cell.outputs : [],
  }));
}

export function validateNotebookStructure(notebook) {
  const cells = normalizedCells(notebook);
  assert.ok(cells.some(cell => cell.cell_type === "code" && cell.sourceText.trim()), "Notebook must contain executable code");
  assert.ok(cells.some(cell => cell.cell_type === "markdown" && cell.sourceText.trim()), "Notebook must contain a written analysis");
}

export function validateSummary(summaryText) {
  assert.ok(summaryText.trim(), "Summary must not be empty; substantive quality requires source-grounded review");
}

export function validateNotebookAndSummary(notebookPath, summaryPath) {
  const notebook = readNotebook(notebookPath);
  validateNotebookStructure(notebook);
  validateSummary(readFileSync(summaryPath, "utf8"));
}
