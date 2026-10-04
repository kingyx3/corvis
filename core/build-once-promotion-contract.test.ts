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
  assert.doesNotMatch(inputBlock, /options:\s*\[[^\]]*prod/);
  assert.match(workflow, /release builds are prohibited in prod/);
  assert.match(workflow, /build once in uat and copy the exact image set/);
});

test("prod promotion copies UAT release before reviewed Terraform plan and apply", async () => {
  const workflow = await read(".github/workflows/promote-environment.yml");

  assert.match(workflow, /copy-release-to-prod:/);
  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/copy-release-to-prod\.yml/);
  assert.match(workflow, /inputs\.environment == 'prod'/);
  assert.match(workflow, /\n  plan:\n/);
  assert.match(workflow, /action:\s*plan/);
  assert.match(workflow, /\n  deploy:\n/);
  assert.match(workflow, /needs:\s*plan/);
  assert.match(workflow, /approved_plan_sha256:\s*\$\{\{ needs\.plan\.outputs\.plan_sha256 \}\}/);
});

test("cross-project copy requires the exact UAT-known-good digest set and verifies provenance", async () => {
  const workflow = await read(".github/workflows/copy-release-to-prod.yml");

  assert.match(workflow, /environment:\s*uat/);
  assert.match(workflow, /environment:\s*prod/);
  assert.match(workflow, /uat-known-good:/);
  assert.match(workflow, /known-good\.json/);
  assert.match(workflow, /\.sourcesha \/\/ empty/);
  assert.match(workflow, /requested release .* is not the uat acceptance-approved source sha/);
  assert.match(workflow, /gh attestation verify "oci:\/\/\$\{image\}" --repo/);
  assert.match(workflow, /attestations:\s*read/);
  assert.match(workflow, /roles\/artifactregistry\.reader/);
  assert.doesNotMatch(workflow, /roles\/artifactregistry\.(?:writer|repoadmin)/i);
  assert.match(workflow, /gcrane_version:\s*v0\.22\.1/);
  assert.match(workflow, /gosumdb=sum\.golang\.org/);
  assert.match(workflow, /source_digest="\$\{source_ref##\*@\}"/);
  assert.match(workflow, /gcrane cp "\$\{source_ref\}" "\$\{target_ref\}"/);
  assert.match(workflow, /target_digest="\$\(gcrane digest "\$\{target_ref\}"\)"/);
  assert.match(workflow, /target_digest.*source_digest/);
  assert.match(workflow, /refusing to overwrite prod/);
  assert.match(workflow, /uat-known-good-digest-copy/);
  assert.match(workflow, /github-attestation-verified/);
});
