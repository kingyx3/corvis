import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("release build is main-only, keyless, digest-addressed and attested", async () => {
  const workflow = await read(".github/workflows/build-release.yml");

  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /google-github-actions\/auth@[0-9a-f]{40}\s+# v3/);
  assert.match(workflow, /workload_identity_provider/);
  assert.match(workflow, /git-\$\{github_sha\}/);
  assert.match(workflow, /image_summary\.digest/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /push-to-registry:\s*true/);
  assert.doesNotMatch(workflow, /service-account.*json|google_application_credentials/);
  // actions/attest push-to-registry reads only static `auths` entries, not gcloud credHelpers.
  assert.match(workflow, /token_format:\s*access_token/);
  assert.match(workflow, /docker\/login-action@[0-9a-f]{40}\s+# v3/);
  assert.match(workflow, /username:\s*oauth2accesstoken/);
  assert.match(workflow, /password:\s*\$\{\{ steps\.gcp_auth\.outputs\.access_token \}\}/);
  assert.match(workflow, /registry:\s*\$\{\{ env\.gcp_region \}\}-docker\.pkg\.dev/);
  assert.doesNotMatch(workflow, /gcloud auth configure-docker/);
});

test("release governance reads rulesets with a dedicated admin-visible token", async () => {
  for (const path of [".github/workflows/build-release.yml", ".github/workflows/terraform-deploy.yml"]) {
    const workflow = await read(path);
    const step = workflow.slice(workflow.indexOf("verify effective release governance"),
      workflow.indexOf("release-governance.mjs"));
    assert.match(step, /github_token:\s*\$\{\{ secrets\.release_governance_token \}\}/, path);
    assert.doesNotMatch(step, /secrets\.github_token/, path);
    assert.equal(workflow.match(/secrets\.release_governance_token/g)?.length, 1, path);
  }
  const environments = await read("docs/GITHUB_ENVIRONMENTS.md");
  assert.match(environments, /`release_governance_token`/);
  assert.match(environments, /administration: read and write/);
});

test("frontend ci runs with a read-only default token", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(workflow, /:\s*write\b/);
});

test("frontend ci parallelizes independent gates behind the stable aggregate check", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  for (const job of ["quality", "terraform", "build", "e2e", "frontend"]) {
    assert.match(workflow, new RegExp(`\\n  ${job}:\\n`), job);
  }

  const start = workflow.indexOf("\n  frontend:\n");
  const end = workflow.indexOf("\n  container:\n", start);
  assert.ok(start > 0 && end > start);
  const frontend = workflow.slice(start, end);
  assert.match(frontend, /needs:\s*\[quality, terraform, build, e2e\]/);
  assert.match(frontend, /if:\s*always\(\)/);
  for (const job of ["quality", "terraform", "build", "e2e"]) {
    assert.match(frontend, new RegExp(`needs\\.${job}\\.result`), job);
  }

  // The fan-out is a runtime optimization only: every original blocking family remains present.
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /terraform fmt -check -recursive infra\/terraform/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run test:e2e/);
  assert.match(workflow, /npm audit --audit-level=high/);
});

test("dev deploys never run production-like runtime secret or migration steps", async () => {
  const workflow = await read(".github/workflows/terraform-deploy.yml");
  for (const name of ["require enabled postgres runtime secret", "install migration runtime",
    "apply versioned postgres migrations", "upload migration evidence"]) {
    const start = workflow.indexOf(`name: ${name}`);
    assert.ok(start > 0, name);
    const guard = workflow.slice(start).match(/\n\s*if: ([^\n]+)/)?.[1] ?? "";
    assert.match(guard, /inputs\.environment != 'dev'/, name);
  }
});

test("security acceptance control-evidence jobs install the pg runtime before collecting", async () => {
  const workflow = await read(".github/workflows/security-acceptance.yml");
  for (const job of ["edge", "postgres-rls", "control-loop"]) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start > 0, job);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
    const body = next < 0 ? rest : rest.slice(0, next + 1);
    assert.match(body, /cache:\s*npm/, job);
    const install = body.indexOf("npm ci --ignore-scripts");
    const collect = body.indexOf("node scripts/collect-control-evidence.ts");
    assert.ok(install > 0 && collect > install, job);
  }
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
  assert.match(workflow, /controlloopimage/);
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
