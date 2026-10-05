import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { RateLimitError, RateLimiter } from "./rate-limit.ts";
import {
  authenticateScim, configureScim, createScimUser, getScimUser, listScimUsers, newScimToken, scimErrorResponse, ScimError, setScimUserActive,
  type ScimConfiguration,
} from "./scim.ts";
import { TenantInvitationError } from "./tenant-invitations.ts";

const config: ScimConfiguration = {
  tenantId: "11111111-1111-4111-8111-111111111111", authMethod: "oidc",
  defaultWorkspaceId: "22222222-2222-4222-8222-222222222222", defaultRoleName: "viewer",
};
const SCIM_ID = "33333333-3333-4333-8333-333333333333";
const BASE = "https://corvis.example/scim/v2/Users";

type Call = { sql: string; parameters: PostgresPrimitive[] };
class ScriptedDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  private readonly answer: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[];
  constructor(answer: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[] = () => []) { this.answer = answer; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> { this.calls.push({ sql, parameters }); return this.answer(sql, parameters); }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.calls.push({ sql, parameters }); }
  async health(): Promise<boolean> { return true; }
}

const admin = { subject: "admin", tenantId: config.tenantId, workspaceId: config.defaultWorkspaceId, roles: ["admin"], isTenantAdmin: true, authMethod: "oidc", sessionId: "s", entitlements: { workspaceIds: [] } } as unknown as RequestIdentity;

test("configuring SCIM refuses a non-admin, a malformed workspace and a role that cannot be provisioned", async () => {
  const db = new ScriptedDb();
  await assert.rejects(configureScim({ ...admin, isTenantAdmin: false }, "oidc", config.defaultWorkspaceId, "viewer", db), (e) => e instanceof TenantInvitationError && e.status === 403);
  await assert.rejects(configureScim(admin, "oidc", "not-a-uuid", "viewer", db), (e) => e instanceof TenantInvitationError && e.code === "invalid_scim_configuration");
  await assert.rejects(configureScim(admin, "oidc", config.defaultWorkspaceId, "tenant_admin" as never, db), (e) => e instanceof TenantInvitationError && e.code === "invalid_scim_configuration");
  assert.equal(db.calls.length, 0);
});

test("the SCIM client is identified by the edge address, then the forwarded address, then the real-ip header, then 'unknown'", async () => {
  const keys: string[] = [];
  const limiter = { consume(key: string) { keys.push(key); return { allowed: true, retryAfterSeconds: 0 }; }, peek() { return { allowed: true, retryAfterSeconds: 0 }; } } as unknown as RateLimiter;
  const limits = { clientLimiter: limiter, tenantLimiter: limiter, verifiedTokens: new Map() };
  const headers = (extra: Record<string, string | undefined>): Record<string, string> => ({ "x-corvis-tenant": config.tenantId, authorization: "Bearer short", ...extra });
  for (const extra of [{ "cf-connecting-ip": " 1.1.1.1 " }, { "x-forwarded-for": "2.2.2.2, 9.9.9.9" }, { "x-real-ip": "3.3.3.3" }, {}, { "x-real-ip": "4".repeat(100) }]) {
    await assert.rejects(authenticateScim(new Request(BASE, { headers: headers(extra) }), new ScriptedDb(), limits), (e) => e instanceof ScimError && e.status === 401);
  }
  assert.deepEqual(keys, ["1.1.1.1", "2.2.2.2", "3.3.3.3", "unknown", "4".repeat(64)]);
});

test("a configuration row with missing columns reads as empty strings, never as the text 'null'", async () => {
  const token = "T".repeat(43);
  const db = new ScriptedDb(() => [{ auth_method: "oidc", default_workspace_id: null, default_role_name: null }]);
  const verified = await authenticateScim(new Request(BASE, { headers: { "x-corvis-tenant": config.tenantId, authorization: `Bearer ${token}` } }), db, { clientLimiter: new RateLimiter(100, 60_000), tenantLimiter: new RateLimiter(100, 60_000), verifiedTokens: new Map() });
  assert.deepEqual([verified.defaultWorkspaceId, verified.defaultRoleName], ["", ""]);
});

test("SCIM failures map to their own status; a rate limit keeps Retry-After; an unknown failure is an opaque 500 that logs only its class", async (t) => {
  const logged: Array<Record<string, unknown>> = [];
  t.mock.method(console, "error", (line: unknown) => { logged.push(JSON.parse(String(line)) as Record<string, unknown>); });
  const limited = scimErrorResponse(new RateLimitError(7));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "7");
  const plain = scimErrorResponse(new Error("secret sql detail"), "corr-1");
  assert.equal(plain.status, 500);
  assert.equal(plain.headers.get("retry-after"), null);
  assert.ok(!JSON.stringify(await plain.json()).includes("secret sql detail"));
  scimErrorResponse("a thrown string");
  scimErrorResponse(Object.assign(new Error("x"), { code: "XX001" }));
  scimErrorResponse(Object.assign(new Error("x"), { code: 42 }));
  assert.deepEqual(logged.map((line) => [line.errorName, line.code]), [["Error", undefined], ["string", undefined], ["Error", "XX001"], ["Error", undefined]]);
});

test("listing honours the userName and externalId filters, an invalid page size and a missing count", async () => {
  const byName = new ScriptedDb((sql) => sql.includes("count(*)") ? [] : [{ scim_user_id: SCIM_ID, external_id: "e", user_name: "a@b.test", active: true }]);
  const page = await listScimUsers(config, BASE, ' userName eq " A@B.Test " ', byName, 1, -5);
  assert.equal(page.totalResults, 0, "no count row reads as zero");
  assert.equal(page.resources[0]?.userName, "a@b.test");
  assert.deepEqual(byName.calls[0]!.parameters, [config.tenantId, "a@b.test"]);
  assert.match(byName.calls[0]!.sql, /user_name=\$2/);
  assert.equal(byName.calls[1]!.parameters[2], "200", "an invalid count falls back to the page limit");
  const byExternal = new ScriptedDb();
  await listScimUsers(config, BASE, 'externalId eq "ext-1"', byExternal, 1.5, 2.5);
  assert.match(byExternal.calls[0]!.sql, /external_id=\$2/);
  assert.deepEqual(byExternal.calls[1]!.parameters.slice(2), ["200", "0"]);
  await assert.rejects(listScimUsers(config, BASE, "displayName eq x", byExternal), (e) => e instanceof ScimError && e.scimType === "invalidFilter");
});

test("creating a SCIM user validates its name and external id before anything is queried", async () => {
  const db = new ScriptedDb();
  for (const input of [{}, { userName: 5, externalId: "e" }, { userName: "not-an-email", externalId: "e" }, { userName: "a@b.test" }, { userName: "a@b.test", externalId: 7 }, { userName: "a@b.test", externalId: "x".repeat(1025) }]) {
    await assert.rejects(createScimUser(config, input, BASE, "corr", db), (e) => e instanceof ScimError && e.status === 400 && e.scimType === "invalidValue");
  }
  assert.equal(db.calls.length, 0);
  await assert.rejects(createScimUser(config, { userName: "a@b.test", externalId: "e" }, BASE, "corr", new ScriptedDb((sql) => sql.includes("tenant_scim_identity where") ? [{ "?column?": 1 }] : [])), (e) => e instanceof ScimError && e.status === 409);
});

test("a SCIM user is read by id: a malformed or unknown id is a 404", async () => {
  await assert.rejects(getScimUser(config, "nope", BASE, new ScriptedDb()), (e) => e instanceof ScimError && e.status === 404);
  await assert.rejects(getScimUser(config, SCIM_ID, BASE, new ScriptedDb()), (e) => e instanceof ScimError && e.status === 404);
  const found = await getScimUser(config, SCIM_ID, BASE, new ScriptedDb(() => [{ scim_user_id: SCIM_ID, external_id: "e", user_name: "a@b.test", active: false }]));
  assert.deepEqual(found, { id: SCIM_ID, externalId: "e", userName: "a@b.test", active: false, meta: { resourceType: "User", location: `${BASE}/${SCIM_ID}` } });
});

test("deactivating and reactivating a SCIM user go through the identity lifecycle, and no change does nothing", async () => {
  await assert.rejects(setScimUserActive(config, "nope", false, "corr", new ScriptedDb()), (e) => e instanceof ScimError && e.status === 404);
  await assert.rejects(setScimUserActive(config, SCIM_ID, false, "corr", new ScriptedDb()), (e) => e instanceof ScimError && e.status === 404);

  const row = (active: boolean) => ({ user_id: "44444444-4444-4444-8444-444444444444", auth_method: "oidc", subject: "ext-1", active });
  const answer = (active: boolean) => (sql: string, parameters: PostgresPrimitive[]) => {
    if (sql.includes("for update")) return [row(active)];
    if (sql.includes("apply_identity_lifecycle")) return [{ result: { eventKey: String(parameters[1]), operation: parameters[5], subject: "ext-1", userId: String(parameters[8]), activeMemberships: 0, revokedMemberships: 1, expiredEntitlements: 0, disabledSubjects: 1, disabledServiceGrants: 0 } }];
    return [];
  };

  const unchanged = new ScriptedDb(answer(true));
  await setScimUserActive(config, SCIM_ID, true, "corr", unchanged);
  assert.equal(unchanged.calls.some((call) => call.sql.includes("update corvis_control.tenant_scim_identity")), false);

  const disable = new ScriptedDb(answer(true));
  await setScimUserActive(config, SCIM_ID, false, "corr", disable);
  assert.ok(disable.calls.some((call) => call.sql.includes("apply_identity_lifecycle")));
  assert.deepEqual(disable.calls.find((call) => call.sql.includes("update corvis_control.tenant_scim_identity"))?.parameters, [config.tenantId, SCIM_ID, false]);

  const enable = new ScriptedDb(answer(false));
  await setScimUserActive(config, SCIM_ID, true, "corr", enable);
  const reactivate = enable.calls.find((call) => call.sql.includes("reactivate_identity_admin"));
  assert.ok(reactivate);
  assert.deepEqual(JSON.parse(String(reactivate.parameters[8])), [{ workspaceId: config.defaultWorkspaceId, roleName: "viewer" }]);
  assert.deepEqual(enable.calls.find((call) => call.sql.includes("update corvis_control.tenant_scim_identity"))?.parameters, [config.tenantId, SCIM_ID, true]);
});

test("a new SCIM token is a long random URL-safe string, different every time", () => {
  const first = newScimToken();
  assert.match(first, /^[A-Za-z0-9_-]{40,100}$/);
  assert.notEqual(first, newScimToken());
});
