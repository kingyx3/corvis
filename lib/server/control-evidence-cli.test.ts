import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("unconfigured evidence collection exits nonzero instead of silently skipping", () => {
  const env = { ...process.env };
  delete env.CORVIS_POSTGRES_DSN;
  delete env.CORVIS_CONTROL_TENANT_ID;
  const result = spawnSync(process.execPath, ["scripts/collect-control-evidence.ts", "missing.json"], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Required control-evidence configuration missing/);
});
