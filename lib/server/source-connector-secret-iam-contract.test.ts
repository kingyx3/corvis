import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * GcpSecretManagerSecretStore (lib/server/source-connector-runtime.ts) needs
 * to create, add versions to, read and delete secrets under Secret Manager --
 * per-secret IAM (like the Postgres DSN grants in the same file) cannot
 * express that, because the secret does not exist yet at apply time; only a
 * project-level grant can. This proves that grant exists, is scoped to the
 * corvis-src- naming convention `sourceConnectorSecretReference()` enforces
 * (never project-wide admin), and is given only to the API service account
 * that actually calls the store (never the worker, which never touches
 * source-connector secrets).
 */
test("the API identity may manage only corvis-src- source-connector secrets, never every project secret", async () => {
  const runtime = await read("infra/terraform/modules/cloud-run-runtime/main.tf");

  const grant = runtime.match(/resource "google_project_iam_member" "api_source_connector_secrets" \{[\s\S]*?\n\}\n/);
  assert.ok(grant, "expected a google_project_iam_member.api_source_connector_secrets grant");
  const block = grant![0];

  assert.match(block, /member\s*=\s*"serviceAccount:\$\{var\.api_service_account_email\}"/);
  assert.doesNotMatch(block, /worker_service_account_email/);
  assert.match(block, /role\s*=\s*"roles\/secretmanager\.admin"/);

  const condition = block.match(/condition\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(condition, "the admin grant must carry a scoping IAM condition, not be unconditional");
  assert.match(condition![0], /resource\.type == \\"secretmanager\.googleapis\.com\/Secret\\"/);
  assert.match(condition![0], /resource\.name\.startsWith\(\\"projects\/\$\{var\.project_id\}\/secrets\/corvis-src-\\"\)/);

  // The naming convention the condition depends on: sourceConnectorSecretReference
  // must actually build every reference under this same "corvis-src-" prefix,
  // or the IAM condition would silently deny every real call.
  const runtimeTs = await read("lib/server/source-connector-runtime.ts");
  assert.match(runtimeTs, /`projects\/\$\{projectId\}\/secrets\/corvis-src-\$\{tenantId\}-\$\{slug\}\$\{suffix\}`/);
});

/**
 * A worker delivery whose event turns out to be genuinely, permanently
 * unprocessable (not the fabricated-event case migration 050 rejects, but a
 * real event that keeps failing) must not retry forever with no trace. Both
 * transports already bound retries and, for Pub/Sub, land the exhausted
 * message on a durable, inspectable dead-letter subscription rather than
 * silently dropping it.
 */
test("both transports bound poison-message retries, and Pub/Sub's exhausted deliveries land on a durable, inspectable dead letter", async () => {
  const foundation = await read("infra/terraform/modules/gcp-foundation/main.tf");
  const runtime = await read("infra/terraform/modules/cloud-run-runtime/main.tf");

  // Cloud Tasks: bounded attempts and total retry window, so a poison task is
  // eventually abandoned rather than redelivered indefinitely.
  const queue = foundation.match(/resource "google_cloud_tasks_queue" "processing" \{[\s\S]*?\n\}\n/);
  assert.ok(queue, "expected the processing Cloud Tasks queue");
  assert.match(queue![0], /max_attempts\s*=\s*8/);
  assert.match(queue![0], /max_retry_duration\s*=\s*"3600s"/);

  // Pub/Sub push subscription to the worker: bounded delivery attempts, and a
  // dead-letter topic/subscription pair to land on, not silent loss.
  const pushSubscription = runtime.match(/resource "google_pubsub_subscription" "processing_worker" \{[\s\S]*?\n\}\n/);
  assert.ok(pushSubscription, "expected the processing_worker push subscription");
  const deadLetterPolicy = pushSubscription![0].match(/dead_letter_policy\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(deadLetterPolicy, "the push subscription must carry a dead_letter_policy");
  assert.match(deadLetterPolicy![0], /max_delivery_attempts\s*=\s*8/);

  assert.match(foundation, /resource "google_pubsub_topic" "processing_dead_letter"/);
  const deadLetterSubscription = foundation.match(/resource "google_pubsub_subscription" "processing_dead_letter" \{[\s\S]*?\n\}\n/);
  assert.ok(deadLetterSubscription, "expected a durable subscription on the dead-letter topic so exhausted deliveries stay inspectable/replayable");
  // A pull subscription with no ack-deadline-driven expiry and a real
  // retention window, not a fire-and-forget topic nothing ever reads.
  assert.match(deadLetterSubscription![0], /message_retention_duration\s*=\s*"604800s"/);
  assert.match(deadLetterSubscription![0], /expiration_policy\s*\{\s*ttl\s*=\s*""\s*\}/);
});
