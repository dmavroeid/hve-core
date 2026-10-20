import {readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";

const checksDir = path.resolve("task-fixture", "checks");
const files = readdirSync(checksDir)
  .filter(file => file.endsWith(".test.mjs"))
  .sort()
  .map(file => path.join(checksDir, file));

if (files.length === 0) {
  throw new Error(`No test files found in ${checksDir}`);
}

const environment = {...process.env};
delete environment.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: environment,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
