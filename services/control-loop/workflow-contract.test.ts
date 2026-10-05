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
  assert.match(workflow, /actions\/cache\/restore@[0-9a-f]{40}\s+# v6\.1\.0/);
  assert.match(workflow, /actions\/cache\/save@[0-9a-f]{40}\s+# v6\.1\.0/);
  assert.match(workflow, /path: services\/control-loop\/state/);
  assert.match(workflow, /key: control-loop-state-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /restore-keys:[\s\S]*control-loop-state-/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /git push/);
  assert.doesNotMatch(workflow, /git commit/);
  assert.match(gitignore, /^services\/control-loop\/state\/$/m);
});

test("the daily incremental scan diffs from the last scanned commit instead of only the latest commit", async () => {
  const workflow = await read(".github/workflows/control-loop.yml");

  // Enough history to reach the commit recorded in the watermark; the CLI falls back to a full scan if it is unreachable.
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40} # v7\n        with:\n(?:          #[^\n]*\n)*          fetch-depth: 0\n/);
  assert.doesNotMatch(workflow, /HEAD~1/);
  assert.doesNotMatch(workflow, /git diff/);
  // No fixed heredoc delimiter that a changed path named EOF could terminate early.
  assert.doesNotMatch(workflow, /<<EOF/);
  assert.doesNotMatch(workflow, /CONTROL_LOOP_CHANGED_PATHS/);
});
