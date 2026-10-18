// Copyright (c) 2026 Microsoft Corporation. All rights reserved.
// SPDX-License-Identifier: MIT
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { posix as path } from "node:path";
import { fileURLToPath } from "node:url";

const failures = new Set([
  "submission-mismatch", "protected-input-writable", "probe-write-error",
]);

function writeDenied(file) {
  try {
    appendFileSync(file, "\nSynthetic protected-input write probe.\n");
  } catch (error) {
    if (error.code === "EROFS" || error.code === "EACCES") return true;
    throw new Error("probe-write-error");
  }
  throw new Error("protected-input-writable");
}

try {
  console.error("protected-input-checker-entered");
  const checker = fileURLToPath(import.meta.url);
  const submission = path.join(process.env.EVALUATE_ARTIFACT_DIR, "result.txt");
  if (readFileSync(submission, "utf8") !== "Synthetic protected-input artifact.\n") {
    throw new Error("submission-mismatch");
  }
  const checkerWriteDenied = writeDenied(checker);
  const submissionWriteDenied = writeDenied(submission);
  const scratch = path.join(process.env.EVALUATE_WORKSPACE, ".protected-input-probe-scratch");
  writeFileSync(scratch, "Synthetic writable scratch.\n", { flag: "wx", mode: 0o600 });
  unlinkSync(scratch);
  console.log(JSON.stringify({
    name: "protected-input-probe", kind: "code", passed: true, score: 1,
    evidence: JSON.stringify({
      checkerAuthenticated: true, checkerBodyEntered: true,
      checkerWriteDenied, submissionWriteDenied,
      submissionMatches: true, workspaceWritable: true,
    }),
  }));
} catch (error) {
  const reason = failures.has(error.message) ? error.message : "checker-operation-failed";
  console.error(`protected-input-failure:${reason}`);
  process.exitCode = 1;
}
