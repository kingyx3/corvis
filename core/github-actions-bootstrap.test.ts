import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/gcp-bootstrap.yml", "utf8");
const stateLifecycle = readFileSync(".github/scripts/terraform-state.sh", "utf8");
const docs = readFileSync("docs/GCP_BOOTSTRAP.md", "utf8");

test("GCP bootstrap remains keyless and environment scoped", () => {
  assert.match(workflow, /environment: \$\{\{ inputs\.environment \}\}/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /google-github-actions\/auth@v3/);
  assert.match(workflow, /workload_identity_provider: \$\{\{ env\.GCP_WIF_PROVIDER \}\}/);
  assert.match(workflow, /service_account: \$\{\{ env\.GCP_DEPLOY_SERVICE_ACCOUNT \}\}/);
  assert.doesNotMatch(workflow, /credentials_json/);
  assert.doesNotMatch(workflow, /secrets\.GCP_/);
});

test("bootstrap cannot activate runtime or Cloudflare accidentally", () => {
  assert.match(workflow, /TF_VAR_api_image: ""/);
  assert.match(workflow, /TF_VAR_cloudflare_zone_name: ""/);
  assert.match(workflow, /TF_VAR_enable_cloudflare_managed_waf: "false"/);
  assert.match(workflow, /Bootstrap apply is allowed only from main\./);
});

test("bootstrap uses the same Terraform roots and protected remote state contract", () => {
  assert.match(workflow, /TF_ROOT: infra\/terraform\/environments\/\$\{\{ inputs\.environment \}\}/);
  assert.match(workflow, /TF_STATE_BUCKET: \$\{\{ format\('\{0\}-corvis-tf-state'/);
  assert.match(workflow, /terraform-state\.sh ensure/);
  assert.match(stateLifecycle, /--public-access-prevention/);
  assert.match(stateLifecycle, /--uniform-bucket-level-access/);
  assert.match(stateLifecycle, /--versioning/);
  assert.match(workflow, /terraform -chdir="\$\{TF_ROOT\}" plan/);
  assert.match(workflow, /terraform -chdir="\$\{TF_ROOT\}" apply/);
});

test("operator documentation keeps the zero-credential trust boundary explicit", () => {
  assert.match(docs, /No local `gcloud` is required/);
  assert.match(docs, /cannot securely create its own first GCP trust relationship/);
  assert.match(docs, /service-account JSON key/);
  assert.match(docs, /Bootstrap GCP foundation/);
});
