import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  createSourceConnection,
  getSourceConnection,
  listSourceConnections,
  pauseSourceConnection,
  reauthorizeSourceConnection,
  resumeSourceConnection,
  revokeSourceConnection,
  testSourceConnection,
  type ConnectorDriver,
  type SecretPayload,
  type SecretStore,
} from "./source-connectors.ts";

/**
 * Every exported operation accepts an injected database for tests, but in
 * production callers omit it and the module resolves the control database
 * from server config. These tests exercise that default path end to end
 * through the HTTPS SQL transport, with `fetch` standing in for the gateway.
 */

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";
const CONNECTION_ID = "00000000-0000-0000-0000-00000000c0c1";
const GATEWAY = "https://fake-postgres.test/sql";

const identity: RequestIdentity = {
  subject: "oidc|admin-1",
  tenantId: TENANT,
  workspaceId: WORKSPACE,
  roles: ["admin"],
  entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: true },
  authMethod: "oidc",
  sessionId: "session-1",
};

type Call = { sql: string; parameters: unknown[] };

function connectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_connection_id: CONNECTION_ID, tenant_id: TENANT, workspace_id: WORKSPACE, provider_key: "acme-portal",
    connection_label: "Acme", credential_type: "scoped_api_token", source_scope: [{ label: "Reports" }],
    scope_confirmed_by: "u1", scope_confirmed_at: "2026-01-01T00:00:00.000Z", secret_reference: "projects/x/secrets/corvis-src-old",
    connector_version: "1.0.0", status: "active", consecutive_failures: 0, ...overrides,
  };
}

/** Installs a fetch stub for the gateway DSN; `respond` maps each SQL call to the rows the gateway would return. */
function withGateway(respond: (call: Call) => unknown[]): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  const originalDsn = process.env.CORVIS_DATABASE_DSN;
  process.env.CORVIS_DATABASE_DSN = GATEWAY;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, GATEWAY, "the default database must be the configured DSN");
    const call = JSON.parse(String(init?.body)) as Call;
    calls.push(call);
    return new Response(JSON.stringify({ rows: respond(call) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      if (originalDsn === undefined) delete process.env.CORVIS_DATABASE_DSN;
      else process.env.CORVIS_DATABASE_DSN = originalDsn;
    },
  };
}

class RecordingSecrets implements SecretStore {
  readonly written: string[] = [];
  readonly revoked: string[] = [];
  async write(tenantId: string, providerKey: string): Promise<string> {
    const reference = `projects/corvis-uat/secrets/corvis-src-${tenantId}-${providerKey}-${this.written.length + 1}`;
    this.written.push(reference);
    return reference;
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

test("createSourceConnection resolves the control database from server config when none is injected", async (t) => {
  const gateway = withGateway((call) => (call.sql.startsWith("insert into corvis_source.source_connection")
    ? [connectionRow({ status: "pending_authorization", secret_reference: call.parameters[7] })]
    : []));
  t.after(gateway.restore);
  const secrets = new RecordingSecrets();
  const connection = await createSourceConnection(identity, {
    workspaceId: WORKSPACE, providerKey: "acme-portal", connectionLabel: "Acme", credentialType: "scoped_api_token",
    sourceScope: [{ label: "Reports" }], secret: { token: "shh" }, connectorVersion: "1.0.0",
  }, { secrets });
  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0]?.parameters[0], TENANT, "the insert is scoped to the caller's tenant");
  assert.equal(connection.status, "pending_authorization");
  assert.equal(connection.secretReference, secrets.written[0]);
});

test("the read and transition operations also default to the control database", async (t) => {
  let status = "active";
  const gateway = withGateway((call) => {
    if (call.sql.startsWith("update ")) { status = String(call.parameters[2]); return [{ status }]; }
    return [connectionRow({ status })];
  });
  t.after(gateway.restore);
  assert.equal((await listSourceConnections(identity)).length, 1);
  assert.equal((await getSourceConnection(identity, CONNECTION_ID)).sourceConnectionId, CONNECTION_ID);
  await pauseSourceConnection(identity, CONNECTION_ID);
  assert.equal(status, "paused");
  await resumeSourceConnection(identity, CONNECTION_ID);
  assert.equal(status, "active");
});

test("revokeSourceConnection destroys the secret and marks the row revoked via the default control database", async (t) => {
  const gateway = withGateway((call) => (call.sql.startsWith("select *") ? [connectionRow()] : [{ status: "revoked" }]));
  t.after(gateway.restore);
  const secrets = new RecordingSecrets();
  await revokeSourceConnection(identity, CONNECTION_ID, { secrets });
  assert.deepEqual(secrets.revoked, ["projects/x/secrets/corvis-src-old"]);
  const update = gateway.calls.find((call) => call.sql.includes("status='revoked'"));
  assert.deepEqual(update?.parameters, [TENANT, CONNECTION_ID, "projects/x/secrets/corvis-src-old"], "the terminal write is conditioned on the destroyed reference");
});

test("reauthorizeSourceConnection rotates the secret and revokes the previous one via the default control database", async (t) => {
  const gateway = withGateway((call) => (call.sql.startsWith("select *") ? [connectionRow({ status: "reauthorization_required" })] : [{ status: "active" }]));
  t.after(gateway.restore);
  const secrets = new RecordingSecrets();
  await reauthorizeSourceConnection(identity, CONNECTION_ID, { token: "new" }, { secrets });
  const update = gateway.calls.find((call) => call.sql.startsWith("update corvis_source.source_connection"));
  assert.equal(update?.parameters[2], secrets.written[0], "the new reference is stored");
  assert.equal(update?.parameters[3], "projects/x/secrets/corvis-src-old", "the write is conditioned on the previous reference");
  assert.deepEqual(secrets.revoked, ["projects/x/secrets/corvis-src-old"]);
});

test("testSourceConnection activates a pending connection via the default control database", async (t) => {
  const gateway = withGateway((call) => (call.sql.startsWith("select *") ? [connectionRow({ status: "pending_authorization" })] : []));
  t.after(gateway.restore);
  const secrets = new RecordingSecrets();
  const result = await testSourceConnection(identity, CONNECTION_ID, { secrets, drivers: new Map([["acme-portal", driver()]]) });
  assert.equal(result.ok, true);
  const update = gateway.calls.find((call) => call.sql.includes("status='active'"));
  assert.deepEqual(update?.parameters, [TENANT, CONNECTION_ID]);
});
