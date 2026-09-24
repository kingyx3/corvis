import test from "node:test";
import assert from "node:assert/strict";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { createAuditedSourceConnection, transitionAuditedSourceConnection } from "./source-connector-governance.ts";
import type { SecretPayload, SecretStore } from "./source-connectors.ts";

const CONNECTION_ID = "00000000-0000-4000-8000-000000000101";
const identity: RequestIdentity = {
  subject: "idp|account-admin",
  tenantId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  roles: ["admin"],
  entitlements: { workspaceIds: ["22222222-2222-4222-8222-222222222222"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
  isTenantAdmin: false,
};

function connectionRow(workspaceId = identity.workspaceId): PostgresRow {
  return {
    source_connection_id: CONNECTION_ID,
    tenant_id: identity.tenantId,
    workspace_id: workspaceId,
    provider_key: "acme-portal",
    connection_label: "Acme",
    credential_type: "scoped_api_token",
    source_scope: JSON.stringify([{ label: "Quarterly" }]),
    scope_confirmed_by: identity.subject,
    scope_confirmed_at: new Date().toISOString(),
    secret_reference: "projects/p/secrets/corvis-src-test",
    connector_version: "1.0.0",
    status: "active",
    consecutive_failures: 0,
  };
}

class GovernanceDb implements PostgresSqlApi {
  inTransaction = false;
  workspaceId = identity.workspaceId;
  mutations = 0;
  audits = 0;

  async query(sql: string, _parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("insert into corvis_source.source_connection")) {
      assert.equal(this.inTransaction, true, "metadata insert must run inside transaction");
      this.mutations += 1;
      return [{ source_connection_id: CONNECTION_ID }];
    }
    if (sql.includes("'redacted' as secret_reference")) return [{ ...connectionRow(this.workspaceId), secret_reference: "redacted" }];
    if (sql.includes("from corvis_source.source_connection")) return [connectionRow(this.workspaceId)];
    return [];
  }

  async execute(sql: string): Promise<void> {
    if (sql.includes("insert into corvis_control.audit_event")) {
      assert.equal(this.inTransaction, true, "required audit must share the transaction");
      this.audits += 1;
    } else if (sql.includes("update corvis_source.source_connection")) {
      this.mutations += 1;
    }
  }

  async health(): Promise<boolean> { return true; }

  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    assert.equal(this.inTransaction, false);
    this.inTransaction = true;
    try { return await fn(this); }
    finally { this.inTransaction = false; }
  }
}

class GovernanceSecrets implements SecretStore {
  constructor(private readonly db: GovernanceDb) {}
  writes = 0;
  revokes = 0;
  async write(_tenantId: string, _providerKey: string, _secret: SecretPayload): Promise<string> {
    assert.equal(this.db.inTransaction, false, "Secret Manager write must happen before the DB transaction");
    this.writes += 1;
    return "projects/p/secrets/corvis-src-test";
  }
  async read(): Promise<SecretPayload> { return { token: "redacted" }; }
  async revoke(): Promise<void> {
    assert.equal(this.db.inTransaction, false, "Secret Manager revoke must not hold a DB transaction open");
    this.revokes += 1;
  }
}

test("connector create keeps provider I/O outside the atomic metadata+audit transaction", async () => {
  const db = new GovernanceDb();
  const secrets = new GovernanceSecrets(db);
  const result = await createAuditedSourceConnection(identity, {
    workspaceId: identity.workspaceId,
    providerKey: "acme-portal",
    connectionLabel: "Acme",
    credentialType: "scoped_api_token",
    sourceScope: [{ label: "Quarterly" }],
    secret: { token: "secret" },
    connectorVersion: "1.0.0",
  }, "corr-1", { db, secrets });

  assert.equal(result.sourceConnectionId, CONNECTION_ID);
  assert.equal(secrets.writes, 1);
  assert.equal(db.mutations, 1);
  assert.equal(db.audits, 1);
});

test("workspace admin cannot mutate a connector belonging to another workspace", async () => {
  const db = new GovernanceDb();
  db.workspaceId = "33333333-3333-4333-8333-333333333333";
  const secrets = new GovernanceSecrets(db);
  await assert.rejects(
    transitionAuditedSourceConnection(identity, CONNECTION_ID, "pause", "corr-2", { db, secrets }),
    (error: unknown) => error instanceof Error && error.message === "connection_not_found",
  );
  assert.equal(db.mutations, 0);
  assert.equal(db.audits, 0);
});
