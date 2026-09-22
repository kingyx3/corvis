import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return (await readFile(path, "utf8")).toLowerCase();
}

test("upload control plane emits the latency metric named by the SLO", async () => {
  const route = await read("app/api/v1/uploads/initiate/route.ts");
  const terraform = await read("infra/terraform/modules/gcp-observability/application-slo.tf");
  const slos = await read("ops/slos.yaml");

  assert.match(route, /durationmetric\("upload\.initiation"/);
  assert.match(route, /outcome:\s*"success"/);
  assert.match(route, /outcome:\s*"failure"/);
  assert.match(terraform, /jsonpayload\.metric="upload\.initiation"/);
  assert.match(terraform, /align_percentile_95/);
  assert.match(terraform, /threshold_value\s*=\s*500/);
  assert.match(slos, /upload_initiation_latency_p95_ms > 500 for 10m/);
});

test("lineage monitoring reflects the fail-closed publication gate", async () => {
  const policy = await read("lib/server/publication-policy.ts");
  const http = await read("lib/server/http.ts");
  const terraform = await read("infra/terraform/modules/gcp-observability/application-slo.tf");
  const slos = await read("ops/slos.yaml");

  assert.match(policy, /lineagecoverage < 1/);
  assert.match(policy, /incomplete_source_lineage/);
  assert.match(http, /snapshot\.publication_blocked/);
  assert.match(terraform, /jsonpayload\.event="snapshot\.publication_blocked"/);
  assert.match(terraform, /jsonpayload\.reasons="incomplete_source_lineage"/);
  assert.match(slos, /publication_attempt_blocked_by_incomplete_source_lineage == true/);
});

test("generic authorization denials are observable without being mislabeled cross-tenant", async () => {
  const http = await read("lib/server/http.ts");
  const terraform = await read("infra/terraform/modules/gcp-observability/application-slo.tf");

  assert.match(http, /api\.authorization_denied/);
  assert.match(terraform, /google_logging_metric" "authorization_denied/);
  assert.doesNotMatch(terraform, /authorization_denied[\s\S]*cross[-_ ]tenant/);
});

test("successful publication transitions are attributable telemetry events", async () => {
  const route = await read("app/api/v1/snapshots/publish/route.ts");
  assert.match(route, /snapshot\.publication_transition_succeeded/);
  assert.match(route, /publicationeventid/);
  assert.match(route, /actorsubject:\s*identity\.subject/);
});

test("document-pipeline completion telemetry is emitted only after durable stage transitions", async () => {
  const worker = await read("lib/server/processing-stage-worker.ts");
  const publication = await read("lib/server/processing-published-stage.ts");
  const terraform = await read("infra/terraform/modules/gcp-observability/application-slo.tf");
  const slos = await read("ops/slos.yaml");

  assert.match(worker, /await stages\.complete/);
  assert.match(worker, /expectedstage === "registered"[\s\S]*countmetric\("document_pipeline\.accepted"/);
  assert.match(worker, /expectedstage === "published"[\s\S]*countmetric\("document_pipeline\.completed"/);
  assert.match(worker, /nextstate === "dead_letter"[\s\S]*countmetric\("document_pipeline\.dead_letter"/);
  assert.match(publication, /d\.created_at as document_created_at/);
  assert.match(publication, /p\.completed_at as publication_completed_at/);
  assert.match(publication, /durationvaluemetric\("document_pipeline\.publication_freshness"/);

  for (const metric of ["document_pipeline.accepted", "document_pipeline.completed", "document_pipeline.dead_letter"]) {
    assert.ok(terraform.includes(`jsonpayload.metric="${metric}"`), `missing Terraform metric for ${metric}`);
  }
  assert.match(terraform, /jsonpayload\.metric="document_pipeline\.publication_freshness"/);
  assert.match(terraform, /threshold_value\s*=\s*3600000/);
  assert.match(terraform, /align_percentile_95/);
  assert.match(slos, /publication_freshness_p95_minutes > 60 for 10m/);
});

test("export and webhook delivery health uses durable completion/failure ledgers", async () => {
  const delivery = await read("lib/server/delivery.ts");
  const terraform = await read("infra/terraform/modules/gcp-observability/application-slo.tf");

  assert.match(delivery, /export_job[\s\S]*created_at/);
  assert.match(delivery, /state='complete'[\s\S]*completed_at=now\(\)[\s\S]*returning completed_at/);
  assert.match(delivery, /durationvaluemetric\("delivery\.export"/);
  assert.match(delivery, /countmetric\("delivery\.export"[\s\S]*outcome:"complete"/);
  assert.match(delivery, /countmetric\("delivery\.export"[\s\S]*outcome:state/);
  assert.match(delivery, /webhook_delivery[\s\S]*state='complete'[\s\S]*completed_at=now\(\)[\s\S]*returning completed_at/);
  assert.match(delivery, /durationvaluemetric\("delivery\.webhook"/);
  assert.match(delivery, /countmetric\("delivery\.webhook"[\s\S]*outcome:"complete"/);
  assert.match(delivery, /countmetric\("delivery\.webhook"[\s\S]*outcome:state/);

  for (const metric of ["delivery.export", "delivery.webhook"]) {
    assert.ok(terraform.includes(`jsonpayload.metric="${metric}"`), `missing Terraform delivery metric for ${metric}`);
  }
  assert.match(terraform, /jsonpayload\.metric="delivery\.export"[\s\S]*jsonpayload\.outcome="failed"/);
  assert.match(terraform, /jsonpayload\.metric="delivery\.webhook"[\s\S]*jsonpayload\.outcome="failed"/);
});
