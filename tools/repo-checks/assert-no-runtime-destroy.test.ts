import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(process.cwd(), "tools/ci/assert-no-runtime-destroy.sh");

function plan(actionsByAddress: Record<string, string[]>): string {
  return JSON.stringify({
    format_version: "1.2",
    resource_changes: Object.entries(actionsByAddress).map(([address, actions]) => ({
      address,
      mode: "managed",
      change: { actions },
    })),
  });
}

function run(planJson: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "no-destroy-"));
  try {
    const file = join(dir, "plan.json");
    writeFileSync(file, planJson);
    const result = spawnSync("bash", [script, file], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("plans that only create, update, read or no-op pass", () => {
  const result = run(
    plan({
      "module.a.google_storage_bucket.x": ["create"],
      "module.a.google_project_service.y": ["update"],
      "module.a.google_pubsub_topic.z": ["no-op"],
      "module.a.data.thing": ["read"],
    }),
    { CORVIS_ENVIRONMENT: "prod" },
  );
  assert.equal(result.status, 0, result.output);
});

test("an empty plan without resource_changes passes", () => {
  assert.equal(run("{}").status, 0);
});

test("delete fails and lists the destroyed addresses", () => {
  const result = run(
    plan({
      "module.runtime.google_cloud_run_v2_service.api": ["delete"],
      "module.edge.cloudflare_record.api": ["delete"],
      "module.a.google_storage_bucket.x": ["no-op"],
    }),
    { CORVIS_ENVIRONMENT: "uat" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /module\.runtime\.google_cloud_run_v2_service\.api \(delete\)/);
  assert.match(result.output, /module\.edge\.cloudflare_record\.api \(delete\)/);
  assert.doesNotMatch(result.output, /google_storage_bucket\.x/);
});

test("replace (delete+create in either order) fails", () => {
  for (const actions of [
    ["delete", "create"],
    ["create", "delete"],
  ]) {
    const result = run(plan({ "module.runtime.google_cloud_scheduler_job.loop": actions }), {
      CORVIS_ENVIRONMENT: "dev",
    });
    assert.notEqual(result.status, 0, actions.join(","));
    assert.match(result.output, /google_cloud_scheduler_job\.loop/);
  }
});

test("malformed or missing plan documents fail closed", () => {
  assert.notEqual(run("not json").status, 0);
  assert.notEqual(run("[]").status, 0);
  const missing = spawnSync("bash", [script, "/nonexistent/plan.json"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
});

test("allow_destroy acknowledges destroys in dev and uat only", () => {
  const destroying = plan({ "module.runtime.google_cloud_run_v2_service.api": ["delete"] });
  for (const environment of ["dev", "uat"]) {
    const result = run(destroying, { CORVIS_ENVIRONMENT: environment, ALLOW_DESTROY: "true" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /google_cloud_run_v2_service\.api/);
  }
  const prod = run(destroying, { CORVIS_ENVIRONMENT: "prod", ALLOW_DESTROY: "true" });
  assert.notEqual(prod.status, 0);
  assert.match(prod.output, /refused/);
  // Refused for prod even when the plan is clean, so the flag can never be normalised there.
  assert.notEqual(run("{}", { CORVIS_ENVIRONMENT: "prod", ALLOW_DESTROY: "true" }).status, 0);
  // Unknown/unset environment fails closed.
  assert.notEqual(run(destroying, { ALLOW_DESTROY: "true" }).status, 0);
  // Anything other than the literal "true" is not an escape hatch.
  assert.notEqual(run(destroying, { CORVIS_ENVIRONMENT: "uat", ALLOW_DESTROY: "yes" }).status, 0);
});

test("bootstrap workflow runs the guard after plan and before apply in the shared terraform group", () => {
  const workflow = readFileSync(".github/workflows/gcp-bootstrap.yml", "utf8");
  assert.match(workflow, /group: terraform-\$\{\{ inputs\.environment \}\}\n\s+cancel-in-progress: false/);
  assert.match(workflow, /allow_destroy:[\s\S]*?type: boolean[\s\S]*?default: false/);
  assert.match(workflow, /ALLOW_DESTROY: \$\{\{ inputs\.allow_destroy \}\}/);
  const plan = workflow.indexOf("-out=bootstrap.tfplan");
  const show = workflow.indexOf("show -json bootstrap.tfplan");
  const guard = workflow.indexOf("assert-no-runtime-destroy.sh");
  const apply = workflow.indexOf("apply -lock-timeout=5m -auto-approve bootstrap.tfplan");
  assert.ok(plan >= 0 && show > plan && guard > show && apply > guard);
  assert.match(workflow, /allow_destroy is refused for prod/);
});
