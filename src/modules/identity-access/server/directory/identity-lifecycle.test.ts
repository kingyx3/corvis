import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PostgresIdentityLifecycleRepository } from "./identity-lifecycle.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";

class FakeDb implements PostgresSqlApi {
  sql = "";
  parameters: PostgresPrimitive[] = [];

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.sql = sql;
    this.parameters = parameters;
    return [{ result: {
      eventKey: "idp-event-123",
      operation: "sync",
      subject: "idp|user-123",
      userId: "11111111-1111-4111-8111-111111111111",
      activeMemberships: 2,
      revokedMemberships: 1,
      expiredEntitlements: 3,
      disabledSubjects: 0,
      disabledServiceGrants: 0,
    } }];
  }

  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("identity lifecycle repository delegates one atomic database command with explicit tenant and actor context", async () => {
  const db = new FakeDb();
  const repository = new PostgresIdentityLifecycleRepository(db);
  const result = await repository.apply({
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    eventKey: "idp-event-123",
    actorSubject: "idp|admin-1",
    actorWorkspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    correlationId: "request-123",
    operation: "sync",
    authMethod: "oidc",
    subject: "idp|user-123",
    userId: "11111111-1111-4111-8111-111111111111",
    memberships: [
      { workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", roleName: "analyst" },
      { workspaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", roleName: "viewer" },
    ],
    reason: "IdP group reconciliation",
  });

  assert.match(db.sql, /corvis_control\.apply_identity_lifecycle/);
  assert.deepEqual(db.parameters.slice(0, 9), [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "idp-event-123",
    "idp|admin-1",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "request-123",
    "sync",
    "oidc",
    "idp|user-123",
    "11111111-1111-4111-8111-111111111111",
  ]);
  assert.deepEqual(JSON.parse(String(db.parameters[9])), [
    { workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", roleName: "analyst" },
    { workspaceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", roleName: "viewer" },
  ]);
  assert.equal(result.activeMemberships, 2);
  assert.equal(result.revokedMemberships, 1);
  assert.equal(result.expiredEntitlements, 3);
});

test("identity lifecycle SQL is idempotent, blocks unsafe remapping/reactivation and atomically records audit evidence", async () => {
  const sql = (await readFile("db/postgres/migrations/001_baseline.sql", "utf8")).toLowerCase();

  assert.match(sql, /create table corvis_control\.identity_lifecycle_event \(/);
  assert.match(sql, /add constraint identity_lifecycle_event_tenant_id_event_key_key unique \(tenant_id, event_key\)/);
  assert.match(sql, /alter table corvis_control\.identity_lifecycle_event enable row level security/);
  assert.match(sql, /alter table only corvis_control\.identity_lifecycle_event force row level security/);
  assert.equal(/create policy[^;]+identity_lifecycle_event/.test(sql), false, "lifecycle evidence must remain server-managed");

  const start = sql.indexOf("create function corvis_control.apply_identity_lifecycle(");
  assert.ok(start >= 0, "apply_identity_lifecycle must be defined in the baseline");
  const command = sql.slice(start, sql.indexOf("\n$$;", start));

  assert.match(command, /if found then[\s\S]*v_existing_hash <> v_request_hash[\s\S]*identity lifecycle event replay conflict/);
  assert.match(command, /v_existing_user_id <> p_user_id[\s\S]*identity subject is already mapped to a different user/);
  assert.match(command, /v_existing_status='disabled'[\s\S]*disabled identity requires explicit reactivation/);
  assert.match(command, /on conflict \(tenant_id,auth_method,subject\) do nothing/);
  assert.match(command, /update corvis_control\.membership m[\s\S]*not exists \([\s\S]*jsonb_array_elements\(p_memberships\)/);
  assert.match(command, /update corvis_control\.resource_entitlement e[\s\S]*not exists \([\s\S]*jsonb_array_elements\(p_memberships\)/);
  assert.match(command, /update corvis_control\.identity_subject s[\s\S]*s\.user_id=p_user_id/);
  assert.match(command, /update corvis_control\.service_identity_grant g[\s\S]*g\.status='active'/);
  assert.match(command, /insert into corvis_control\.audit_event/);
  assert.match(command, /'identity\.lifecycle\.' \|\| p_operation/);
});
