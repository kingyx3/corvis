import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("release build is main-only, keyless, digest-addressed and attested", async () => {
  const workflow = await read(".github/workflows/build-release.yml");

  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /google-github-actions\/auth@v3/);
  assert.match(workflow, /workload_identity_provider/);
  assert.match(workflow, /git-\$\{github_sha\}/);
  assert.match(workflow, /image_summary\.digest/);
  assert.match(workflow, /actions\/attest@v4/);
  assert.match(workflow, /push-to-registry:\s*true/);
  assert.doesNotMatch(workflow, /service-account.*json|google_application_credentials/);
});

test("terraform deploy resolves release tags to immutable digests without API_IMAGE variable", async () => {
  const workflow = await read(".github/workflows/terraform-deploy.yml");

  assert.doesNotMatch(workflow, /vars\.api_image/);
  assert.match(workflow, /release_sha/);
  assert.match(workflow, /rollback_known_good/);
  assert.match(workflow, /gcloud artifacts docker images describe/);
  assert.match(workflow, /image_summary\.digest/);
  assert.match(workflow, /tf_var_api_image=\$\{api_image\}/);
  assert.match(workflow, /known-good\.json/);
  assert.match(workflow, /@sha256:\[0-9a-f\]\{64\}/);
});

test("known-good rollback state advances only after every live acceptance family passes", async () => {
  const workflow = await read(".github/workflows/security-acceptance.yml");

  assert.match(workflow, /record-known-good-release/);
  assert.match(workflow, /needs:\s*\[edge, postgres-rls, control-loop\]/);
  assert.match(workflow, /if:\s*\$\{\{ success\(\) \}\}/);
  assert.match(workflow, /spec\.template\.spec\.containers\.image/);
  assert.match(workflow, /releases\/\$\{\{ inputs\.environment \}\}\/known-good\.json/);
  assert.match(workflow, /corvis\.known-good-release\.v2/);
  assert.match(workflow, /control-loop-runtime-acceptance/);
  assert.match(workflow, /controlLoopImage/);
});

test("deployment docs keep the release set derived and known-good state acceptance-gated", async () => {
  const environments = await read("docs/GITHUB_ENVIRONMENTS.md");
  const deployment = await read("docs/DEPLOYMENT.md");

  assert.match(environments, /`api_image` is not a human-managed github environment variable/);
  assert.match(environments, /remove or avoid creating/);
  assert.match(environments, /runtime api\/worker image/);
  assert.match(deployment, /a built image set is not known-good until live acceptance passes/);
  assert.match(deployment, /only a fully successful acceptance run writes/);
  assert.match(deployment, /known-good\.json/);
  assert.match(deployment, /failed or incomplete acceptance never advances known-good/);
  assert.match(deployment, /accepted api\/worker image and accepted control-loop image/);
});
