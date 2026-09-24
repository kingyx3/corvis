import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("scheduled control loop persists runtime state without mutating protected main", async () => {
  const workflow = await read(".github/workflows/control-loop.yml");
  const gitignore = await read(".gitignore");

  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*issues: read/);
  assert.match(workflow, /actions\/cache\/restore@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /actions\/cache\/save@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /path: control-loop\/state/);
  assert.match(workflow, /key: control-loop-state-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /restore-keys:[\s\S]*control-loop-state-/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /git commit/);
  assert.match(gitignore, /^control-loop\/state\/$/m);
});
