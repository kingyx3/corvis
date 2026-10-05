import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * The scheduled /api/internal/delivery drain runs on the worker. It deletes and
 * overwrites objects in the source bucket (lib/server/upload-sweep.ts,
 * lib/server/uploads.ts purgeObject, lib/server/export-delivery.ts
 * deleteExportAttemptArtifacts), which needs storage.objects.delete: Viewer and
 * Creator are not enough, and an unbounded Object User/Admin grant is too much.
 */
test("the worker may mutate only the lifecycle object prefixes of the source bucket", async () => {
  const main = await read("infra/terraform/modules/gcp-foundation/main.tf");

  const grant = main.match(/resource "google_storage_bucket_iam_member" "worker_source_objects" \{[\s\S]*?\n\}\n/);
  assert.ok(grant, "expected google_storage_bucket_iam_member.worker_source_objects");
  const block = grant[0];
  assert.match(block, /bucket\s*=\s*google_storage_bucket\.source\.name/);
  assert.match(block, /role\s*=\s*"roles\/storage\.objectUser"/);
  assert.match(block, /member\s*=\s*"serviceAccount:\$\{google_service_account\.worker\.email\}"/);
  assert.match(block, /condition\s*\{[\s\S]*expression\s*=\s*local\.worker_source_object_condition/);

  const prefixes = main.match(/worker_source_object_prefixes\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(prefixes, "expected the worker prefix allow-list");
  assert.deepEqual(
    [...prefixes[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ["tenant=", "exports/", "_corvis/upload-sessions/", "_corvis/upload-sweep-cursors/"],
  );
  assert.match(main, /startsWith\(\\"projects\/_\/buckets\/\$\{google_storage_bucket\.source\.name\}\/objects\/\$\{prefix\}\\"\)/);

  // Never an unconditional administrative worker grant on the source bucket.
  assert.doesNotMatch(main, /role\s*=\s*"roles\/storage\.(objectAdmin|admin)"[\s\S]{0,120}google_service_account\.worker/);

  // The prefixes must match what the code really writes/deletes.
  const uploads = await read("lib/server/uploads.ts");
  const sweep = await read("lib/server/upload-sweep.ts");
  const exportsSource = await read("lib/server/export-delivery.ts");
  assert.match(uploads, /`tenant=\$\{safeName\(identity\.tenantId\)\}\//);
  assert.match(uploads, /`_corvis\/upload-sessions\/tenant=/);
  assert.match(sweep, /`_corvis\/upload-sweep-cursors\/tenant=/);
  assert.match(sweep, /"_corvis\/upload-sweep-cursors\/_rotation\.json"/);
  assert.match(exportsSource, /`exports\/\$\{input\.tenantId\}\//);
});

test("infrastructure docs no longer describe worker source-bucket access as read-only", async () => {
  const infra = await read("docs/INFRASTRUCTURE.md");
  const hardening = await read("docs/SERVICE_IDENTITY_HARDENING.md");
  assert.doesNotMatch(infra, /Worker access is read-only/);
  assert.match(infra, /roles\/storage\.objectUser/);
  assert.match(hardening, /conditional `roles\/storage\.objectUser`/);
});

test("the delivery route reports an upload sweep with errors as a failed task", async () => {
  const route = await read("app/api/internal/delivery/route.ts");
  assert.match(route, /results\.uploadSweep/);
  assert.match(route, /failed\.push\("uploadSweep"\)/);
});

test("the delivery tick sweeps expired pending-OAuth-attempt secrets on a store with no native expiry", async () => {
  const route = await read("app/api/internal/delivery/route.ts");
  assert.match(route, /sourceSecretSweep:\(\)=>sweepExpiredSourceSecrets\(\)/);
});

test("the delivery tick collects from due source connections and reports a faulted pass as a failed task", async () => {
  const route = await read("app/api/internal/delivery/route.ts");
  assert.match(route, /sourceSync:\(\)=>processDueSourceSyncs\(\)/);
  assert.match(route, /failed\.push\("sourceSync"\)/);
});

test("known-good only advances to the release the promotion accepted", async () => {
  const acceptance = await read(".github/workflows/security-acceptance.yml");
  const deploy = await read(".github/workflows/terraform-deploy.yml");
  const promote = await read(".github/workflows/promote-environment.yml");

  assert.match(deploy, /outputs:\s*\n\s*api_image:[\s\S]*control_loop_image:/);
  assert.match(deploy, /echo "api_image=\$\{api_image\}" >> "\$\{GITHUB_OUTPUT\}"/);
  assert.match(promote, /expected_api_image: \$\{\{ needs\.deploy\.outputs\.api_image \}\}/);
  assert.match(promote, /expected_control_loop_image: \$\{\{ needs\.deploy\.outputs\.control_loop_image \}\}/);
  assert.match(promote, /require_expected_release: true/);

  const record = acceptance.slice(acceptance.indexOf("  record-known-good-release:"));
  const imageCheck = record.indexOf('"${image}" != "${EXPECTED_API_IMAGE}"');
  const loopCheck = record.indexOf('"${control_loop_image}" != "${EXPECTED_CONTROL_LOOP_IMAGE}"');
  const write = record.indexOf("gcloud storage cp known-good.json");
  assert.ok(imageCheck > 0 && loopCheck > 0, "live digests must be compared with the deploy-resolved digests");
  assert.ok(write > imageCheck && write > loopCheck, "digest assertions must precede the manifest write");
  assert.match(record, /REQUIRE_EXPECTED_RELEASE.*== "true"/);
});

test("gcloud describe output is read with the v1 Knative / --raw shapes", async () => {
  const acceptance = await read(".github/workflows/security-acceptance.yml");
  const decommission = await read(".github/workflows/gcp-decommission.yml");
  const hygiene = await read(".github/workflows/gcp-cost-hygiene.yml");

  assert.doesNotMatch(acceptance, /\.template\.template\./);
  assert.match(acceptance, /\.spec\.template\.spec\.template\.spec\.containers\[0\]\.image/);
  assert.match(acceptance, /\.spec\.template\.spec\.template\.spec\.serviceAccountName/);
  assert.match(acceptance, /buckets describe "gs:\/\/\$\{state_bucket\}" --raw --format=json/);
  assert.doesNotMatch(decommission, /value\(template\./);
  assert.match(decommission, /value\(spec\.template\.spec\.containers\[0\]\.image\)/);
  assert.doesNotMatch(hygiene, /value\(template\./);
  assert.match(hygiene, /value\(spec\.template\.spec\.containers\[0\]\.image\)/);
  assert.match(hygiene, /value\(spec\.template\.spec\.template\.spec\.containers\[0\]\.image\)/);
  // Fail closed: an existing runtime whose image cannot be read must stop the run.
  assert.match(hygiene, /exists but its image is not an immutable digest/);
});

test("the public-repo leak guard rejects root-level keys and Terraform variable files", async () => {
  const script = await read(".github/scripts/public-repo-leak-guard.sh");
  const fn = script.match(/^is_forbidden_path\(\) \{[\s\S]*?^\}/m);
  assert.ok(fn, "expected is_forbidden_path()");
  const check = (path: string): boolean => {
    const result = spawnSync("bash", ["-c", `${fn[0]}\nis_forbidden_path "$1"`, "guard", path]);
    return result.status === 0;
  };
  for (const banned of ["id_rsa", "ssh/id_rsa", "id_ed25519", "ssh/id_ed25519", "terraform.tfvars", "infra/prod.auto.tfvars", "infra/x.tfvars.json", ".terraform/providers/x", "infra/.terraform/x"]) {
    assert.equal(check(banned), true, `${banned} must be rejected`);
  }
  for (const allowed of ["id_rsa.pub", "terraform.tfvars.example", ".env.example", "README.md", "infra/terraform/main.tf"]) {
    assert.equal(check(allowed), false, `${allowed} must be allowed`);
  }
});
