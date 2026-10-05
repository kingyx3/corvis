import test from "node:test";
import assert from "node:assert/strict";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { auditSourceConnectionEvent, createAuditedSourceConnection, reauthorizeAuditedSourceConnection, resolveConnectionCredential, testAuditedSourceConnection, transitionAuditedSourceConnection } from "./source-connector-governance.ts";
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

// ---- the defensive paths: every refusal, every compensating action and every row shape the module may meet ----

type Script = {
  raw: PostgresRow | undefined;
  /** What the single-connection read (the redacted shape) returns. */
  shown: PostgresRow | undefined;
  forUpdate: PostgresRow | undefined;
  swapped: PostgresRow[];
  failInsert: boolean;
  statements: string[];
};

function scripted(overrides: Partial<Script> = {}): { db: PostgresSqlApi; script: Script } {
  const script: Script = { raw: connectionRow(), shown: { ...connectionRow(), secret_reference: "redacted" }, forUpdate: { status: "active", secret_reference: "projects/p/secrets/corvis-src-test", workspace_id: identity.workspaceId }, swapped: [{ source_connection_id: CONNECTION_ID }], failInsert: false, statements: [], ...overrides };
  const db = {
    query: async (sql: string) => {
      script.statements.push(sql.trim().split(/\s+/).slice(0, 4).join(" "));
      if (sql.includes("insert into corvis_source.source_connection")) { if (script.failInsert) throw new Error("insert failed"); return [{ source_connection_id: CONNECTION_ID }]; }
      if (sql.includes("'redacted' as secret_reference")) return script.shown ? [script.shown] : [];
      if (sql.includes("for update")) return script.forUpdate ? [script.forUpdate] : [];
      if (/secret_reference=\$3,\s*status=case/.test(sql)) return script.swapped;
      if (sql.includes("select * from corvis_source.source_connection")) return script.raw ? [script.raw] : [];
      return [];
    },
    execute: async () => undefined,
    health: async () => true,
    transaction: async <T>(fn: (tx: PostgresSqlApi) => Promise<T>) => fn(db),
  } as unknown as PostgresSqlApi;
  return { db, script };
}

function countingSecrets(): { secrets: SecretStore; log: string[] } {
  const log: string[] = [];
  return {
    log,
    secrets: {
      write: async () => { log.push("write"); return "projects/p/secrets/corvis-src-new"; },
      read: async () => { log.push("read"); return { token: "t" }; },
      revoke: async (reference) => { log.push(`revoke:${reference}`); },
    },
  };
}

const newConnection = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: identity.workspaceId, providerKey: "acme-portal", connectionLabel: "Acme", credentialType: "scoped_api_token" as const,
  sourceScope: [{ label: "Quarterly" }], secret: { token: "secret" }, connectorVersion: "1.0.0", ...overrides,
});
const refusedWith = (code: string) => (error: unknown) => error instanceof Error && error.message === code;

test("a connection is refused before any secret is written when its input is invalid or names another workspace", async () => {
  const { db } = scripted();
  const { secrets, log } = countingSecrets();
  const create = (input: Record<string, unknown>) => createAuditedSourceConnection(identity, newConnection(input), "corr", { db, secrets });
  await assert.rejects(create({ providerKey: "A" }), refusedWith("invalid_provider_key"));
  await assert.rejects(create({ connectionLabel: "   " }), refusedWith("connection_label_required"));
  await assert.rejects(create({ connectionLabel: "x".repeat(201) }), refusedWith("connection_label_too_long"));
  await assert.rejects(create({ sourceScope: [] }), refusedWith("source_scope_confirmation_required"));
  await assert.rejects(create({ workspaceId: "33333333-3333-4333-8333-333333333333" }), refusedWith("connection_not_found"));
  assert.deepEqual(log, [], "no secret was written for any of them");
});

test("a connection whose insert fails, or that reads back from another workspace, leaves no live secret", async () => {
  const failing = scripted({ failInsert: true });
  const first = countingSecrets();
  await assert.rejects(createAuditedSourceConnection(identity, newConnection(), "corr", { db: failing.db, secrets: first.secrets }), /insert failed/);
  assert.deepEqual(first.log, ["write", "revoke:projects/p/secrets/corvis-src-new"]);

  const foreign = scripted({ shown: { ...connectionRow("33333333-3333-4333-8333-333333333333"), secret_reference: "redacted" } });
  const second = countingSecrets();
  await assert.rejects(createAuditedSourceConnection(identity, newConnection(), "corr", { db: foreign.db, secrets: second.secrets }), refusedWith("connection_not_found"));
  assert.deepEqual(second.log, ["write", "revoke:projects/p/secrets/corvis-src-new"]);
});

test("revoking refuses a connection that is gone or in another workspace, and destroys the secret only after the revoke is recorded", async () => {
  const { secrets, log } = countingSecrets();
  await assert.rejects(transitionAuditedSourceConnection(identity, CONNECTION_ID, "revoke", "corr", { db: scripted({ raw: undefined }).db, secrets }), refusedWith("connection_not_found"));
  await assert.rejects(transitionAuditedSourceConnection(identity, CONNECTION_ID, "revoke", "corr", { db: scripted({ forUpdate: undefined }).db, secrets }), refusedWith("connection_not_found"));
  await assert.rejects(transitionAuditedSourceConnection(identity, CONNECTION_ID, "revoke", "corr", { db: scripted({ forUpdate: { status: "active", secret_reference: "r", workspace_id: "33333333-3333-4333-8333-333333333333" } }).db, secrets }), refusedWith("connection_not_found"));
  assert.deepEqual(log, []);

  const { db, script } = scripted();
  await transitionAuditedSourceConnection(identity, CONNECTION_ID, "revoke", "corr", { db, secrets });
  assert.deepEqual(log, ["revoke:projects/p/secrets/corvis-src-test"]);
  assert.ok(script.statements.some((statement) => statement.startsWith("select status,secret_reference")));

  // An already revoked connection is idempotent: nothing is updated or audited again, the secret is still destroyed.
  const again = scripted({ forUpdate: { status: "revoked", secret_reference: "projects/p/secrets/corvis-src-test", workspace_id: identity.workspaceId } });
  log.length = 0;
  await transitionAuditedSourceConnection(identity, CONNECTION_ID, "revoke", "corr", { db: again.db, secrets });
  assert.deepEqual(log, ["revoke:projects/p/secrets/corvis-src-test"]);
});

test("a reauthorization that loses a compare-and-set is refused for the reason it lost, and destroys the new secret", async () => {
  const revoked = scripted({ swapped: [] });
  revoked.script.raw = connectionRow();
  const { secrets, log } = countingSecrets();
  // The row is revoked when it is re-read inside the transaction.
  let reads = 0;
  const original = revoked.db.query.bind(revoked.db);
  (revoked.db as unknown as { query: PostgresSqlApi["query"] }).query = async (sql, parameters) => {
    const rows = await original(sql, parameters);
    if (sql.includes("select * from corvis_source.source_connection")) { reads += 1; return reads > 1 ? [{ ...rows[0]!, status: "revoked" }] : rows; }
    return rows;
  };
  await assert.rejects(reauthorizeAuditedSourceConnection(identity, CONNECTION_ID, { token: "n" }, "corr", { db: revoked.db, secrets }), refusedWith("connection_revoked"));
  assert.deepEqual(log, ["write", "revoke:projects/p/secrets/corvis-src-new"]);

  const changed = scripted({ swapped: [] });
  const second = countingSecrets();
  await assert.rejects(reauthorizeAuditedSourceConnection(identity, CONNECTION_ID, { token: "n" }, "corr", { db: changed.db, secrets: second.secrets }), refusedWith("invalid_transition_from_concurrent_change"));
  assert.deepEqual(second.log, ["write", "revoke:projects/p/secrets/corvis-src-new"]);

  const gone = countingSecrets();
  await assert.rejects(reauthorizeAuditedSourceConnection(identity, CONNECTION_ID, { token: "n" }, "corr", { db: scripted({ raw: { ...connectionRow(), status: "revoked" } }).db, secrets: gone.secrets }), refusedWith("connection_revoked"));
  assert.deepEqual(gone.log, [], "a revoked connection is refused before a secret is written");
});

test("a test refuses a revoked connection and one whose provider has no driver, and reads whatever shape the scope and counters were stored in", async () => {
  const seen: unknown[] = [];
  const drivers = new Map([["acme-portal", { providerKey: "acme-portal", connectorVersion: "1", testConnection: async (_credential: SecretPayload, scope: unknown) => { seen.push(scope); return { ok: true }; }, discover: async () => [], download: async () => ({ bytes: Buffer.alloc(0), contentType: "x" }) }]]);
  const { secrets } = countingSecrets();
  const run = (raw: PostgresRow | undefined) => testAuditedSourceConnection(identity, CONNECTION_ID, "corr", { db: scripted({ raw }).db, secrets, drivers });

  await assert.rejects(run({ ...connectionRow(), status: "revoked" }), refusedWith("connection_revoked"));
  await assert.rejects(run({ ...connectionRow(), provider_key: "other-portal" }), refusedWith("unregistered_provider"));
  await assert.rejects(run(undefined), refusedWith("connection_not_found"));
  await assert.rejects(run({ ...connectionRow(), secret_reference: null }), /missing required column secret_reference/);

  const scopes: Array<[unknown, unknown]> = [
    [[{ label: "Array" }], [{ label: "Array" }]],
    [JSON.stringify([{ label: "String" }]), [{ label: "String" }]],
    ["{not json", []],
    [JSON.stringify({ label: "not an array" }), []],
    [null, []],
  ];
  for (const [stored, expected] of scopes) {
    seen.length = 0;
    assert.deepEqual(await run({ ...connectionRow(), source_scope: stored as never, consecutive_failures: "not-a-number" }), { ok: true });
    assert.deepEqual(seen, [expected]);
  }
  // A timestamp column arrives as a Date from some drivers and is read as an instant.
  assert.deepEqual(await run({ ...connectionRow(), scope_confirmed_at: new Date("2026-10-01T00:00:00Z") }), { ok: true });
});

test("a store that cannot destroy a secret never turns a finished or refused command into a different failure", async () => {
  const failing = (): SecretStore => ({ write: async () => "projects/p/secrets/corvis-src-new", read: async () => ({ token: "t" }), revoke: async () => { throw new Error("store unavailable"); } });

  // The insert fails and the compensating revoke fails too: the caller still sees the insert's failure.
  await assert.rejects(createAuditedSourceConnection(identity, newConnection(), "corr", { db: scripted({ failInsert: true }).db, secrets: failing() }), /insert failed/);
  // The reauthorization is saved, destroying the previous secret fails: the reauthorization still succeeds.
  const reauthorized = await reauthorizeAuditedSourceConnection(identity, CONNECTION_ID, { token: "n" }, "corr", { db: scripted().db, secrets: failing() });
  assert.equal(reauthorized.sourceConnectionId, CONNECTION_ID);
  // The reauthorization loses its compare-and-set and destroying the new secret fails: the caller still sees why it lost.
  await assert.rejects(reauthorizeAuditedSourceConnection(identity, CONNECTION_ID, { token: "n" }, "corr", { db: scripted({ swapped: [] }).db, secrets: failing() }), refusedWith("invalid_transition_from_concurrent_change"));

  // The same holds for a refreshed credential: swapped, lost, or failed to save.
  const connection = { sourceConnectionId: CONNECTION_ID, providerKey: "acme-oauth", credentialType: "oauth_authorization_code", secretReference: "projects/p/secrets/corvis-src-old" };
  const client = { authorizationUrl: () => "x", exchangeCode: async () => ({}), refresh: async () => ({ accessToken: "new", expiresAt: 9_999_999_999_999 }) };
  const expired = { accessToken: "old", refreshToken: "r", expiresAt: 1_000 };
  const resolve = (db: PostgresSqlApi) => resolveConnectionCredential(identity, connection, expired, "corr", { db, secrets: failing(), oauthClient: () => client, now: () => 2_000 });
  assert.equal((await resolve(recordingDb().db)).accessToken, "new", "swapped, and the old secret could not be destroyed");
  assert.equal((await resolve(recordingDb([]).db)).accessToken, "new", "lost the race, and the replacement could not be destroyed");
  const broken = { query: async () => { throw new Error("database unavailable"); }, execute: async () => undefined } as unknown as PostgresSqlApi;
  await assert.rejects(resolve(broken), /database unavailable/);
});

test("a failed test reads the failure counter however it was stored, and a timestamp or secret reference may arrive as a Date", async () => {
  const drivers = new Map([["acme-portal", { providerKey: "acme-portal", connectorVersion: "1", testConnection: async () => ({ ok: false, errorClass: "network" as const }), discover: async () => [], download: async () => ({ bytes: Buffer.alloc(0), contentType: "x" }) }]]);
  const { secrets } = countingSecrets();
  for (const stored of ["not-a-number", 2, undefined]) {
    const { db } = scripted({ raw: { ...connectionRow(), consecutive_failures: stored as never } });
    assert.deepEqual(await testAuditedSourceConnection(identity, CONNECTION_ID, "corr", { db, secrets, drivers }), { ok: false, errorClass: "network" });
  }
  const { db } = scripted({ raw: { ...connectionRow(), secret_reference: new Date("2026-10-01T00:00:00Z") } });
  assert.deepEqual(await testAuditedSourceConnection(identity, CONNECTION_ID, "corr", { db, secrets, drivers }), { ok: false, errorClass: "network" });
});
