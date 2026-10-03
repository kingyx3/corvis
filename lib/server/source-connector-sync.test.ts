import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { OAuthCredentialExpiredError } from "./source-oauth.ts";
import { ConnectorError, runConnectionSync } from "./source-connector-sync.ts";
import { acquisitionKey, type ConnectorDriver, type IngestResult, type IngestSink, type RemoteDocumentRef, type SecretStore } from "./source-connectors.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";
const CONNECTION_ID = "c1";

type ConnectionRow = { status: string; consecutive_failures: number; last_error_class: string | null };

class FakeSyncDb implements PostgresSqlApi {
  connection: ConnectionRow = { status: "active", consecutive_failures: 0, last_error_class: null };
  credentialType: string | undefined;
  readonly runs: PostgresRow[] = [];
  readonly acquisitions: PostgresRow[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("from corvis_source.source_connection where")) {
      return [{
        source_connection_id: CONNECTION_ID, tenant_id: TENANT, workspace_id: WORKSPACE, provider_key: "acme-portal",
        status: this.connection.status, source_scope: [{ label: "Reports" }], secret_reference: "ref",
        ...(this.credentialType ? { credential_type: this.credentialType } : {}),
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

test("an auth- or permission-class download failure fails the connection closed instead of counting as a rejected file", async () => {
  for (const [errorClass, status] of [["auth", "reauthorization_required"], ["permission", "suspended"]] as const) {
    const db = new FakeSyncDb();
    const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
      db, secrets: new FakeSecrets(),
      drivers: new Map([["acme-portal", driver({ download: async () => { throw new ConnectorError(errorClass, "access revoked"); } })]]),
      ingest: new RecordingIngest(),
    });
    assert.equal(outcome.state, "refused", errorClass);
    assert.equal(outcome.errorClass, errorClass);
    assert.equal(db.connection.status, status, errorClass);
    assert.equal(db.connection.consecutive_failures, 1, errorClass);
    assert.equal(db.acquisitions.length, 0, "the credential failure is not recorded as a rejected document");
  }
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

test("a credential resolver hands the run a refreshed credential; one that cannot renew an expired OAuth credential fails the run closed to reauthorization", async () => {
  const db = new FakeSyncDb();
  db.credentialType = "oauth_authorization_code";
  const resolved: unknown[] = [];
  let used: unknown;
  const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), ingest: new RecordingIngest(),
    drivers: new Map([["acme-portal", driver({ discover: async (credential) => { used = credential; return []; } })]]),
    resolveCredential: async (connection, credential) => { resolved.push(connection); return { ...credential, token: "refreshed" }; },
  });
  assert.equal(outcome.state, "succeeded");
  assert.deepEqual(used, { token: "refreshed" }, "the driver only ever sees the resolved credential");
  assert.deepEqual(resolved, [{ sourceConnectionId: CONNECTION_ID, tenantId: TENANT, workspaceId: WORKSPACE, providerKey: "acme-portal", credentialType: "oauth_authorization_code", status: "active", sourceScope: [{ label: "Reports" }], secretReference: "ref", connectorVersion: "1.0.0", consecutiveFailures: 0 }]);

  let driverCalled = false;
  const refused = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
    db, secrets: new FakeSecrets(), ingest: new RecordingIngest(),
    drivers: new Map([["acme-portal", driver({ discover: async () => { driverCalled = true; return []; } })]]),
    resolveCredential: async () => { throw new OAuthCredentialExpiredError(); },
  });
  assert.equal(refused.state, "refused");
  assert.equal(refused.errorClass, "reauthorization");
  assert.equal(driverCalled, false);
  assert.equal(db.connection.status, "reauthorization_required");
});

class StoredShapeDb extends FakeSyncDb {
  row: PostgresRow | null | undefined;
  override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    const rows = await super.query(sql, parameters);
    if (!sql.includes("from corvis_source.source_connection where") || this.row === undefined) return rows;
    return this.row === null ? [] : rows.map((row) => ({ ...row, ...this.row }));
  }
}

test("a run reads the scope and counters however they were stored, and refuses a connection that does not exist", async () => {
  const scopes: Array<[unknown, unknown]> = [
    [JSON.stringify([{ label: "String" }]), [{ label: "String" }]],
    ["{not json", []],
    [JSON.stringify({ label: "not an array" }), []],
    [null, []],
  ];
  for (const [stored, expected] of scopes) {
    const db = new StoredShapeDb();
    db.row = { source_scope: stored as never, consecutive_failures: undefined };
    let seen: unknown;
    const outcome = await runConnectionSync(TENANT, CONNECTION_ID, "scheduled", {
      db, secrets: new FakeSecrets(), ingest: new RecordingIngest(),
      drivers: new Map([["acme-portal", driver({ discover: async (_credential, scope) => { seen = scope; return []; } })]]),
    });
    assert.equal(outcome.state, "succeeded");
    assert.deepEqual(seen, expected);
  }

  const missing = new StoredShapeDb();
  missing.row = null;
  await assert.rejects(runConnectionSync(TENANT, CONNECTION_ID, "scheduled", { db: missing, secrets: new FakeSecrets(), drivers: new Map(), ingest: new RecordingIngest() }), /connection_not_found/);
});
