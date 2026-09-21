import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("production-like promotion composes deployment then security acceptance", () => {
  const promotion = read(".github/workflows/promote-environment.yml");
  const deploy = read(".github/workflows/terraform-deploy.yml");
  const acceptance = read(".github/workflows/security-acceptance.yml");

  assert.match(promotion, /options: \[uat, prod\]/);
  assert.match(promotion, /uses: \.\/\.github\/workflows\/terraform-deploy\.yml/);
  assert.match(promotion, /action: apply/);
  assert.match(promotion, /acceptance:\n    needs: deploy\n    uses: \.\/\.github\/workflows\/security-acceptance\.yml/);
  assert.match(promotion, /Promotion requires release_sha or rollback_known_good=true/);
  assert.match(promotion, /Production-like promotion may only run from main/);

  assert.match(deploy, /workflow_call:/);
  assert.match(deploy, /case "\$\{\{ inputs\.action \}\}" in\n            plan\|apply\)/);
  assert.match(deploy, /Apply versioned Postgres migrations/);
  assert.match(deploy, /Terraform apply/);

  assert.match(acceptance, /workflow_call:/);
  assert.match(acceptance, /Security acceptance supports only uat or prod/);
  assert.match(acceptance, /record-known-good-release:\n    needs: \[edge, postgres-rls\]/);
  assert.match(acceptance, /if: \$\{\{ success\(\) \}\}/);
});

test("known-good cannot advance before both live acceptance families succeed", () => {
  const acceptance = read(".github/workflows/security-acceptance.yml");
  const edgeIndex = acceptance.indexOf("  edge:");
  const rlsIndex = acceptance.indexOf("  postgres-rls:");
  const knownGoodIndex = acceptance.indexOf("  record-known-good-release:");

  assert.ok(edgeIndex >= 0, "edge acceptance job must exist");
  assert.ok(rlsIndex > edgeIndex, "Postgres/RLS acceptance must exist after edge job definition");
  assert.ok(knownGoodIndex > rlsIndex, "known-good job must remain downstream of both acceptance job definitions");
  assert.match(acceptance.slice(knownGoodIndex), /needs: \[edge, postgres-rls\]/);
});
