import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, type RequestIdentity } from "../../core/enterprise.ts";
import type { ServerConfig } from "./config.ts";
import { ConflictError } from "./platform.ts";
import {
  assertOperationsTenant,
  normalizeProvisionTenantCommand,
  PostgresTenantProvisioningRepository,
} from "./tenant-provisioning.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "ops|staff-1",
    tenantId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    roles: ["admin"],
    entitlements: { workspaceIds: ["00000000-0000-4000-8000-000000000002"], sourceDocumentAccessAllowed: true },
    authMethod: "oidc",
    sessionId: "session-1",
    ...overrides,
  };
}

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    environment: "development",
    demoMode: false,
    gcsChunkSizeBytes: 8 * 1024 * 1024,
    uploadAllowedOrigins: [],
    gcsMalwareMetadataKey: "corvis-malware-status",
    gcsMalwareCleanValue: "clean",
    gcsMalwareThreatValue: "threat",
    researchTimeoutMs: 30_000,
    rateLimitRequestsPerMinute: 600,
    exportArtifactTtlSeconds: 86_400,
    ...overrides,
  };
}

const validBody = {
  tenantSlug: "acme-capital",
  tenantDisplayName: "Acme Capital Partners",
  workspaceSlug: "primary",
  workspaceDisplayName: "Primary Workspace",
  initialAdminEmail: "first.admin@example.test",
  reason: "Signed MSA 2026-09-25, provisioning first workspace",
};

test("assertOperationsTenant allows the configured operations tenant and rejects any other", () => {
  const cfg = config({ operationsTenantId: "00000000-0000-4000-8000-000000000001" });
  assert.doesNotThrow(() => assertOperationsTenant(identity(), cfg));
  assert.throws(() => assertOperationsTenant(identity({ tenantId: "other-tenant" }), cfg), AuthorizationError);
});

test("assertOperationsTenant fails closed when unconfigured outside demo mode", () => {
  assert.throws(() => assertOperationsTenant(identity(), config()), AuthorizationError);
});

test("assertOperationsTenant trusts the demo identity's own tenant when unconfigured", () => {
  const cfg = config({ demoMode: true });
  assert.doesNotThrow(() => assertOperationsTenant(identity({ tenantId: "tenant_demo" }), cfg));
});

test("a demo-mode operations tenant configuration still wins over the demo bypass", () => {
  const cfg = config({ demoMode: true, operationsTenantId: "00000000-0000-4000-8000-000000000001" });
  assert.throws(() => assertOperationsTenant(identity({ tenantId: "tenant_demo" }), cfg), AuthorizationError);
});

test("normalizeProvisionTenantCommand accepts a well-formed command and lowercases slugs", () => {
  const command = normalizeProvisionTenantCommand({ ...validBody, tenantSlug: "Acme-Capital", workspaceSlug: "Primary" });
  assert.deepEqual(command, { ...validBody, tenantSlug: "acme-capital", workspaceSlug: "primary" });
});

for (const [field, value] of [
  ["tenantSlug", "Not A Slug!"],
  ["tenantSlug", ""],
  ["tenantSlug", "a"],
  ["tenantDisplayName", ""],
  ["workspaceSlug", "-leading-hyphen"],
  ["workspaceDisplayName", ""],
  ["initialAdminEmail", "not-an-email"],
  ["reason", ""],
  ["reason", "  "],
]) {
  test(`normalizeProvisionTenantCommand rejects an invalid ${field}`, () => {
    assert.equal(normalizeProvisionTenantCommand({ ...validBody, [field]: value }), undefined);
  });
}

class FakeDb implements PostgresSqlApi {
  readonly queries: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  readonly executions: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  private readonly existingSlugs: Set<string>;
  private readonly failInsertWith: unknown;

  constructor(options: { existingSlugs?: string[]; failInsertWith?: unknown } = {}) {
    this.existingSlugs = new Set(options.existingSlugs ?? []);
    this.failInsertWith = options.failInsertWith;
  }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.queries.push({ sql, parameters });
    if (sql.trim().startsWith("select 1 from corvis_control.tenant")) {
      return this.existingSlugs.has(String(parameters[0])) ? [{ "?column?": 1 }] : [];
    }
    throw new Error(`FakeDb: unexpected query: ${sql}`);
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.executions.push({ sql, parameters });
    if (sql.trim().startsWith("insert into corvis_control.tenant") && this.failInsertWith) throw this.failInsertWith;
  }

  async health(): Promise<boolean> { return true; }
}

test("provisioning inserts the tenant, its workspace and an audit event bound to the actor's own tenant", async () => {
  const db = new FakeDb();
  const command = normalizeProvisionTenantCommand(validBody)!;
  const result = await new PostgresTenantProvisioningRepository(db).provision(identity(), "corr-1", command);

  assert.equal(result.tenantSlug, "acme-capital");
  assert.equal(result.workspaceSlug, "primary");
  assert.ok(result.tenantId);
  assert.ok(result.workspaceId);

  assert.equal(db.executions.length, 3);
  assert.match(db.executions[0].sql, /insert into corvis_control\.tenant/);
  assert.match(db.executions[1].sql, /insert into corvis_control\.workspace/);
  assert.equal(db.executions[1].parameters[1], result.tenantId);
  assert.match(db.executions[2].sql, /insert into corvis_control\.audit_event/);
  // The audit row is scoped to the *actor's own* tenant (so it shows up in
  // their own audit trail), not the newly created tenant.
  assert.equal(db.executions[2].parameters[0], identity().tenantId);
  assert.equal(db.executions[2].parameters[7], result.tenantId);
});

test("provisioning refuses an already-taken tenant slug before writing anything", async () => {
  const db = new FakeDb({ existingSlugs: ["acme-capital"] });
  const command = normalizeProvisionTenantCommand(validBody)!;
  await assert.rejects(
    () => new PostgresTenantProvisioningRepository(db).provision(identity(), "corr-1", command),
    (error: unknown) => error instanceof ConflictError && error.code === "tenant_slug_taken",
  );
  assert.equal(db.executions.length, 0);
});

test("a unique-violation race on the insert itself still surfaces as a conflict, not a 500", async () => {
  const db = new FakeDb({ failInsertWith: { code: "23505" } });
  const command = normalizeProvisionTenantCommand(validBody)!;
  await assert.rejects(
    () => new PostgresTenantProvisioningRepository(db).provision(identity(), "corr-1", command),
    (error: unknown) => error instanceof ConflictError && error.code === "tenant_slug_taken",
  );
});
