import test from "node:test";
import assert from "node:assert/strict";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { auditSourceConnectionEvent, createAuditedSourceConnection, resolveConnectionCredential, transitionAuditedSourceConnection } from "./source-connector-governance.ts";
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

  async query(sql: string): Promise<PostgresRow[]> {
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
  private readonly db: GovernanceDb;
  writes = 0;
  revokes = 0;

  constructor(db: GovernanceDb) {
    this.db = db;
  }

  async write(): Promise<string> {
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

type Executed = { sql: string; parameters: unknown[] };

function recordingDb(swapRows: PostgresRow[] = [{ source_connection_id: CONNECTION_ID }]): { db: PostgresSqlApi; queries: Executed[]; executed: Executed[] } {
  const queries: Executed[] = [];
  const executed: Executed[] = [];
  const db = {
    query: async (sql: string, parameters: unknown[] = []) => { queries.push({ sql, parameters }); return swapRows; },
    execute: async (sql: string, parameters: unknown[] = []) => { executed.push({ sql, parameters }); },
  } as unknown as PostgresSqlApi;
  return { db, queries, executed };
}

test("an event of the connect flow is audited on its own, against the connection or provider, with only the provider as metadata", async () => {
  const { db, executed } = recordingDb();
  await auditSourceConnectionEvent(identity, "corr-1", "source_connection.oauth_start", "acme-oauth", { providerKey: "acme-oauth" }, { db });
  assert.equal(executed.length, 1);
  assert.match(executed[0]!.sql, /insert into corvis_control.audit_event/);
  const parameters = executed[0]!.parameters;
  assert.deepEqual([parameters[4], parameters[5], parameters[6], parameters[7], parameters[8], parameters[9]], [identity.subject, "source_connection.oauth_start", "source_connection", "acme-oauth", "success", "corr-1"]);
  assert.deepEqual(JSON.parse(String(parameters[10])), { sessionId: "session-1", providerKey: "acme-oauth" });
});

test("only an OAuth credential is refreshed, a refresh is swapped in with a compare-and-set and audited, and the old secret is destroyed afterwards", async () => {
  const written: SecretPayload[] = [];
  const revoked: string[] = [];
  const secrets: SecretStore = {
    write: async (_tenant, _provider, secret) => { written.push(secret); return "projects/p/secrets/corvis-src-new"; },
    read: async () => ({}),
    revoke: async (reference) => { revoked.push(reference); },
  };
  const connection = { sourceConnectionId: CONNECTION_ID, providerKey: "acme-oauth", credentialType: "oauth_authorization_code", secretReference: "projects/p/secrets/corvis-src-old" };
  const expired = { accessToken: "old", refreshToken: "r", expiresAt: 1_000 };
  const client = { authorizationUrl: () => "x", exchangeCode: async () => ({}), refresh: async () => ({ accessToken: "new", expiresAt: 9_999_999_999_999 }) };

  const token = recordingDb();
  assert.deepEqual(await resolveConnectionCredential(identity, { ...connection, credentialType: "scoped_api_token" }, expired, "corr", { db: token.db, secrets, oauthClient: () => client }), expired);
  assert.equal(written.length, 0, "a token credential is never refreshed, whatever it holds");

  const fine = { accessToken: "ok", expiresAt: 9_999_999_999_999 };
  assert.deepEqual(await resolveConnectionCredential(identity, connection, fine, "corr", { db: token.db, secrets, oauthClient: () => client, now: () => 2_000 }), fine);
  assert.equal(written.length, 0, "a credential with time left is not refreshed");

  const swapped = recordingDb();
  const refreshed = await resolveConnectionCredential(identity, connection, expired, "corr", { db: swapped.db, secrets, oauthClient: () => client, now: () => 2_000 });
  assert.deepEqual(refreshed, { accessToken: "new", expiresAt: 9_999_999_999_999, refreshToken: "r" });
  assert.match(swapped.queries[0]!.sql, /set secret_reference=\$3[\s\S]*secret_reference=\$4/);
  assert.deepEqual(swapped.queries[0]!.parameters, [identity.tenantId, CONNECTION_ID, "projects/p/secrets/corvis-src-new", "projects/p/secrets/corvis-src-old", identity.workspaceId]);
  assert.equal(swapped.executed.filter((entry) => /audit_event/.test(entry.sql)).length, 1);
  assert.deepEqual(revoked, ["projects/p/secrets/corvis-src-old"]);

  const raced = recordingDb([]);
  revoked.length = 0;
  await resolveConnectionCredential(identity, connection, expired, "corr", { db: raced.db, secrets, oauthClient: () => client, now: () => 2_000 });
  assert.deepEqual(revoked, ["projects/p/secrets/corvis-src-new"], "a lost race destroys the replacement, not the current secret");
});
