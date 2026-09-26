import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { isLongRunningZeroDiscovery, listDocumentLifecycles, listSourceActivity, plainAcquisitionReason } from "./source-lifecycle.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";
const DOCUMENT = "00000000-0000-0000-0000-0000000000d1";
const CONNECTION = "00000000-0000-0000-0000-0000000000c1";
const RUN = "00000000-0000-0000-0000-0000000000e1";

const identity: RequestIdentity = {
  subject: "admin@example.test", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["admin"], authMethod: "oidc", sessionId: "session-1",
  entitlements: { workspaceIds: [WORKSPACE], fundIds: ["fund-1"], documentIds: [DOCUMENT], sourceDocumentAccessAllowed: true },
};

class LifecycleDb implements PostgresSqlApi {
  readonly calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    if (sql.includes("from corvis_source.document d")) return [{
      document_id: DOCUMENT, created_by: "uploader@example.test", created_at: "2026-09-01T10:00:00Z",
      acquisition_id: "acq-current", source_connection_id: CONNECTION, run_id: RUN, provider_key: "gp-portal",
      remote_document_id: "remote-report", remote_version: "v2", remote_path: "/Fund/Q2.pdf", acquired_at: "2026-09-02T10:00:00Z",
      connection_label: "GP reporting portal",
    }];
    if (sql.includes("with current_origin as")) return [
      { current_document_id: DOCUMENT, acquisition_id: "acq-current", document_id: DOCUMENT, document_artifact_version_id: "artifact-v2", remote_version: "v2", acquired_at: "2026-09-02T10:00:00Z", disposition: "accepted" },
      { current_document_id: DOCUMENT, acquisition_id: "acq-prior", document_id: "00000000-0000-0000-0000-0000000000d0", document_artifact_version_id: "artifact-v1", remote_version: "v1", acquired_at: "2026-06-02T10:00:00Z", disposition: "accepted" },
    ];
    if (sql.includes("from corvis_source.document_artifact_version")) return [];
    if (sql.includes("from corvis_serving.observations o")) return [{
      document_id: DOCUMENT, observation_id: "obs-1", source_reference_id: "src-1", company_name: "Portfolio Co", metric_code: "revenue", period: "Q2 2026", review_state: "approved",
    }];
    if (sql.includes("from corvis_source.source_connection\n")) return [{
      source_connection_id: CONNECTION, provider_key: "gp-portal", connection_label: "GP reporting portal", status: "reauthorization_required",
      consecutive_failures: 3, last_success_at: "2026-09-01T00:00:00Z", last_attempt_at: "2026-09-26T00:00:00Z",
    }];
    if (sql.includes("from corvis_source.source_connection_run r")) return [{
      run_id: RUN, source_connection_id: CONNECTION, trigger: "scheduled", state: "running", attempt: 3, max_attempts: 5,
      discovered_count: 0, accepted_count: 0, duplicate_count: 0, rejected_count: 0, started_at: "2026-09-26T00:00:00Z",
    }];
    if (sql.includes("from corvis_source.acquired_document a")) return [{
      acquisition_id: "acq-dup", run_id: RUN, disposition: "duplicate", remote_path: "/Fund/Q1.pdf", remote_version: "v1",
      acquired_at: "2026-09-26T00:01:00Z", rejection_reason: "already_acquired",
    }];
    return [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("document lifecycle exposes entitled connector provenance, source versions and reverse fact lineage", async () => {
  const db = new LifecycleDb();
  const lifecycle = await listDocumentLifecycles(identity, db);
  assert.equal(lifecycle.length, 1);
  assert.deepEqual(lifecycle[0]?.origin, {
    kind: "connector", providerKey: "gp-portal", connectionLabel: "GP reporting portal", sourceConnectionId: CONNECTION,
    runId: RUN, acquisitionId: "acq-current", acquiredAt: "2026-09-02T10:00:00Z", remotePath: "/Fund/Q2.pdf",
    remoteDocumentId: "remote-report", remoteVersion: "v2",
  });
  assert.equal(lifecycle[0]?.versions.length, 2);
  assert.equal(lifecycle[0]?.versions[0]?.current, true);
  assert.equal(lifecycle[0]?.versions[1]?.current, false);
  assert.deepEqual(lifecycle[0]?.facts[0], {
    observationId: "obs-1", sourceReferenceId: "src-1", company: "Portfolio Co", metric: "revenue", period: "Q2 2026", state: "Approved",
  });
  for (const call of db.calls.filter((item) => item.sql.includes("document_id"))) {
    assert.ok(call.parameters.some((value) => String(value).includes(DOCUMENT)), "document reads must carry the entitled document allowlist");
  }
});

test("source activity is workspace scoped, flags long-running zero discovery and keeps duplicate evidence human-readable", async () => {
  const db = new LifecycleDb();
  const activity = await listSourceActivity(identity, db, new Date("2026-09-26T00:16:00Z"));
  assert.equal(activity.length, 1);
  assert.equal(activity[0]?.needsAttention, true);
  assert.match(activity[0]?.attentionReason ?? "", /authorization/i);
  assert.equal(activity[0]?.runs[0]?.zeroDiscoveryLongRunning, true);
  assert.deepEqual(activity[0]?.runs[0]?.acquisitions[0], {
    acquisitionId: "acq-dup", disposition: "duplicate", remotePath: "/Fund/Q1.pdf", remoteVersion: "v1",
    acquiredAt: "2026-09-26T00:01:00Z", documentId: undefined,
    reason: "Already acquired unchanged; no duplicate document was created.",
  });
  const scopedCalls = db.calls.filter((item) => item.sql.includes("source_connection"));
  assert.ok(scopedCalls.length >= 3);
  assert.ok(scopedCalls.every((call) => call.parameters[0] === TENANT && call.parameters[1] === WORKSPACE), "connector activity must be tenant + workspace scoped");
});

test("zero-discovery warning only applies to running runs after the threshold", () => {
  const now = new Date("2026-09-26T00:15:00Z");
  assert.equal(isLongRunningZeroDiscovery("running", 0, "2026-09-26T00:00:00Z", now), true);
  assert.equal(isLongRunningZeroDiscovery("running", 1, "2026-09-26T00:00:00Z", now), false);
  assert.equal(isLongRunningZeroDiscovery("succeeded", 0, "2026-09-26T00:00:00Z", now), false);
  assert.equal(isLongRunningZeroDiscovery("running", 0, "2026-09-26T00:01:00Z", now), false);
});

test("plain acquisition reasons never echo arbitrary provider errors", () => {
  assert.equal(plainAcquisitionReason("duplicate", "token=super-secret"), "Already acquired unchanged; no duplicate document was created.");
  assert.equal(plainAcquisitionReason("rejected", "token=super-secret"), "The document was rejected before entering the processing lifecycle.");
  assert.equal(plainAcquisitionReason("rejected", "download timeout: token=super-secret"), "The provider document could not be downloaded.");
});

test("migration 060 preserves run-level duplicate audit evidence without weakening ingestion idempotency", async () => {
  const sql = (await readFile("db/postgres/migrations/060_connector_acquisition_history.sql", "utf8")).toLowerCase();
  assert.match(sql, /drop constraint if exists acquired_document_tenant_id_source_connection_id_acquisition_key_key/);
  assert.match(sql, /create unique index acquired_document_run_outcome_unique_idx[\s\S]*tenant_id, source_connection_id, run_id, acquisition_key, disposition/);
});
