import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { PostgresDriverError } from "../../../platform/database/postgres-native.ts";
import { RateLimiter } from "../../../platform/http/rate-limit.ts";
import { authenticateScim, configureScim, createScimUser, scimErrorResponse, ScimError, VERIFIED_TOKEN_TTL_MS, type ScimConfiguration } from "./scim.ts";
import { TenantInvitationError } from "./tenant-invitations.ts";

const config: ScimConfiguration = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  authMethod: "oidc",
  defaultWorkspaceId: "22222222-2222-4222-8222-222222222222",
  defaultRoleName: "viewer",
};

type Call = { sql: string; parameters: PostgresPrimitive[] };

/**
 * Statements issued through the transaction handle are held back and only
 * "committed" (moved to `committed`) when the callback resolves, so a test can
 * assert that a failure part-way through leaves nothing behind.
 */
class TransactionalFakeDb implements PostgresSqlApi {
  committed: Call[] = [];
  transactions = 0;
  queryHandler: (sql: string, parameters: PostgresPrimitive[]) => PostgresRow[] = () => [];
  failWhen: ((sql: string) => unknown) | undefined;
  private run(target: Call[], sql: string, parameters: PostgresPrimitive[]): PostgresRow[] {
    const failure = this.failWhen?.(sql);
    if (failure) throw failure;
    target.push({ sql, parameters });
    return this.queryHandler(sql, parameters);
  }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> { return this.run(this.committed, sql, parameters); }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> { this.run(this.committed, sql, parameters); }
  async health(): Promise<boolean> { return true; }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    this.transactions += 1;
    const pending: Call[] = [];
    const tx: PostgresSqlApi = {
      query: async (sql, parameters = []) => this.run(pending, sql, parameters),
      execute: async (sql, parameters = []) => { this.run(pending, sql, parameters); },
      health: async () => true,
    };
    const result = await fn(tx);
    this.committed.push(...pending);
    return result;
  }
}

const admin = {
  subject: "admin-1", tenantId: config.tenantId, workspaceId: config.defaultWorkspaceId, roles: ["admin"], isTenantAdmin: true,
  entitlements: { workspaceIds: [config.defaultWorkspaceId] }, authMethod: "oidc", sessionId: "session-1",
} as unknown as RequestIdentity;

function scimDb(existingConfiguration?: PostgresRow): TransactionalFakeDb {
  const db = new TransactionalFakeDb();
  db.queryHandler = (sql) => {
    if (sql.includes("from corvis_control.workspace")) return [{ "?column?": 1 }];
    if (sql.includes("from corvis_control.tenant_scim_configuration")) return existingConfiguration ? [existingConfiguration] : [];
    return [];
  };
  return db;
}

test("configureScim writes the token and its audit event in one transaction, without recording the secret", async () => {
  const db = scimDb();
  const { token } = await configureScim(admin, "oidc", config.defaultWorkspaceId, "viewer", db, "corr-scim");
  assert.equal(db.transactions, 1);
  const audit = db.committed.find((call) => call.sql.includes("insert into corvis_control.audit_event"));
  assert.ok(audit, "an audit_event must be committed with the configuration");
  assert.ok(db.committed.some((call) => call.sql.includes("insert into corvis_control.tenant_scim_configuration")));
  assert.equal(audit.parameters[5], "access.scim.configured");
  assert.equal(audit.parameters[9], "corr-scim");
  const metadata = JSON.parse(String(audit.parameters[10])) as Record<string, unknown>;
  assert.equal(metadata.rotated, false);
  assert.equal(metadata.defaultRoleName, "viewer");
  for (const call of db.committed.filter((entry) => entry.sql.includes("audit_event"))) {
    assert.ok(!JSON.stringify(call.parameters).includes(token), "the bearer token must never reach the audit row");
  }
});

test("rotating an existing SCIM configuration is audited with the replaced settings", async () => {
  const db = scimDb({ enabled: true, auth_method: "saml", default_workspace_id: "old-workspace", default_role_name: "accountadmin" });
  await configureScim(admin, "oidc", config.defaultWorkspaceId, "viewer", db);
  const audit = db.committed.find((call) => call.sql.includes("insert into corvis_control.audit_event"))!;
  const metadata = JSON.parse(String(audit.parameters[10])) as Record<string, unknown>;
  assert.equal(metadata.rotated, true);
  assert.equal(metadata.previousAuthMethod, "saml");
  assert.equal(metadata.previousDefaultRoleName, "accountadmin");
});

test("a failed audit insert rolls the new SCIM token back", async () => {
  const db = scimDb();
  db.failWhen = (sql) => sql.includes("audit_event") ? new Error("audit insert failed") : undefined;
  await assert.rejects(configureScim(admin, "oidc", config.defaultWorkspaceId, "viewer", db), /audit insert failed/);
  assert.deepEqual(db.committed, [], "neither the configuration nor the audit row may be committed");
});

test("configureScim still rejects non-tenant-admins and unknown workspaces before writing anything", async () => {
  const db = scimDb();
  await assert.rejects(configureScim({ ...admin, isTenantAdmin: false }, "oidc", config.defaultWorkspaceId, "viewer", db), (error) => error instanceof TenantInvitationError && error.status === 403);
  db.queryHandler = () => [];
  await assert.rejects(configureScim(admin, "oidc", config.defaultWorkspaceId, "viewer", db), (error) => error instanceof TenantInvitationError && error.code === "workspace_not_found");
  assert.deepEqual(db.committed.filter((call) => call.sql.includes("insert")), []);
});

function lifecycleDb(domainAllowed = true): TransactionalFakeDb {
  const db = new TransactionalFakeDb();
  db.queryHandler = (sql, parameters) => {
    if (sql.includes("email_domain_allowed")) return [{ allowed: domainAllowed }];
    if (sql.includes("apply_identity_lifecycle")) return [{ result: { eventKey: String(parameters[1]), operation: parameters[5], subject: String(parameters[7]), userId: String(parameters[8]), activeMemberships: 1, revokedMemberships: 0, expiredEntitlements: 0, disabledSubjects: 0, disabledServiceGrants: 0 } }];
    if (sql.includes("insert into corvis_control.tenant_scim_identity")) return [{ scim_user_id: String(parameters[1]), external_id: String(parameters[2]), user_name: String(parameters[6]), active: parameters[7] }];
    return [];
  };
  return db;
}
const newUser = { userName: "New.User@Example.com", externalId: "ext-42" };

test("createScimUser provisions the identity and the SCIM row in one transaction", async () => {
  const db = lifecycleDb();
  const created = await createScimUser(config, newUser, "https://x/scim/v2/Users", "corr-1", db);
  assert.equal(db.transactions, 1);
  assert.equal(created.userName, "new.user@example.com");
  assert.equal(db.committed.filter((call) => call.sql.includes("apply_identity_lifecycle")).length, 1);
  assert.equal(db.committed.filter((call) => call.sql.includes("insert into corvis_control.tenant_scim_identity")).length, 1);
});

test("F7b: SCIM user creation is refused, before anything is provisioned, when the tenant verifies domains and the userName is not on one", async () => {
  const db = lifecycleDb(false);
  const seen: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  const answer = db.queryHandler;
  db.queryHandler = (sql, parameters) => { seen.push({ sql, parameters }); return answer(sql, parameters); };
  await assert.rejects(createScimUser(config, newUser, "https://x/scim/v2/Users", "corr-1", db),
    (error) => error instanceof ScimError && error.status === 400 && error.scimType === "invalidValue");
  const check = seen.find((call) => call.sql.includes("email_domain_allowed"));
  assert.deepEqual(check?.parameters, [config.tenantId, "new.user@example.com"], "the normalised userName is what is checked, for the SCIM tenant");
  assert.equal(seen.filter((call) => call.sql.includes("apply_identity_lifecycle") || call.sql.includes("insert into corvis_control.tenant_scim_identity")).length, 0);
  assert.deepEqual(db.committed, [], "nothing is committed");
});

test("an inactive SCIM user is provisioned and disabled inside the same transaction", async () => {
  const db = lifecycleDb();
  await createScimUser(config, { ...newUser, active: false }, "https://x/scim/v2/Users", "corr-1", db);
  assert.equal(db.transactions, 1);
  assert.equal(db.committed.filter((call) => call.sql.includes("apply_identity_lifecycle")).length, 2);
});

test("a failure after the identity was provisioned leaves neither identity nor SCIM row committed", async () => {
  const db = lifecycleDb();
  db.failWhen = (sql) => sql.includes("insert into corvis_control.tenant_scim_identity") ? new Error("crash before the SCIM row") : undefined;
  await assert.rejects(createScimUser(config, newUser, "https://x/scim/v2/Users", "corr-1", db), /crash before the SCIM row/);
  assert.deepEqual(db.committed, [], "a retry must not find a half-provisioned identity");
});

test("a concurrent duplicate create is a 409 and rolls the provisioned identity back", async () => {
  const db = lifecycleDb();
  db.failWhen = (sql) => sql.includes("insert into corvis_control.tenant_scim_identity") ? new PostgresDriverError("query", "23505") : undefined;
  await assert.rejects(createScimUser(config, newUser, "https://x/scim/v2/Users", "corr-1", db), (error) => error instanceof ScimError && error.status === 409);
  assert.deepEqual(db.committed, []);
});

test("an externalId whose identity subject already exists is a 409 uniqueness error, not a 500", async () => {
  for (const [fragment, driver] of [
    ["identity subject is already mapped to a different user", "native"],
    ["disabled identity requires explicit reactivation", "native"],
    ["identity subject is already mapped to a different user", "raw"],
    ["disabled identity requires explicit reactivation", "raw"],
  ] as const) {
    const db = lifecycleDb();
    // The native driver carries only the allowlisted fragment; other drivers and fakes carry the raw message.
    db.failWhen = (sql) => sql.includes("apply_identity_lifecycle")
      ? (driver === "native" ? new PostgresDriverError("query", "P0001", fragment) : new Error(fragment))
      : undefined;
    await assert.rejects(createScimUser(config, newUser, "https://x/scim/v2/Users", "corr-1", db), (error) => error instanceof ScimError && error.status === 409 && error.scimType === "uniqueness");
    assert.deepEqual(db.committed, []);
  }
  // Unrelated lifecycle failures stay opaque server errors.
  const db = lifecycleDb();
  db.failWhen = (sql) => sql.includes("apply_identity_lifecycle") ? new PostgresDriverError("query", "P0001", "invalid identity lifecycle fields") : undefined;
  await assert.rejects(createScimUser(config, newUser, "https://x/scim/v2/Users", "corr-1", db), (error) => !(error instanceof ScimError));
});

class QueueDb implements PostgresSqlApi {
  calls: Call[] = [];
  queryQueue: PostgresRow[][] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.queryQueue.shift() ?? [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

const TOKEN = "t".repeat(43);
function scimRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://corvis.test/api/v1/scim/v2/Users", { headers: { "x-corvis-tenant": config.tenantId, authorization: `Bearer ${TOKEN}`, ...headers } });
}

test("SCIM authentication is rate limited per client before the database is queried", async () => {
  const db = new QueueDb();
  const limits = { clientLimiter: new RateLimiter(2), tenantLimiter: new RateLimiter(1000), now: 1_000 };
  const attempt = () => authenticateScim(scimRequest({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), db, limits);
  await assert.rejects(attempt(), (error) => error instanceof ScimError && error.status === 401);
  await assert.rejects(attempt(), (error) => error instanceof ScimError && error.status === 401);
  assert.equal(db.calls.length, 2);
  await assert.rejects(attempt(), (error) => error instanceof ScimError && error.status === 429 && error.retryAfterSeconds === 60);
  assert.equal(db.calls.length, 2, "a limited request must not cost a database query");
  // Another client address has its own budget.
  await assert.rejects(authenticateScim(scimRequest({ "x-forwarded-for": "198.51.100.7" }), db, limits), (error) => error instanceof ScimError && error.status === 401);
});

test("the per-tenant SCIM budget holds even when the client address rotates", async () => {
  const db = new QueueDb();
  const limits = { clientLimiter: new RateLimiter(1000), tenantLimiter: new RateLimiter(2), now: 1_000 };
  const codes: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await authenticateScim(scimRequest({ "x-forwarded-for": `203.0.113.${i}` }), db, limits).catch((error: ScimError) => codes.push(error.status));
  }
  assert.deepEqual(codes, [401, 401, 429, 429]);
  assert.equal(db.calls.length, 2);
});

const VALID_ROW = { auth_method: "oidc", default_workspace_id: config.defaultWorkspaceId, default_role_name: "analyst" };

test("successful SCIM authentications never spend the per-tenant budget", async () => {
  const db = new QueueDb();
  db.queryQueue = Array.from({ length: 5 }, () => [VALID_ROW]);
  const limits = { clientLimiter: new RateLimiter(1000), tenantLimiter: new RateLimiter(2), verifiedTokens: new Map(), now: 1_000 };
  for (let i = 0; i < 5; i += 1) await authenticateScim(scimRequest(), db, limits);
  assert.equal(db.calls.length, 5, "outside a lockout every request re-checks the token in Postgres");
});

test("an attacker who exhausts the tenant budget cannot lock out a recently verified IdP token", async () => {
  const db = new QueueDb();
  const verifiedTokens = new Map();
  const limits = { clientLimiter: new RateLimiter(1000), tenantLimiter: new RateLimiter(2), verifiedTokens, now: 1_000 };
  db.queryQueue = [[VALID_ROW]];
  await authenticateScim(scimRequest(), db, limits);
  const attacker = () => authenticateScim(scimRequest({ authorization: `Bearer ${"a".repeat(43)}`, "cf-connecting-ip": "203.0.113.66" }), db, limits);
  await assert.rejects(attacker(), (error) => error instanceof ScimError && error.status === 401);
  await assert.rejects(attacker(), (error) => error instanceof ScimError && error.status === 401);
  await assert.rejects(attacker(), (error) => error instanceof ScimError && error.status === 429);
  const queries = db.calls.length;
  db.queryQueue = [[VALID_ROW]];
  const resolved = await authenticateScim(scimRequest(), db, limits);
  assert.equal(resolved.tenantId, config.tenantId);
  assert.equal(db.calls.length, queries + 1, "known tokens bypass the throttle but must re-check current authority");
  // A verification older than the TTL is not honoured during a lockout.
  const stale = new Map([...verifiedTokens].map(([key, entry]) => [key, { ...entry, expiresAt: entry.expiresAt - VERIFIED_TOKEN_TTL_MS }]));
  await assert.rejects(authenticateScim(scimRequest(), db, { ...limits, verifiedTokens: stale }), (error) => error instanceof ScimError && error.status === 429);
});

test("the SCIM client budget is keyed on cf-connecting-ip, not a caller-supplied x-forwarded-for", async () => {
  const db = new QueueDb();
  const limits = { clientLimiter: new RateLimiter(1), tenantLimiter: new RateLimiter(1000), verifiedTokens: new Map(), now: 1_000 };
  await assert.rejects(authenticateScim(scimRequest({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1" }), db, limits), (error) => error instanceof ScimError && error.status === 401);
  await assert.rejects(authenticateScim(scimRequest({ "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.2" }), db, limits), (error) => error instanceof ScimError && error.status === 429);
});

test("malformed SCIM credentials are throttled without ever reaching the database", async () => {
  const db = new QueueDb();
  const limits = { clientLimiter: new RateLimiter(1), tenantLimiter: new RateLimiter(1000), now: 1_000 };
  const bad = () => authenticateScim(scimRequest({ authorization: "Bearer short" }), db, limits);
  await assert.rejects(bad(), (error) => error instanceof ScimError && error.status === 401);
  await assert.rejects(bad(), (error) => error instanceof ScimError && error.status === 429);
  assert.equal(db.calls.length, 0);
});

test("a gateway-shaped SCIM request authenticates with the forwarded caller token", async () => {
  const db = new QueueDb();
  db.queryQueue = [[{ auth_method: "saml", default_workspace_id: config.defaultWorkspaceId, default_role_name: "analyst" }]];
  const resolved = await authenticateScim(
    scimRequest({ authorization: "Bearer gateway.service-account.token", "x-forwarded-authorization": `Bearer ${TOKEN}` }),
    db,
    { clientLimiter: new RateLimiter(5), tenantLimiter: new RateLimiter(5) },
  );
  assert.deepEqual(resolved, { tenantId: config.tenantId, authMethod: "saml", defaultWorkspaceId: config.defaultWorkspaceId, defaultRoleName: "analyst" });
});

function captureConsole(method: "error" | "warn" | "info", fn: () => void): string[] {
  const lines: string[] = [];
  const original = console[method];
  console[method] = (line: unknown) => { lines.push(String(line)); };
  try { fn(); } finally { console[method] = original; }
  return lines;
}

test("scimErrorResponse logs the class of an unexpected failure and keeps the 500 opaque", async () => {
  let response!: Response;
  const lines = captureConsole("error", () => { response = scimErrorResponse(new TypeError("select * from secret where token='abc'"), "corr-500"); });
  assert.equal(response.status, 500);
  const body = await response.json() as { detail: string };
  assert.equal(body.detail, "SCIM request failed");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(record.event, "scim.request_failed");
  assert.equal(record.errorName, "TypeError");
  assert.equal(record.correlationId, "corr-500");
  assert.ok(!lines[0]!.includes("secret"), "the error message can carry SQL values and must not be logged");
});

test("scimErrorResponse maps rate limits and database outages to retryable statuses", async () => {
  const limited = scimErrorResponse(new ScimError(429, "tooMany", "SCIM rate limit exceeded", 42));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "42");
  let outage!: Response;
  const lines = captureConsole("error", () => { outage = scimErrorResponse(new PostgresDriverError("connection", "CONNECT_TIMEOUT")); });
  assert.equal(outage.status, 503);
  assert.equal(outage.headers.get("retry-after"), "5");
  assert.equal((JSON.parse(lines[0]!) as Record<string, unknown>).event, "scim.database_unavailable");
  assert.equal(scimErrorResponse(new ScimError(404, "notFound", "SCIM user not found")).headers.get("retry-after"), null);
});

test("SCIM only accepts a token of an enabled configuration", async () => {
  const db = new QueueDb();
  db.queryQueue = [[VALID_ROW]];
  await authenticateScim(scimRequest(), db, { clientLimiter: new RateLimiter(100), tenantLimiter: new RateLimiter(100), verifiedTokens: new Map(), now: 1_000 });
  assert.match(db.calls[0]!.sql, /enabled=true/);
  assert.match(db.calls[0]!.sql, /token_sha256=\$2/);
});

test("a token that stops verifying is dropped from the lockout cache and stays refused during a lockout", async () => {
  const db = new QueueDb();
  const verifiedTokens = new Map();
  const limits = { clientLimiter: new RateLimiter(1000), tenantLimiter: new RateLimiter(2), verifiedTokens, now: 1_000 };
  db.queryQueue = [[VALID_ROW]];
  await authenticateScim(scimRequest(), db, limits);
  assert.equal(verifiedTokens.size, 1);
  // The token is now rotated/disabled: Postgres no longer knows it, so the failed check must evict the cached copy.
  db.queryQueue = [[]];
  await assert.rejects(authenticateScim(scimRequest(), db, limits), (error) => error instanceof ScimError && error.status === 401);
  assert.equal(verifiedTokens.size, 0, "a failed authentication evicts the token's cached verification");
  // Exhaust the tenant budget: the revoked token must not be honoured from the cache during the lockout.
  db.queryQueue = [[], []];
  const attacker = () => authenticateScim(scimRequest({ authorization: `Bearer ${"a".repeat(43)}`, "cf-connecting-ip": "203.0.113.66" }), db, limits);
  await assert.rejects(attacker(), (error) => error instanceof ScimError && error.status === 401);
  await assert.rejects(authenticateScim(scimRequest(), db, limits), (error) => error instanceof ScimError && error.status === 429);
});

test("the lockout cache is bounded to 1000 verified tokens, evicting the least recently verified", async () => {
  const db = new QueueDb();
  const verifiedTokens = new Map();
  const limits = { clientLimiter: new RateLimiter(100_000), tenantLimiter: new RateLimiter(100_000), verifiedTokens, now: 1_000 };
  const request = (i: number) => scimRequest({ authorization: `Bearer ${String(i).padStart(43, "0")}` });
  for (let i = 0; i < 1_005; i += 1) {
    db.queryQueue = [[VALID_ROW]];
    await authenticateScim(request(i), db, limits);
  }
  assert.equal(verifiedTokens.size, 1_000);
  const keys = [...verifiedTokens.keys()];
  const { createHash } = await import("node:crypto");
  const keyFor = (i: number) => `${config.tenantId}:${createHash("sha256").update(String(i).padStart(43, "0")).digest("hex")}`;
  assert.ok(!keys.includes(keyFor(0)) && !keys.includes(keyFor(4)), "the oldest entries were evicted");
  assert.ok(keys.includes(keyFor(5)) && keys.includes(keyFor(1_004)));
});


test("revocation during a tenant lockout cannot authenticate from cached SCIM configuration", async () => {
  const db = new QueueDb();
  const limits = { clientLimiter: new RateLimiter(1000), tenantLimiter: new RateLimiter(1), verifiedTokens: new Map(), now: 1000 };
  db.queryQueue = [[VALID_ROW]];
  await authenticateScim(scimRequest(), db, limits);
  await assert.rejects(authenticateScim(scimRequest({ authorization: `Bearer ${"a".repeat(43)}` }), db, limits));
  db.queryQueue = [[]]; // The previously verified token was rotated or disabled.
  await assert.rejects(authenticateScim(scimRequest(), db, limits), (error) => error instanceof ScimError && error.status === 401);
  assert.equal(limits.verifiedTokens.size, 0);
});
