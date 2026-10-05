import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { TenantIdentityCommand } from "../../core/identity-records.ts";
import { applyTenantIdentityCommand, emailDomainAllowed, readTenantIdentityRecords } from "./identity-records.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const OPERATIONS_TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const TARGET = "22222222-bbbb-4bbb-8bbb-222222222222";

const operator = {
  subject: "idp|operator", tenantId: OPERATIONS_TENANT, workspaceId: "33333333-cccc-4ccc-8ccc-333333333333", roles: ["admin"], isTenantAdmin: true,
  entitlements: { workspaceIds: [] }, authMethod: "oidc", sessionId: "sid-1",
} as unknown as RequestIdentity;

class RecordingDb implements PostgresSqlApi {
  readonly queries: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  private readonly answer: (sql: string) => PostgresRow[];
  constructor(answer: (sql: string) => PostgresRow[] = () => []) { this.answer = answer; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    return this.answer(sql);
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("a tenant's records are read with its own tenant predicate and without the operator's evidence", async () => {
  const db = new RecordingDb((sql) => sql.includes("tenant_identity_provider")
    ? [{ protocol: "oidc", issuer: "https://idp.acme.com", audience: "corvis", status: "active", enforce_token_binding: true, idp_enforces_mfa: true, end_session_endpoint: "https://idp.acme.com/logout", version: "3", updated_at: "2026-10-01T00:00:00.000Z" }]
    : [{ domain: "acme.com", verification_method: "dns_txt", verified_at: "2026-10-01T00:00:00.000Z" }, { domain: "acme.org", verification_method: "operator_attested", verified_at: "2026-10-02T00:00:00.000Z" }]);
  const records = await readTenantIdentityRecords(db, TARGET);
  assert.deepEqual(records, {
    identityProvider: { protocol: "oidc", issuer: "https://idp.acme.com", audience: "corvis", status: "active", enforceTokenBinding: true, idpEnforcesMfa: true, endSessionEndpoint: "https://idp.acme.com/logout", version: 3, updatedAt: "2026-10-01T00:00:00.000Z" },
    verifiedDomains: [
      { domain: "acme.com", verificationMethod: "dns_txt", verifiedAt: "2026-10-01T00:00:00.000Z" },
      { domain: "acme.org", verificationMethod: "operator_attested", verifiedAt: "2026-10-02T00:00:00.000Z" },
    ],
  });
  assert.ok(db.queries.every((query) => query.parameters.length === 1 && query.parameters[0] === TARGET && /where tenant_id = \$1::uuid/.test(query.sql)));
  assert.ok(db.queries.every((query) => !/evidence|verified_by_subject|updated_by_subject/.test(query.sql)), "never selects who verified a domain or the evidence");
});

test("a tenant with no record and no domain reads as empty, and a driver that returns booleans as text is understood", async () => {
  assert.deepEqual(await readTenantIdentityRecords(new RecordingDb(), TARGET), { identityProvider: null, verifiedDomains: [] });
  const text = await readTenantIdentityRecords(new RecordingDb((sql) => sql.includes("tenant_identity_provider")
    ? [{ protocol: "saml", issuer: "urn:acme", audience: "corvis", status: "pending", enforce_token_binding: "false", idp_enforces_mfa: "false", end_session_endpoint: null, version: 1, updated_at: "x" }]
    : []), TARGET);
  assert.equal(text.identityProvider?.enforceTokenBinding, false);
  assert.equal(text.identityProvider?.idpEnforcesMfa, false, "a recorded false is not the same as not reported");
  assert.equal(text.identityProvider?.endSessionEndpoint, null);
  const on = await readTenantIdentityRecords(new RecordingDb((sql) => sql.includes("tenant_identity_provider")
    ? [{ protocol: "oidc", issuer: "https://idp.acme.com", audience: "corvis", status: "active", enforce_token_binding: "true", idp_enforces_mfa: "true", version: 1, updated_at: "x" }]
    : []), TARGET);
  assert.equal(on.identityProvider?.enforceTokenBinding, true);
  assert.equal(on.identityProvider?.idpEnforcesMfa, true);
  const unreported = await readTenantIdentityRecords(new RecordingDb((sql) => sql.includes("tenant_identity_provider")
    ? [{ protocol: "oidc", issuer: "https://idp.acme.com", audience: "corvis", status: "active", enforce_token_binding: true, idp_enforces_mfa: null, version: 1, updated_at: "x" }]
    : []), TARGET);
  assert.equal(unreported.identityProvider?.idpEnforcesMfa, null, "not reported stays null, never false");
});

test("the domain check passes only on an explicit true, so a missing or odd answer fails closed", async () => {
  for (const [rows, expected] of [
    [[{ allowed: true }], true],
    [[{ allowed: "true" }], true],
    [[{ allowed: false }], false],
    [[{ allowed: "false" }], false],
    [[{ allowed: null }], false],
    [[{}], false],
    [[], false],
  ] as const) {
    const db = new RecordingDb(() => [...rows]);
    assert.equal(await emailDomainAllowed(db, TARGET, "Person@Acme.com"), expected, JSON.stringify(rows));
    assert.deepEqual(db.queries[0]?.parameters, [TARGET, "Person@Acme.com"]);
    assert.match(db.queries[0]!.sql, /corvis_control\.email_domain_allowed\(\$1::uuid,\$2\)/);
  }
});

test("each operator command calls its SQL function with the actor's tenant, method and subject, and reports what changed", async () => {
  const add: TenantIdentityCommand = { kind: "verified_domain_add", tenantId: TARGET, domain: "acme.com", verificationMethod: "dns_txt", evidence: "ticket-1", reason: "Customer asked" };
  let db = new RecordingDb(() => [{ changed: true, version: null }]);
  assert.deepEqual(await applyTenantIdentityCommand(operator, add, "corr-1", db), { changed: true, version: null });
  assert.match(db.queries[0]!.sql, /set_tenant_verified_domain/);
  assert.deepEqual(db.queries[0]!.parameters, [TARGET, OPERATIONS_TENANT, "oidc", "idp|operator", "acme.com", "dns_txt", "ticket-1", "Customer asked", "corr-1"]);

  const remove: TenantIdentityCommand = { kind: "verified_domain_remove", tenantId: TARGET, domain: "acme.com", reason: "Domain sold" };
  db = new RecordingDb(() => [{ changed: "false", version: null }]);
  assert.deepEqual(await applyTenantIdentityCommand(operator, remove, "corr-2", db), { changed: false, version: null });
  assert.match(db.queries[0]!.sql, /remove_tenant_verified_domain/);
  assert.deepEqual(db.queries[0]!.parameters, [TARGET, OPERATIONS_TENANT, "oidc", "idp|operator", "acme.com", "Domain sold", "corr-2"]);

  const set: TenantIdentityCommand = {
    kind: "identity_provider_set", tenantId: TARGET, protocol: "oidc", issuer: "https://idp.acme.com", audience: "corvis",
    status: "active", enforceTokenBinding: true, idpEnforcesMfa: true, endSessionEndpoint: "https://idp.acme.com/logout", expectedVersion: 2, reason: "Binding on",
  };
  db = new RecordingDb(() => [{ changed: "true", version: "3" }]);
  assert.deepEqual(await applyTenantIdentityCommand(operator, set, "corr-3", db), { changed: true, version: 3 });
  assert.match(db.queries[0]!.sql, /set_tenant_identity_provider/);
  assert.deepEqual(db.queries[0]!.parameters, [TARGET, OPERATIONS_TENANT, "oidc", "idp|operator", "oidc", "https://idp.acme.com", "corvis", "active", true, 2, "Binding on", "corr-3", true, "https://idp.acme.com/logout"]);
});

test("an operator command that returns no row is reported as unchanged, never as a success", async () => {
  const set: TenantIdentityCommand = { kind: "verified_domain_remove", tenantId: TARGET, domain: "acme.com", reason: "Domain sold" };
  assert.deepEqual(await applyTenantIdentityCommand(operator, set, "corr-4", new RecordingDb()), { changed: false, version: null });
});

test("a SQL refusal propagates so the route maps it, and nothing is swallowed", async () => {
  const db: PostgresSqlApi = {
    async query() { throw new Error("verified domain belongs to another tenant"); },
    async execute() {},
    async health() { return true; },
  };
  await assert.rejects(applyTenantIdentityCommand(operator, { kind: "verified_domain_remove", tenantId: TARGET, domain: "acme.com", reason: "Domain sold" }, "corr-5", db), /belongs to another tenant/);
});
