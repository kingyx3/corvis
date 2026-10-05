import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("release build is main-only, keyless, digest-addressed, SBOM-backed and attested", async () => {
  const workflow = await read(".github/workflows/build-release.yml");

  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /google-github-actions\/auth@[0-9a-f]{40}\s+# v3/);
  assert.match(workflow, /workload_identity_provider/);
  assert.match(workflow, /git-\$\{github_sha\}/);
  assert.match(workflow, /image_summary\.digest/);
  assert.match(workflow, /provenance:\s*mode=max/);
  assert.match(workflow, /sbom:\s*true/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /push-to-registry:\s*true/);
  assert.doesNotMatch(workflow, /service-account.*json|google_application_credentials/);
  assert.match(workflow, /token_format:\s*access_token/);
  assert.match(workflow, /docker\/login-action@[0-9a-f]{40}\s+# v4/);
  assert.match(workflow, /username:\s*oauth2accesstoken/);
  assert.match(workflow, /password:\s*\$\{\{ steps\.gcp_auth\.outputs\.access_token \}\}/);
  assert.match(workflow, /registry:\s*\$\{\{ env\.gcp_region \}\}-docker\.pkg\.dev/);
  assert.doesNotMatch(workflow, /gcloud auth configure-docker/);
});

test("release governance uses an app-backed credential and rejects PAT semantics", async () => {
  for (const path of [".github/workflows/build-release.yml", ".github/workflows/terraform-deploy.yml"]) {
    const workflow = await read(path);
    const step = workflow.slice(workflow.indexOf("verify effective release governance"), workflow.indexOf("release-governance.mjs"));
    assert.match(step, /github_token:\s*\$\{\{ secrets\.release_governance_token \}\}/, path);
    assert.doesNotMatch(step, /secrets\.github_token/, path);
    assert.equal(workflow.match(/secrets\.release_governance_token/g)?.length, 1, path);
  }
  const verifier = await read("tools/ci/release-governance.mjs");
  assert.match(verifier, /long-lived pats are refused/);
  assert.match(verifier, /app\/installations/);
  assert.match(verifier, /administration:\s*'write'/);
  const governance = await read("docs/operations/RELEASE_GOVERNANCE.md");
  assert.match(governance, /must not contain a pat/);
  assert.match(governance, /deployment branches\/tags restricted to `main` only/);
  assert.match(governance, /required reviewers/);
});

test("frontend ci runs with a read-only default token", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(workflow, /:\s*write\b/);
});

test("frontend ci parallelizes independent gates behind the stable aggregate check", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  for (const job of ["quality", "dockerfile-lint", "terraform", "build", "e2e", "non-demo", "frontend"]) {
    assert.match(workflow, new RegExp(`\\n  ${job}:\\n`), job);
  }
  const start = workflow.indexOf("\n  frontend:\n");
  const end = workflow.indexOf("\n  container:\n", start);
  assert.ok(start > 0 && end > start);
  const frontend = workflow.slice(start, end);
  assert.match(frontend, /needs:\s*\[quality, dockerfile-lint, terraform, build, e2e, non-demo\]/);
  assert.match(frontend, /if:\s*always\(\)/);
  for (const job of ["quality", "dockerfile-lint", "terraform", "build", "e2e", "non-demo"]) {
    assert.match(frontend, new RegExp(`needs\\.${job}\\.result`), job);
  }
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /terraform fmt -check -recursive infra\/terraform/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run test:e2e/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
});

test("dev deploys never run production-like runtime secret or migration steps", async () => {
  const workflow = await read(".github/workflows/terraform-deploy.yml");
  for (const name of ["require enabled postgres runtime secret", "install migration runtime", "apply versioned postgres migrations", "upload migration evidence"]) {
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
    const collect = body.indexOf("node tools/dev/collect-control-evidence.ts");
    assert.ok(install > 0 && collect > install, job);
  }
});

test("terraform deploy checks out the exact release and gates apply on the reviewed plan digest", async () => {
  const workflow = await read(".github/workflows/terraform-deploy.yml");
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.release_sha != '' && inputs\.release_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /assert release matches deployment checkout/);
  assert.match(workflow, /approved_plan_sha256/);
  assert.match(workflow, /sha256sum .*tfplan\.txt/);
  assert.match(workflow, /terraform plan changed after review; refusing apply/);
  assert.match(workflow, /terraform apply exact reviewed plan/);
  assert.match(workflow, /apply -lock-timeout=5m -auto-approve tfplan/);
  const migration = workflow.slice(workflow.indexOf("name: apply versioned postgres migrations"), workflow.indexOf("name: upload migration evidence"));
  assert.match(migration, /inputs\.rollback_known_good != true/);
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

test("production registry tags are immutable and deploy never moves prod cleanup pointers", async () => {
  const foundation = await read("infra/terraform/modules/gcp-foundation/main.tf");
  const deploy = await read(".github/workflows/terraform-deploy.yml");
  assert.match(foundation, /docker_config\s*\{[\s\S]*immutable_tags\s*=\s*var\.environment == "prod"/);
  assert.match(foundation, /for_each\s*=\s*var\.environment == "prod" \? \[\] : \[1\]/);
  assert.match(deploy, /protect active release images from registry cleanup/);
  const protect = deploy.slice(deploy.indexOf("protect active release images from registry cleanup"));
  assert.match(protect, /inputs\.environment != 'prod'/);
});

test("known-good advances after live acceptance, then binds the exact source SHA and AI digests", async () => {
  const acceptance = await read(".github/workflows/security-acceptance.yml");
  const augment = await read(".github/workflows/augment-known-good-ai.yml");
  const promotion = await read(".github/workflows/promote-environment.yml");

  assert.match(acceptance, /record-known-good-release/);
  assert.match(acceptance, /needs:\s*\[edge, postgres-rls, control-loop\]/);
  assert.match(acceptance, /if:\s*\$\{\{ success\(\) \}\}/);
  assert.match(acceptance, /spec\.template\.spec\.containers\.image/);
  assert.match(acceptance, /releases\/\$\{\{ inputs\.environment \}\}\/known-good\.json/);
  assert.match(acceptance, /corvis\.known-good-release\.v2/);
  assert.match(acceptance, /control-loop-runtime-acceptance/);
  assert.match(acceptance, /controlloopimage/);

  assert.match(augment, /release_sha:/);
  assert.match(augment, /corvis\.known-good-release\.v4/);
  assert.match(augment, /\.sourcesha=\$sourcesha/);
  assert.match(augment, /expected_api_image/);
  assert.match(augment, /expected_control_loop_image/);
  assert.match(promotion, /release_sha:\s*\$\{\{ inputs\.release_sha \}\}/);
  assert.match(promotion, /uses:\s*\.\/\.github\/workflows\/augment-known-good-ai\.yml/);
});

test("deployment docs keep the release set derived and known-good state acceptance-gated", async () => {
  const environments = await read("docs/operations/GITHUB_ENVIRONMENTS.md");
  const deployment = await read("docs/operations/DEPLOYMENT.md");
  assert.match(environments, /`api_image`, `extractor_image`, and `litellm_image` are not human-managed github environment variables/);
  assert.match(environments, /remove or avoid creating/);
  assert.match(environments, /derives runtime images from a reviewed `main` release/);
  assert.match(deployment, /a built image set is not known-good until live acceptance passes/);
  assert.match(deployment, /only a fully successful acceptance run writes/);
  assert.match(deployment, /known-good\.json/);
  assert.match(deployment, /failed or incomplete acceptance never advances known-good/);
  assert.match(deployment, /accepted api\/worker image and accepted control-loop image/);
});
