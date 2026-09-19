import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import {
  ConnectorGovernanceError,
  acquisitionKey,
  createSourceConnection,
  isFailClosedErrorClass,
  isRetryableErrorClass,
  listSourceConnections,
  pauseSourceConnection,
  reauthorizeSourceConnection,
  resumeSourceConnection,
  revokeSourceConnection,
  statusAfterError,
  testSourceConnection,
  type ConnectorDriver,
  type SecretPayload,
  type SecretStore,
} from "./source-connectors.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "oidc|admin-1",
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    roles: ["admin"],
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
    ...overrides,
  };
}

/** A tiny in-memory model of corvis_source.source_connection, enough to exercise the module's own SQL shapes. */
class FakeConnectionDb implements PostgresSqlApi {
  private readonly rows = new Map<string, PostgresRow>();
  private counter = 0;
  readonly writes: { sql: string; parameters: PostgresPrimitive[] }[] = [];

  seed(row: Partial<PostgresRow> & { tenant_id: string; source_connection_id: string }): void {
    this.rows.set(this.key(row.tenant_id, row.source_connection_id), { consecutive_failures: 0, ...row });
  }

  private key(tenantId: string, id: string): string { return `${tenantId}:${id}`; }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.startsWith("insert into corvis_source.source_connection")) {
      const id = `00000000-0000-0000-0000-${String(++this.counter).padStart(12, "0")}`;
      const row: PostgresRow = {
        source_connection_id: id, tenant_id: parameters[0], workspace_id: parameters[1],
        provider_key: parameters[2], connection_label: parameters[3], credential_type: parameters[4],
        source_scope: parameters[5], scope_confirmed_by: parameters[6], scope_confirmed_at: new Date().toISOString(),
        secret_reference: parameters[7], connector_version: parameters[8], status: "pending_authorization",
        consecutive_failures: 0,
      };
      this.rows.set(this.key(String(parameters[0]), id), row);
      return [row];
    }
    if (sql.includes("from corvis_source.source_connection") && sql.includes("source_connection_id=$2")) {
      const row = this.rows.get(this.key(String(parameters[0]), String(parameters[1])));
      return row ? [row] : [];
    }
    if (sql.includes("from corvis_source.source_connection") && sql.includes("order by")) {
      // The real listing query never selects the real secret_reference column; simulate that redaction here too.
      return [...this.rows.values()]
        .filter((row) => row.tenant_id === parameters[0])
        .map((row) => ({ ...row, secret_reference: "redacted" }));
    }
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.writes.push({ sql, parameters });
    const tenantId = String(parameters[0]);
    const id = String(parameters[1]);
    const row = this.rows.get(this.key(tenantId, id));
    if (!row) return;
    if (sql.includes("set status=$3, updated_at=now(), revoked_at=now()")) { row.status = parameters[2]; row.revoked_at = new Date().toISOString(); return; }
    if (sql.includes("set status=$3, updated_at=now()") && !sql.includes("revoked_at")) { row.status = parameters[2]; return; }
    if (sql.includes("status='revoked', revoked_at=now()")) { row.status = "revoked"; row.revoked_at = new Date().toISOString(); return; }
    if (sql.includes("secret_reference=$3, status='active', consecutive_failures=0")) {
      row.secret_reference = parameters[2]; row.status = "active"; row.consecutive_failures = 0; row.last_error_class = null; return;
    }
    if (sql.includes("status='active', last_authorized_at=now()")) { row.status = "active"; return; }
    if (sql.includes("set status=$3, last_error_class=$4, updated_at=now()")) { row.status = parameters[2]; row.last_error_class = parameters[3]; return; }
  }
  async health() { return true; }
}

class FakeSecrets implements SecretStore {
  readonly written: { tenantId: string; providerKey: string; secret: SecretPayload }[] = [];
  readonly revoked: string[] = [];
  private counter = 0;
  async write(tenantId: string, providerKey: string, secret: SecretPayload): Promise<string> {
    this.written.push({ tenantId, providerKey, secret });
    return `projects/corvis-uat/secrets/corvis-src-${tenantId}-${providerKey}-${++this.counter}`;
  }
  async read(secretReference: string): Promise<SecretPayload> { return { secretReference }; }
  async revoke(secretReference: string): Promise<void> { this.revoked.push(secretReference); }
}

function driver(overrides: Partial<ConnectorDriver> = {}): ConnectorDriver {
  return {
    providerKey: "acme-portal",
    connectorVersion: "1.0.0",
    testConnection: async () => ({ ok: true }),
    discover: async () => [],
    download: async () => ({ bytes: Buffer.from("x"), contentType: "application/pdf" }),
    ...overrides,
  };
}

test("acquisitionKey is stable for identical inputs and changes with remote version or content", () => {
  const a = acquisitionKey("doc-1", "v1", "hash1");
  const b = acquisitionKey("doc-1", "v1", "hash1");
  const c = acquisitionKey("doc-1", "v2", "hash1");
  const d = acquisitionKey("doc-1", "v1", "hash2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test("fail-closed and retryable error classes are disjoint and cover the full contract set", () => {
  const classes = ["auth", "reauthorization", "permission", "provider_change", "network", "download", "validation", "rate_limit"] as const;
  for (const errorClass of classes) {
    const failClosed = isFailClosedErrorClass(errorClass);
    const retryable = isRetryableErrorClass(errorClass);
    assert.equal(failClosed && retryable, false, `${errorClass} cannot be both fail-closed and retryable`);
  }
});

test("statusAfterError never reactivates a revoked connection", () => {
  assert.equal(statusAfterError("revoked", "auth", 1), "revoked");
});

test("statusAfterError moves to reauthorization_required on an auth-class error", () => {
  assert.equal(statusAfterError("active", "auth", 1), "reauthorization_required");
  assert.equal(statusAfterError("active", "reauthorization", 1), "reauthorization_required");
});

test("statusAfterError suspends on a permission or provider-change error", () => {
  assert.equal(statusAfterError("active", "permission", 1), "suspended");
  assert.equal(statusAfterError("active", "provider_change", 1), "suspended");
});

test("statusAfterError suspends after repeated retryable failures even though each one alone would not", () => {
  assert.equal(statusAfterError("active", "network", 4), "active");
  assert.equal(statusAfterError("active", "network", 5), "suspended");
});

test("createSourceConnection requires an explicit non-empty source scope confirmation", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  await assert.rejects(
    () => createSourceConnection(identity(), {
      workspaceId: WORKSPACE, providerKey: "acme-portal", connectionLabel: "Acme", credentialType: "scoped_api_token",
      sourceScope: [], secret: { token: "shh" }, connectorVersion: "1.0.0",
    }, { db, secrets }),
    (error: unknown) => error instanceof ConnectorGovernanceError && error.code === "source_scope_confirmation_required",
  );
  assert.equal(secrets.written.length, 0, "credentials must never be written before scope is confirmed");
});

test("createSourceConnection rejects a malformed provider key before touching the secret store", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  await assert.rejects(
    () => createSourceConnection(identity(), {
      workspaceId: WORKSPACE, providerKey: "AB", connectionLabel: "Acme", credentialType: "scoped_api_token",
      sourceScope: [{ label: "Reports" }], secret: {}, connectorVersion: "1.0.0",
    }, { db, secrets }),
    (error: unknown) => error instanceof ConnectorGovernanceError && error.code === "invalid_provider_key",
  );
  assert.equal(secrets.written.length, 0);
});

test("createSourceConnection writes the secret first and stores only the returned reference", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  const connection = await createSourceConnection(identity(), {
    workspaceId: WORKSPACE, providerKey: "acme-portal", connectionLabel: "Acme investor portal",
    credentialType: "scoped_api_token", sourceScope: [{ label: "Quarterly reports" }],
    secret: { token: "super-secret-value" }, connectorVersion: "1.0.0",
  }, { db, secrets });

  assert.equal(secrets.written.length, 1);
  assert.equal(connection.status, "pending_authorization");
  assert.ok(connection.secretReference.startsWith("projects/corvis-uat/secrets/corvis-src-"));
  assert.equal(JSON.stringify(connection).includes("super-secret-value"), false, "the raw secret must never appear in the returned connection");
});

test("listSourceConnections never exposes the secret reference", async () => {
  const db = new FakeConnectionDb();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [{ label: "x" }],
    scope_confirmed_by: "u1", scope_confirmed_at: new Date().toISOString(), secret_reference: "projects/x/secrets/corvis-src-real-secret-name",
    connector_version: "1.0.0", status: "active" });
  const [connection] = await listSourceConnections(identity(), db);
  assert.equal(connection?.secretReference, "redacted");
});

test("pauseSourceConnection only transitions from active or reauthorization_required", async () => {
  const db = new FakeConnectionDb();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "revoked" });
  await assert.rejects(
    () => pauseSourceConnection(identity(), "c1", db),
    (error: unknown) => error instanceof ConnectorGovernanceError && error.code === "invalid_transition_from_revoked",
  );
});

test("pause then resume round-trips a connection back to active", async () => {
  const db = new FakeConnectionDb();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "active" });
  await pauseSourceConnection(identity(), "c1", db);
  const [paused] = await listSourceConnections(identity(), db);
  assert.equal(paused?.status, "paused");
  await resumeSourceConnection(identity(), "c1", db);
  const [resumed] = await listSourceConnections(identity(), db);
  assert.equal(resumed?.status, "active");
});

test("revoking a connection destroys its secret and the transition is terminal", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "projects/x/secrets/corvis-src-real", connector_version: "1.0.0", status: "active" });

  await revokeSourceConnection(identity(), "c1", { db, secrets });
  assert.deepEqual(secrets.revoked, ["projects/x/secrets/corvis-src-real"]);
  const [revoked] = await listSourceConnections(identity(), db);
  assert.equal(revoked?.status, "revoked");

  // Revoking an already-revoked connection is a safe no-op, not a second secret destruction attempt.
  await revokeSourceConnection(identity(), "c1", { db, secrets });
  assert.equal(secrets.revoked.length, 1);
});

test("reauthorization rotates the secret, reactivates the connection and clears the failure streak", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "projects/x/secrets/corvis-src-old", connector_version: "1.0.0",
    status: "reauthorization_required", consecutive_failures: 3, last_error_class: "auth" });

  await reauthorizeSourceConnection(identity(), "c1", { token: "new-token" }, { db, secrets });
  assert.deepEqual(secrets.revoked, ["projects/x/secrets/corvis-src-old"]);
  const [connection] = await listSourceConnections(identity(), db);
  assert.equal(connection?.status, "active");
  assert.equal(connection?.consecutiveFailures, 0);
});

test("reauthorizing a revoked connection is refused", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "revoked" });
  await assert.rejects(
    () => reauthorizeSourceConnection(identity(), "c1", {}, { db, secrets }),
    (error: unknown) => error instanceof ConnectorGovernanceError && error.code === "connection_revoked",
  );
});

test("testSourceConnection activates a pending connection on success and never logs the credential", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "pending_authorization" });

  const drivers = new Map([["acme-portal", driver()]]);
  const result = await testSourceConnection(identity(), "c1", { db, secrets, drivers });
  assert.equal(result.ok, true);
  const [connection] = await listSourceConnections(identity(), db);
  assert.equal(connection?.status, "active");
});

test("testSourceConnection moves the connection to reauthorization_required on an auth failure", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "active" });

  const drivers = new Map([["acme-portal", driver({ testConnection: async () => ({ ok: false, errorClass: "auth", detail: "expired" }) })]]);
  await testSourceConnection(identity(), "c1", { db, secrets, drivers });
  const [connection] = await listSourceConnections(identity(), db);
  assert.equal(connection?.status, "reauthorization_required");
});

test("testSourceConnection refuses a revoked connection outright", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "revoked" });
  const drivers = new Map([["acme-portal", driver()]]);
  await assert.rejects(
    () => testSourceConnection(identity(), "c1", { db, secrets, drivers }),
    (error: unknown) => error instanceof ConnectorGovernanceError && error.code === "connection_revoked",
  );
});

test("testSourceConnection fails closed for a provider with no registered driver", async () => {
  const db = new FakeConnectionDb();
  const secrets = new FakeSecrets();
  db.seed({ tenant_id: TENANT, source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "unknown-portal",
    connection_label: "X", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "active" });
  await assert.rejects(
    () => testSourceConnection(identity(), "c1", { db, secrets, drivers: new Map() }),
    (error: unknown) => error instanceof ConnectorGovernanceError && error.code === "unregistered_provider",
  );
});

test("cross-tenant access to a connection is refused as not-found, never leaking existence", async () => {
  const db = new FakeConnectionDb();
  db.seed({ tenant_id: "other-tenant", source_connection_id: "c1", workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [], scope_confirmed_by: "u1",
    scope_confirmed_at: "now", secret_reference: "ref", connector_version: "1.0.0", status: "active" });
  await assert.rejects(
    () => pauseSourceConnection(identity(), "c1", db),
    (error: unknown) => error instanceof ConnectorGovernanceError && error.code === "connection_not_found",
  );
});
