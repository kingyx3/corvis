import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { ConnectorError, runConnectionSync } from "./source-connector-sync.ts";
import { acquisitionKey, type ConnectorDriver, type IngestResult, type IngestSink, type RemoteDocumentRef, type SecretStore } from "./source-connectors.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";
const CONNECTION_ID = "c1";

type ConnectionRow = { status: string; consecutive_failures: number; last_error_class: string | null };

class FakeSyncDb implements PostgresSqlApi {
  connection: ConnectionRow = { status: "active", consecutive_failures: 0, last_error_class: null };
  readonly runs: PostgresRow[] = [];
  readonly acquisitions: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("from corvis_source.source_connection where")) {
      return [{
        source_connection_id: CONNECTION_ID, tenant_id: TENANT, workspace_id: WORKSPACE, provider_key: "acme-portal",
        status: this.connection.status, source_scope: [{ label: "Reports" }], secret_reference: "ref",
        connector_version: "1.0.0", consecutive_failures: this.connection.consecutive_failures,
      }];
    }
    if (sql.includes("from corvis_source.acquired_document") && sql.includes("acquisition_key=$3")) {
      const key = parameters[2];
      return this.acquisitions.some((row) => row.acquisition_key === key) ? [{ exists: 1 }] : [];
    }
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_source.source_connection_run") && sql.includes("values ($1::uuid,$2::uuid,$3::uuid,$4,'running'")) {
      this.runs.push({ tenant_id: parameters[0], run_id: parameters[1], source_connection_id: parameters[2], trigger: parameters[3], state: "running", attempt: parameters[4] });
      return;
    }
    if (sql.includes("insert into corvis_source.source_connection_run") && sql.includes("'refused'")) {
      this.runs.push({ tenant_id: parameters[0], run_id: parameters[1], source_connection_id: parameters[2], trigger: parameters[3], state: "refused" });
      return;
    }
    if (sql.includes("insert into corvis_source.acquired_document")) {
      this.acquisitions.push({
        tenant_id: parameters[0], source_connection_id: parameters[1], run_id: parameters[2], provider_key: parameters[3],
        remote_document_id: parameters[4], remote_version: parameters[5], remote_path: parameters[6],
        content_sha256: parameters[8], acquisition_key: parameters[9], disposition: parameters[11], rejection_reason: parameters[12],
      });
      return;
    }
    if (sql.includes("update corvis_source.source_connection_run set")) {
      const runId = parameters[1];
      const run = this.runs.find((row) => row.run_id === runId);
      if (run) Object.assign(run, { state: parameters[2] });
      return;
    }
    if (sql.includes("update corvis_source.source_connection set") && sql.includes("consecutive_failures=0")) {
      this.connection.consecutive_failures = 0;
      this.connection.last_error_class = null;
      return;
    }
    if (sql.includes("update corvis_source.source_connection set") && sql.includes("last_error_class=$4")) {
      this.connection.consecutive_failures = Number(parameters[2]);
      this.connection.last_error_class = String(parameters[3]);
      this.connection.status = String(parameters[4]);
      return;
    }
  }
  async health() { return true; }
}

class FakeSecrets implements SecretStore {
  async write(): Promise<string> { return "ref"; }
  async read(): Promise<Record<string, unknown>> { return { token: "secret-value" }; }
  async revoke(): Promise<void> {}
}

class RecordingIngest implements IngestSink {
  readonly calls: { fileName: string; bytes: Buffer }[] = [];
  private readonly result: (input: { fileName: string }) => IngestResult;
  constructor(result: (input: { fileName: string }) => IngestResult = () => ({ accepted: true, documentId: "doc-1", documentArtifactVersionId: "artifact-1" })) {
    this.result = result;
  }
  async ingest(input: { fileName: string; bytes: Buffer }): Promise<IngestResult> {
    this.calls.push({ fileName: input.fileName, bytes: input.bytes });
    return this.result(input);
  }
}

function ref(overrides: Partial<RemoteDocumentRef> = {}): RemoteDocumentRef {
  return { remoteDocumentId: "doc-remote-1", remoteVersion: "v1", remotePath: "/reports/q1.pdf", ...overrides };
}

function driver(overrides: Partial<ConnectorDriver> = {}): ConnectorDriver {
  return {
    providerKey: "acme-portal",
    connectorVersion: "1.0.0",
    testConnection: async () => ({ ok: true }),
    discover: async () => [ref()],
    download: async () => ({ bytes: Buffer.from("pdf-bytes"), contentType: "application/pdf" }),
    ...overrides,
  };
}

test("a paused connection refuses the run before the driver is ever called", async () => {
  const db = new FakeSyncDb();
  db.connection.status = "paused";
  let called = false;
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), drivers: new Map([["acme-portal", driver({ discover: async () => { called = true; return []; } })]]),
    ingest: new RecordingIngest(),
  });
  assert.equal(outcome.state, "refused");
  assert.equal(called, false);
});

test("a revoked connection refuses the run before the driver is ever called", async () => {
  const db = new FakeSyncDb();
  db.connection.status = "revoked";
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), drivers: new Map([["acme-portal", driver()]]), ingest: new RecordingIngest(),
  });
  assert.equal(outcome.state, "refused");
});

test("a successful run discovers, downloads and ingests exactly once per new document", async () => {
  const db = new FakeSyncDb();
  const ingest = new RecordingIngest();
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), drivers: new Map([["acme-portal", driver()]]), ingest,
  });
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.discoveredCount, 1);
  assert.equal(outcome.acceptedCount, 1);
  assert.equal(ingest.calls.length, 1);
  assert.equal(ingest.calls[0]?.fileName, "q1.pdf");
});

test("re-running against the same remote document/version/content is a no-download duplicate, not a re-ingest", async () => {
  const db = new FakeSyncDb();
  const bytes = Buffer.from("pdf-bytes");
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  db.acquisitions.push({ acquisition_key: acquisitionKey("doc-remote-1", "v1", contentSha256) });

  const ingest = new RecordingIngest();
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), drivers: new Map([["acme-portal", driver()]]), ingest,
  });
  assert.equal(outcome.duplicateCount, 1);
  assert.equal(outcome.acceptedCount, 0);
  assert.equal(ingest.calls.length, 0, "a duplicate must never reach the ingest sink");
});

test("a genuine remote content replacement under the same remote id is retained as a new acquisition, not skipped", async () => {
  const db = new FakeSyncDb();
  // Seed a prior acquisition for the SAME remote id/version but DIFFERENT content, so this run's
  // actual content hash produces a different acquisition key and must not be treated as a duplicate.
  db.acquisitions.push({ acquisition_key: acquisitionKey("doc-remote-1", "v1", "0".repeat(64)) });

  const ingest = new RecordingIngest();
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), drivers: new Map([["acme-portal", driver()]]), ingest,
  });
  assert.equal(outcome.duplicateCount, 0);
  assert.equal(outcome.acceptedCount, 1);
});

test("a rejected or quarantined document is recorded but does not abort the run or the connection", async () => {
  const db = new FakeSyncDb();
  const ingest = new RecordingIngest(() => ({ accepted: false, reason: "invalid_signature", quarantined: true }));
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), drivers: new Map([["acme-portal", driver()]]), ingest,
  });
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.rejectedCount, 1);
  assert.equal(db.acquisitions[0]?.disposition, "quarantined");
});

test("a download failure for one document is recorded as rejected and the run still succeeds overall", async () => {
  const db = new FakeSyncDb();
  const ingest = new RecordingIngest();
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(),
    drivers: new Map([["acme-portal", driver({ download: async () => { throw new Error("timed out"); } })]]),
    ingest,
  });
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.rejectedCount, 1);
  assert.equal(ingest.calls.length, 0);
});

test("an auth-class discovery failure fails the connection closed rather than retrying", async () => {
  const db = new FakeSyncDb();
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(),
    drivers: new Map([["acme-portal", driver({ discover: async () => { throw new ConnectorError("auth", "token expired"); } })]]),
    ingest: new RecordingIngest(),
  });
  assert.equal(outcome.state, "refused");
  assert.equal(outcome.errorClass, "auth");
  assert.equal(db.connection.status, "reauthorization_required");
});

test("a network-class discovery failure is retryable and does not suspend the connection on the first attempt", async () => {
  const db = new FakeSyncDb();
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(),
    drivers: new Map([["acme-portal", driver({ discover: async () => { throw new ConnectorError("network", "timeout"); } })]]),
    ingest: new RecordingIngest(),
  });
  assert.equal(outcome.state, "retryable");
  assert.equal(db.connection.status, "active");
});

test("an unregistered provider throws rather than silently doing nothing", async () => {
  const db = new FakeSyncDb();
  await assert.rejects(
    () => runConnectionSync(TENANT, CONNECTION_ID, "scheduled", { db, secrets: new FakeSecrets(), drivers: new Map(), ingest: new RecordingIngest() }),
    /unregistered_provider/,
  );
});

test("credential material read from the secret store is never present in the run outcome", async () => {
  const db = new FakeSyncDb();
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), drivers: new Map([["acme-portal", driver()]]), ingest: new RecordingIngest(),
  });
  assert.equal(JSON.stringify(outcome).includes("secret-value"), false);
});
