import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("production release images cannot be rebuilt independently", async () => {
  const workflow = await read(".github/workflows/build-release.yml");
  const inputBlock = workflow.match(/environment:\n[\s\S]*?default:\s*dev/)?.[0] ?? "";

  assert.match(inputBlock, /options:\s*\[dev, uat\]/);
  assert.doesNotMatch(inputBlock, /prod/);
  assert.match(workflow, /release builds are prohibited in prod/);
  assert.match(workflow, /build once in uat and copy the exact image set/);
});

test("prod promotion copies UAT release before Terraform deployment", async () => {
  const workflow = await read(".github/workflows/promote-environment.yml");

  assert.match(workflow, /copy-release-to-prod:/);
  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/copy-release-to-prod\.yml/);
  assert.match(workflow, /inputs\.environment == 'prod'/);
  assert.match(workflow, /needs:\s*\[validate, copy-release-to-prod\]/);
  assert.match(workflow, /needs\.copy-release-to-prod\.result == 'success'/);
});

test("cross-project copy reconciles reader-only trust and verifies physical digest identity", async () => {
  const workflow = await read(".github/workflows/copy-release-to-prod.yml");

  assert.match(workflow, /environment:\s*uat/);
  assert.match(workflow, /environment:\s*prod/);
  assert.match(workflow, /roles\/artifactregistry\.reader/);
  assert.doesNotMatch(workflow, /roles\/artifactregistry\.(?:writer|repoAdmin)/i);
  assert.match(workflow, /gcrane_version:\s*v0\.22\.1/);
  assert.match(workflow, /checksums\.txt/);
  assert.match(workflow, /gcrane cp/);
  assert.match(workflow, /source_digest=.*gcrane digest/);
  assert.match(workflow, /target_digest=.*gcrane digest/);
  assert.match(workflow, /target_digest.*source_digest/);
  assert.match(workflow, /refusing to overwrite prod/);
  assert.match(workflow, /gcrane-copy-digest-verified/);
});
