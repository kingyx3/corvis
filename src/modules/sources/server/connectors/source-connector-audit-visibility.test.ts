import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import { reauthorizeAuditedSourceConnection, transitionAuditedSourceConnection } from "./source-connector-governance.ts";
import type { SecretStore } from "./source-connectors.ts";
import { listTenantAccessAudit, tenantAccessAuditCsv } from "../../../identity-access/server/tenants/tenant-admin-self-service.ts";

/**
 * C9 acceptance for B8: every audit action the source-connection governance
 * commands write must be returned by the tenant access audit listing (and so
 * by its CSV export). The listing filters in SQL, so this test evaluates that
 * very filter against the audit rows the real governance code produced.
 */

const CONNECTION_ID = "00000000-0000-4000-8000-000000000101";
const tenantId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const admin: RequestIdentity = {
  subject: "idp|tenant-admin", tenantId, workspaceId, roles: ["admin"], isTenantAdmin: true,
  entitlements: { workspaceIds: [workspaceId], sourceDocumentAccessAllowed: false }, authMethod: "oidc", sessionId: "session-1",
};

type AuditRow = { action: string; targetType: string; targetId: string; outcome: string; actor: string; metadata: string };

/** A tiny stateful stand-in for corvis_source.source_connection plus the audit table. */
class ConnectionDb implements PostgresSqlApi {
  status = "active";
  secretReference = "projects/p/secrets/corvis-src-old";
  readonly audits: AuditRow[] = [];

  private row(): PostgresRow {
    return {
      source_connection_id: CONNECTION_ID, tenant_id: tenantId, workspace_id: workspaceId, provider_key: "acme-portal", connection_label: "Acme",
      credential_type: "scoped_api_token", source_scope: JSON.stringify([{ label: "Quarterly" }]), scope_confirmed_by: "idp|tenant-admin",
      scope_confirmed_at: new Date().toISOString(), secret_reference: this.secretReference, connector_version: "1.0.0", status: this.status,
      consecutive_failures: 0,
    };
  }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("for update")) return [{ status: this.status, secret_reference: this.secretReference, workspace_id: workspaceId }];
    if (sql.includes("'redacted' as secret_reference")) return [{ ...this.row(), secret_reference: "redacted" }];
    if (sql.trimStart().startsWith("update corvis_source.source_connection")) {
      if (sql.includes("set status=$3")) this.status = String(parameters[2]);
      else if (sql.includes("secret_reference=$3")) { this.secretReference = String(parameters[2]); this.status = this.status === "paused" ? "paused" : "active"; }
      return [{ status: this.status, source_connection_id: CONNECTION_ID }];
    }
    if (sql.includes("from corvis_source.source_connection")) return [this.row()];
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_control.audit_event")) {
      this.audits.push({ actor: String(parameters[4]), action: String(parameters[5]), targetType: String(parameters[6]), targetId: String(parameters[7]), outcome: String(parameters[8]), metadata: String(parameters[10]) });
    } else if (sql.includes("status='revoked'")) {
      this.status = "revoked";
    }
  }

  async health(): Promise<boolean> { return true; }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> { return fn(this); }
}

const secrets: SecretStore = {
  async write() { return "projects/p/secrets/corvis-src-new"; },
  async read() { return {}; },
  async revoke() { /* destroyed */ },
};

/** Evaluates the `where` filter of the listing's SQL against one audit row, the way Postgres would. */
function matchesListingFilter(sql: string, row: { action: string; targetType: string }): boolean {
  const patterns = [...sql.matchAll(/action like '([^']+)'/g)].map((match) => new RegExp(`^${match[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`));
  const targetTypes = /target_type in \(([^)]*)\)/.exec(sql)?.[1]?.split(",").map((value) => value.trim().replace(/^'|'$/g, "")) ?? [];
  return patterns.some((pattern) => pattern.test(row.action)) || targetTypes.includes(row.targetType);
}

test("pause, resume, reauthorize and revoke each write an audit event the tenant access audit returns", async () => {
  const db = new ConnectionDb();
  await transitionAuditedSourceConnection(admin, CONNECTION_ID, "pause", "corr-1", { db, secrets });
  await transitionAuditedSourceConnection(admin, CONNECTION_ID, "resume", "corr-2", { db, secrets });
  await reauthorizeAuditedSourceConnection(admin, CONNECTION_ID, { token: "new-secret-value" }, "corr-3", { db, secrets });
  await transitionAuditedSourceConnection(admin, CONNECTION_ID, "revoke", "corr-4", { db, secrets });

  assert.deepEqual(db.audits.map((audit) => audit.action), ["source_connection.pause", "source_connection.resume", "source_connection.reauthorize", "source_connection.revoke"]);
  for (const audit of db.audits) {
    assert.equal(audit.targetType, "source_connection");
    assert.equal(audit.targetId, CONNECTION_ID);
    assert.equal(audit.actor, admin.subject, "the acting administrator is recorded");
    assert.equal(audit.outcome, "success");
    assert.equal(audit.metadata.includes("new-secret-value"), false, "no credential reaches the audit trail");
  }

  const listing = new ConnectionDb();
  let listingSql = "";
  const listingDb: PostgresSqlApi = {
    async query(sql) {
      listingSql = sql;
      return db.audits.filter((audit) => matchesListingFilter(sql, audit)).map((audit, index) => ({
        audit_event_id: `e${index}`, occurred_at: "2026-10-02T00:00:00Z", workspace_id: workspaceId, actor_subject: audit.actor, action: audit.action,
        target_type: audit.targetType, target_id: audit.targetId, outcome: audit.outcome, metadata: JSON.parse(audit.metadata),
      }));
    },
    async execute() { /* unused */ },
    async health() { return listing.health(); },
  };

  const events = await listTenantAccessAudit(admin, listingDb);
  assert.match(listingSql, /tenant_id=\$1::uuid/);
  assert.deepEqual(events.map((event) => event.action), ["source_connection.pause", "source_connection.resume", "source_connection.reauthorize", "source_connection.revoke"]);

  const csv = tenantAccessAuditCsv(events);
  for (const action of ["source_connection.pause", "source_connection.resume", "source_connection.reauthorize", "source_connection.revoke"]) {
    assert.ok(csv.includes(action), `${action} is in the CSV export`);
  }
  assert.equal(csv.includes("new-secret-value"), false);
});

test("the listing filter still excludes unrelated audit events", () => {
  const sql = `action like 'tenant_invitation.%' or action like 'source_connection.%' or target_type in ('membership','source_connection')`;
  assert.equal(matchesListingFilter(sql, { action: "document.upload", targetType: "document" }), false);
  assert.equal(matchesListingFilter(sql, { action: "source_connection.test", targetType: "other" }), true);
  assert.equal(matchesListingFilter(sql, { action: "anything", targetType: "source_connection" }), true);
});
