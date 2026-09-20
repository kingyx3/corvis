import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("bootstrap exclusively owns remote Terraform state creation and recovery", async () => {
  const bootstrap = await read(".github/workflows/gcp-bootstrap.yml");
  const deploy = await read(".github/workflows/terraform-deploy.yml");
  const state = await read(".github/scripts/terraform-state.sh");

  assert.match(bootstrap, /terraform-state\.sh ensure/);
  assert.match(bootstrap, /terraform-kms-state\.sh adopt/);
  assert.match(deploy, /terraform-state\.sh require/);
  assert.doesNotMatch(deploy, /terraform-state\.sh ensure|storage buckets create/);

  assert.match(state, /--versioning/);
  assert.match(state, /--public-access-prevention/);
  assert.match(state, /--soft-delete-duration=0/);
  assert.match(state, /"dayssincenoncurrenttime": 30/);
  assert.match(state, /"numnewerversions": 20/);
});

test("idle and full teardown are separate guarded lifecycle operations", async () => {
  const workflow = await read(".github/workflows/gcp-decommission.yml");

  assert.match(workflow, /options: \[idle, full\]/);
  assert.match(workflow, /idle \$\{\{ inputs\.environment \}\}/);
  assert.match(workflow, /decommission \$\{\{ inputs\.environment \}\} delete data and state/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /tf_var_decommission_mode: "true"/);
  assert.match(workflow, /tf_var_api_image=""/);
  assert.match(workflow, /terraform-state\.sh require/);
});

test("full teardown destroys managed resources before deleting remote state and preserves recoverable KMS anchors", async () => {
  const workflow = await read(".github/workflows/gcp-decommission.yml");
  const kms = await read(".github/scripts/terraform-kms-state.sh");

  const detachKey = workflow.indexOf("state rm module.foundation.google_kms_crypto_key.source");
  const destroy = workflow.indexOf(" destroy -lock-timeout=5m -auto-approve");
  const verifyEmpty = workflow.indexOf("terraform state is not empty after full destroy");
  const hibernate = workflow.indexOf("terraform-kms-state.sh hibernate");
  const deleteState = workflow.indexOf("gcloud storage rm --recursive");

  assert.ok(detachKey >= 0);
  assert.ok(destroy > detachKey);
  assert.ok(verifyEmpty > destroy);
  assert.ok(hibernate > verifyEmpty);
  assert.ok(deleteState > hibernate);

  assert.match(kms, /--remove-rotation-schedule/);
  assert.match(kms, /keys versions disable/);
  assert.match(kms, /keyring_address="module\.foundation\.google_kms_key_ring\.corvis"/);
  assert.match(kms, /key_address="module\.foundation\.google_kms_crypto_key\.source"/);
  assert.match(kms, /import "\$\{keyring_address\}" "\$\{keyring_id\}"/);
  assert.match(kms, /import "\$\{key_address\}" "\$\{key_id\}"/);
});

test("full teardown is resumable without recreating an environment after state is already empty", async () => {
  const workflow = await read(".github/workflows/gcp-decommission.yml");

  assert.match(workflow, /has_resources=false/);
  assert.match(workflow, /repair retained kms state after a partial full teardown/);
  assert.match(workflow, /if: steps\.managed_state\.outputs\.has_resources == 'true'/);
  assert.match(workflow, /managed state is already empty; apply will not recreate resources/);
  assert.match(workflow, /verify full decommission state is empty/);
});

test("destructive Terraform behavior defaults off outside the guarded lifecycle workflow", async () => {
  const foundation = await read("infra/terraform/modules/gcp-foundation/main.tf");
  const foundationVars = await read("infra/terraform/modules/gcp-foundation/variables.tf");
  const runtime = await read("infra/terraform/modules/cloud-run-runtime/main.tf");
  const runtimeVars = await read("infra/terraform/modules/cloud-run-runtime/variables.tf");
  const deploy = await read(".github/workflows/terraform-deploy.yml");
  const bootstrap = await read(".github/workflows/gcp-bootstrap.yml");

  assert.match(foundation, /force_destroy\s*=\s*var\.decommission_mode/);
  assert.match(runtime, /deletion_protection\s*=\s*var\.environment == "prod" && !var\.decommission_mode/);
  assert.match(foundationVars, /variable "decommission_mode"[\s\S]*?default\s*=\s*false/);
  assert.match(runtimeVars, /variable "decommission_mode"[\s\S]*?default\s*=\s*false/);
  assert.match(deploy, /tf_var_decommission_mode: "false"/);
  assert.match(bootstrap, /tf_var_decommission_mode: "false"/);
});
