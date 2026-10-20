import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
const assets = process.env.EVALUATE_ASSETS;
const snapshot = process.env.EVALUATE_ARTIFACT_DIR;
const scratch = join(process.env.EVALUATE_WORKSPACE, "execution");
const regularTree = directory => {
  for (const name of readdirSync(directory)) {
    const file = join(directory, name), stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Non-regular submission input");
    if (stat.isDirectory()) regularTree(file);
  }
};
regularTree(join(snapshot, "deliverable"));
mkdirSync(scratch);
cpSync(join(snapshot, "deliverable"), join(scratch, "deliverable"), { recursive: true });
cpSync(join(assets, "task-fixture"), join(scratch, "task-fixture"), { recursive: true });
const task = "analysis-authoring";
if (task === "c4-architecture") {
  for (const key of ["MERMAID_CLI", "MERMAID_BROWSER_CONFIG"]) {
    if (!process.env[key] || !existsSync(process.env[key])) throw new Error("Missing renderer prerequisite: " + key);
  }
  const blocks = [...readFileSync(join(scratch, "deliverable/queue-delay-analysis.ipynb"), "utf8").matchAll(/```mermaid\r?\n([\s\S]*?)```/g)];
  if (blocks.length !== 5) process.exit(1);
}
const args = ["task-fixture/check-notebook.mjs","deliverable/queue-delay-analysis.ipynb","deliverable/summary.md"];
args[0] = resolve(assets, args[0]);
if (task === "p-map") {
  const tests = readdirSync(join(assets, "task-fixture", "checks"))
    .filter(name => name.endsWith(".test.mjs")).sort()
    .map(name => join(assets, "task-fixture", "checks", name));
  if (tests.length === 0) throw new Error("Trusted behavior tests are unavailable");
  args.splice(0, args.length, "--test", ...tests);
}
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
delete env.NODE_OPTIONS;
const result = spawnSync(process.execPath, args, {
  cwd: scratch, env, encoding: "utf8", timeout: 360000, maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.signal || result.status === null) throw new Error("Checker terminated without a normal exit");
if (result.status !== 0) {
  if (result.status === 1 && task !== "c4-architecture") process.exit(1);
  throw new Error("Checker operational failure or ambiguous renderer failure: " + result.stdout + result.stderr);
}
