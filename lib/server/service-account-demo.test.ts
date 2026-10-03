import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import type { AuditEvent, RequestIdentity } from "../../core/enterprise.ts";
import type { ServiceAccount, ServiceAccountCreated } from "../../core/service-account.ts";
import { DemoServiceAccountStore } from "../../adapters/demo/service-account-store.ts";
import { ServiceAccountError } from "./service-account.ts";

// See lib/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("./test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_POSTGRES_DSN;
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";

// Demo mode must never reach a database: any outbound request fails the test that made it.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`unexpected network call in demo mode: ${url}${init?.method ? ` ${init.method}` : ""}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });

const { GET: listGet, POST: createPost } = await import("@/app/api/v1/access/service-accounts/route");
const { GET: itemGet, POST: itemPost } = await import("@/app/api/v1/access/service-accounts/[serviceAccountId]/route");
const { createServiceAccountService, demoServiceAccountService, overrideServiceAccountService, postgresServiceAccountService, serviceAccountService } = await import("./service-account-service.ts");
const { platform } = await import("./platform.ts");

const refusal = (code: string, status: number) => (error: unknown) => error instanceof ServiceAccountError && error.code === code && error.status === status;
const DAY = 86_400_000;
let clock = new Date("2026-10-03T12:00:00.000Z");
const store = () => new DemoServiceAccountStore(() => clock);
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "demo-admin", tenantId: "tenant-store", workspaceId: "workspace-store", workspaceDisplayName: "Primary Workspace", roles: ["admin"], isTenantAdmin: true, authMethod: "demo", sessionId: "s",
    entitlements: { workspaceIds: ["workspace-store"], sourceDocumentAccessAllowed: false }, ...overrides,
  };
}
const create = (demo: DemoServiceAccountStore, overrides: Record<string, unknown> = {}, who = identity()) => demo.create(who, {
  name: "Warehouse loader", purpose: "Loads published data", workspaceId: who.workspaceId, roleName: "analyst", expiresInDays: 365, credentialExpiresInDays: 90, ...overrides,
} as Parameters<DemoServiceAccountStore["create"]>[1]);
const rotate = (demo: DemoServiceAccountStore, id: string, overlapMinutes = 60) => demo.issueCredential(identity(), id, { action: "rotate", credentialExpiresInDays: 30, overlapMinutes });
const statuses = (account: ServiceAccount) => account.credentials.map((credential) => credential.status);

// ------------------------------------------------------------------ store
test("each demo tenant is seeded once: one account whose credential expires soon, one in regular use, one deactivated", async () => {
  const demo = store();
  const { serviceAccounts, workspaces } = await demo.list(identity());
  assert.deepEqual(serviceAccounts.map((account) => [account.name, account.status, account.expiringSoon]), [
    ["Compliance export reader", "active", false],
    ["Nightly reporting sync", "active", true],
    ["Retired data bridge", "disabled", false],
  ], "newest first");
  assert.deepEqual(workspaces, [{ workspaceId: "workspace-store", name: "Primary Workspace" }]);
  const nightly = serviceAccounts.find((account) => account.name === "Nightly reporting sync")!;
  assert.equal(nightly.workspaceName, "Primary Workspace");
  assert.equal(nightly.roleName, "analyst");
  assert.ok(nightly.lastUsedAt);
  assert.deepEqual(nightly.actions, { canIssue: false, canRotate: true, canRevoke: true, canDisable: true });
  const retired = serviceAccounts.find((account) => account.status === "disabled")!;
  assert.deepEqual([retired.actions.canDisable, retired.disableReason], [false, "Replaced by the nightly reporting sync"]);
  assert.deepEqual(statuses(retired), ["revoked"]);
  // Seeded once, and per tenant.
  assert.equal((await demo.list(identity())).serviceAccounts.length, 3);
  await create(demo);
  assert.equal((await demo.list(identity())).serviceAccounts.length, 4);
  assert.equal((await demo.list(identity({ tenantId: "another-tenant" }))).serviceAccounts.length, 3, "another tenant has its own");
  assert.equal((await demo.list(identity({ workspaceDisplayName: undefined }))).workspaces[0]!.name, "Primary Workspace", "the workspace name falls back");
  await assert.rejects(demo.get(identity({ tenantId: "yet-another" }), nightly.serviceAccountId), refusal("service_account_not_found", 404), "an account of another tenant is not found");
});

test("creating returns the secret once and holds only its hash; the account never exposes it again", async () => {
  const demo = store();
  const created = await create(demo, { credentialExpiresInDays: 10 });
  assert.match(created.credential.secret, /^corvis_sa_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.serviceAccount.createdBy, "demo-admin");
  assert.equal(created.serviceAccount.expiringSoon, true);
  assert.equal(created.credential.expiresAt, new Date(clock.getTime() + 10 * DAY).toISOString());
  assert.equal(JSON.stringify(await demo.list(identity())).includes(created.credential.secret), false);
  assert.equal(JSON.stringify(await demo.get(identity(), created.serviceAccount.serviceAccountId)).includes(created.credential.secret), false);
  // A credential never outlives its account.
  const short = await create(demo, { name: "Short lived", expiresInDays: 5, credentialExpiresInDays: 90 });
  assert.equal(short.credential.expiresAt, short.serviceAccount.expiresAt);
});

test("an account must be in the caller's workspace, have a name unused among active accounts, and fit the quota", async () => {
  const demo = store();
  await assert.rejects(create(demo, { workspaceId: "other-workspace" }), refusal("workspace_not_found", 404));
  await create(demo);
  await assert.rejects(create(demo, { name: "WAREHOUSE LOADER" }), refusal("service_account_name_in_use", 409), "names compare case-insensitively");
  const seeded = (await demo.list(identity())).serviceAccounts.find((account) => account.status === "disabled")!;
  await create(demo, { name: seeded.name }); // a deactivated account frees its name
  const quota = store();
  for (let index = 0; index < 98; index += 1) await create(quota, { name: `Integration number ${index}` });
  await assert.rejects(create(quota, { name: "One too many" }), refusal("service_account_limit_reached", 409));
});

test("rotation leaves the old credential valid for the overlap, then ends it; a second rotation ends the first overlap at once", async () => {
  const demo = store();
  const { serviceAccount, credential } = await create(demo);
  const first = await rotate(demo, serviceAccount.serviceAccountId, 60);
  assert.notEqual(first.credential.secret, credential.secret);
  assert.deepEqual(statuses(first.serviceAccount).sort(), ["active", "rotating_out"]);
  const old = first.serviceAccount.credentials.find((entry) => entry.credentialId === credential.credentialId)!;
  assert.equal(old.endsAt, new Date(clock.getTime() + 60 * 60_000).toISOString());
  assert.deepEqual(first.serviceAccount.actions, { canIssue: false, canRotate: true, canRevoke: true, canDisable: true });

  advance(61 * 60_000);
  assert.deepEqual(statuses(await demo.get(identity(), serviceAccount.serviceAccountId)).sort(), ["active", "retired"], "the overlap has ended");

  const second = await rotate(demo, serviceAccount.serviceAccountId, 30);
  const third = await rotate(demo, serviceAccount.serviceAccountId, 0);
  assert.equal(third.serviceAccount.credentials.filter((entry) => entry.status === "active" || entry.status === "rotating_out").length, 1, "with no overlap only the new credential is valid");
  assert.ok(second.credential.secret && third.credential.secret);

  // An overlap never outlasts the credential itself.
  const tiny = await create(demo, { name: "Tiny", expiresInDays: 1, credentialExpiresInDays: 1 });
  const rolled = await demo.issueCredential(identity(), tiny.serviceAccount.serviceAccountId, { action: "rotate", credentialExpiresInDays: 1, overlapMinutes: 1440 });
  const ended = rolled.serviceAccount.credentials.find((entry) => entry.credentialId === tiny.credential.credentialId)!;
  assert.equal(ended.endsAt, tiny.credential.expiresAt);
});

test("issue needs no credential in use and rotate needs one; revocation is immediate and every credential in use is revoked", async () => {
  const demo = store();
  const { serviceAccount } = await create(demo);
  const id = serviceAccount.serviceAccountId;
  await assert.rejects(demo.issueCredential(identity(), id, { action: "issue", credentialExpiresInDays: 30 }), refusal("service_account_credential_exists", 409));
  await assert.rejects(demo.issueCredential(identity(), "nope", { action: "issue", credentialExpiresInDays: 30 }), refusal("service_account_not_found", 404));
  await rotate(demo, id, 120);
  const revoked = await demo.revoke(identity(), id);
  assert.equal(revoked.revokedCredentials, 2);
  assert.deepEqual(statuses(revoked.serviceAccount), ["revoked", "revoked"]);
  assert.ok(revoked.serviceAccount.credentials.every((entry) => entry.revokedAt !== null && Date.parse(entry.endsAt!) <= clock.getTime()));
  assert.deepEqual(revoked.serviceAccount.actions, { canIssue: true, canRotate: false, canRevoke: false, canDisable: true });
  await assert.rejects(demo.revoke(identity(), id), refusal("service_account_no_active_credential", 409));
  await assert.rejects(rotate(demo, id), refusal("service_account_no_active_credential", 409));
  const reissued = await demo.issueCredential(identity(), id, { action: "issue", credentialExpiresInDays: 30 });
  assert.deepEqual(reissued.serviceAccount.actions, { canIssue: false, canRotate: true, canRevoke: true, canDisable: true });
  await assert.rejects(demo.revoke(identity(), "nope"), refusal("service_account_not_found", 404));
});

test("a current credential past its own expiry makes way for a new one without a rotation", async () => {
  const demo = store();
  const { serviceAccount } = await create(demo, { credentialExpiresInDays: 2 });
  advance(3 * DAY);
  const stale = await demo.get(identity(), serviceAccount.serviceAccountId);
  assert.deepEqual(statuses(stale), ["expired"]);
  assert.deepEqual(stale.actions, { canIssue: true, canRotate: false, canRevoke: false, canDisable: true });
  await assert.rejects(demo.revoke(identity(), serviceAccount.serviceAccountId), refusal("service_account_no_active_credential", 409), "an expired credential is not revoked: it is already unusable");
  await assert.rejects(rotate(demo, serviceAccount.serviceAccountId), refusal("service_account_no_active_credential", 409));
  const fresh = await demo.issueCredential(identity(), serviceAccount.serviceAccountId, { action: "issue", credentialExpiresInDays: 30 });
  assert.deepEqual(statuses(fresh.serviceAccount).sort(), ["active", "expired"]);
});

test("disabling deactivates the account for good: nothing can be issued, rotated or revoked afterwards", async () => {
  const demo = store();
  const { serviceAccount } = await create(demo);
  const id = serviceAccount.serviceAccountId;
  await rotate(demo, id, 120);
  const disabled = await demo.disable(identity({ subject: "second-admin" }), id, "Integration retired");
  assert.deepEqual([disabled.status, disabled.disabledBy, disabled.disableReason], ["disabled", "second-admin", "Integration retired"]);
  assert.deepEqual(statuses(disabled), ["revoked", "revoked"]);
  assert.deepEqual(disabled.actions, { canIssue: false, canRotate: false, canRevoke: false, canDisable: false });
  await assert.rejects(demo.disable(identity(), id, "Again"), refusal("service_account_not_active", 409));
  await assert.rejects(demo.issueCredential(identity(), id, { action: "issue", credentialExpiresInDays: 30 }), refusal("service_account_not_active", 409));
  await assert.rejects(demo.revoke(identity(), id), refusal("service_account_no_active_credential", 409));
  await assert.rejects(demo.disable(identity(), "nope", "Integration retired"), refusal("service_account_not_found", 404));
  // A credential already ended by a rotation keeps its earlier end date.
  const seeded = (await demo.list(identity())).serviceAccounts.find((account) => account.name === "Retired data bridge")!;
  assert.ok(seeded.credentials[0]!.endsAt);
});

test("an account past its own expiry can be disabled but not given a credential", async () => {
  const demo = store();
  const { serviceAccount } = await create(demo, { expiresInDays: 1, credentialExpiresInDays: 1 });
  advance(2 * DAY);
  const expired = await demo.get(identity(), serviceAccount.serviceAccountId);
  assert.equal(expired.status, "expired");
  await assert.rejects(demo.issueCredential(identity(), serviceAccount.serviceAccountId, { action: "issue", credentialExpiresInDays: 1 }), refusal("service_account_not_active", 409));
  assert.equal((await demo.disable(identity(), serviceAccount.serviceAccountId, "Cleaning up")).status, "disabled");
  clock = new Date("2026-10-03T12:00:00.000Z");
});

// ------------------------------------------------------------------ service
test("the service lets only a person who is an Organization Admin act, and audits what changed without any secret", async () => {
  const events: AuditEvent[] = [];
  const service = createServiceAccountService(store());
  const port = platform();
  const original = port.audit.bind(port);
  port.audit = async (event) => { events.push(event); await original(event); };
  try {
    const member = identity({ subject: "member", roles: ["analyst"], isTenantAdmin: false });
    const machine = identity({ subject: "service-account:x", authMethod: "service_account" });
    for (const who of [member, machine, identity({ isTenantAdmin: undefined })]) {
      await assert.rejects(service.list(who), refusal("tenant_admin_required", 403));
      await assert.rejects(service.get(who, "x"), refusal("tenant_admin_required", 403));
      await assert.rejects(service.create(who, { name: "Nope", purpose: "Nope", workspaceId: who.workspaceId, roleName: "viewer", expiresInDays: 30, credentialExpiresInDays: 30 }, "c"), refusal("tenant_admin_required", 403));
      await assert.rejects(service.act(who, "x", { action: "issue", credentialExpiresInDays: 30 }, "c"), refusal("tenant_admin_required", 403));
    }
    assert.equal(events.length, 0, "a refused command is not audited");

    const created = await service.create(identity(), { name: "Audited loader", purpose: "Loads published data", workspaceId: "workspace-store", roleName: "viewer", expiresInDays: 365, credentialExpiresInDays: 90 }, "corr-1");
    const id = created.serviceAccount.serviceAccountId;
    const rotated = await service.act(identity(), id, { action: "rotate", credentialExpiresInDays: 30, overlapMinutes: 15 }, "corr-2");
    assert.ok(rotated.credential!.secret);
    const revoked = await service.act(identity(), id, { action: "revoke", reason: "Key leaked in a log" }, "corr-3");
    assert.equal(revoked.credential, undefined, "only issue and rotate return a secret");
    const issued = await service.act(identity(), id, { action: "issue", credentialExpiresInDays: 30 }, "corr-4");
    const disabled = await service.act(identity(), id, { action: "disable", reason: "Integration retired" }, "corr-5");
    assert.equal(disabled.serviceAccount.status, "disabled");
    assert.equal(disabled.credential, undefined);
    await assert.rejects(service.act(identity(), id, { action: "disable", reason: "Again" }, "corr-6"), refusal("service_account_not_active", 409));

    assert.deepEqual(events.map((event) => [event.action, event.actorSubject, event.targetType, event.targetId, event.correlationId]), [
      ["service_account.created", "demo-admin", "service_account", id, "corr-1"],
      ["service_account.credential_rotated", "demo-admin", "service_account", id, "corr-2"],
      ["service_account.credential_revoked", "demo-admin", "service_account", id, "corr-3"],
      ["service_account.credential_issued", "demo-admin", "service_account", id, "corr-4"],
      ["service_account.disabled", "demo-admin", "service_account", id, "corr-5"],
    ], "the refused second disable left no success audit");
    assert.equal(events[0]!.metadata?.name, "Audited loader");
    assert.equal(events[0]!.metadata?.roleName, "viewer");
    assert.equal(events[0]!.metadata?.credentialId, created.credential.credentialId);
    assert.equal(events[1]!.metadata?.overlapMinutes, 15);
    assert.equal(events[2]!.metadata?.reason, "Key leaked in a log");
    assert.equal(events[2]!.metadata?.revokedCredentials, 2);
    assert.equal(events[3]!.metadata?.overlapMinutes, undefined, "an issue has no overlap");
    assert.equal(events[4]!.metadata?.reason, "Integration retired");
    const everything = JSON.stringify(events);
    for (const secret of [created.credential.secret, rotated.credential!.secret, issued.credential!.secret]) assert.equal(everything.includes(secret), false, "no audit event carries a secret");
    assert.equal((await service.get(identity(), id)).status, "disabled");
  } finally {
    port.audit = original;
  }
});

test("demo mode selects the demo service; an override pins another and is restorable", () => {
  assert.equal(serviceAccountService(), demoServiceAccountService);
  overrideServiceAccountService(postgresServiceAccountService);
  assert.equal(serviceAccountService(), postgresServiceAccountService);
  overrideServiceAccountService();
  assert.equal(serviceAccountService(), demoServiceAccountService);
});

// ------------------------------------------------------------------ routes
type Caller = { roles?: string; tenant?: string; subject?: string; method?: string; body?: unknown; rawBody?: string };
let sequence = 0;
function request(path: string, caller: Caller = {}): Request {
  sequence += 1;
  const hasBody = caller.body !== undefined || caller.rawBody !== undefined;
  return new Request(`https://corvis.test/api/v1${path}`, {
    method: caller.method ?? "GET",
    headers: {
      "x-correlation-id": `corr-sa-${sequence}`, "x-corvis-demo-roles": caller.roles ?? "admin", "x-corvis-demo-tenant": caller.tenant ?? `sa-route-${sequence}`,
      "x-corvis-demo-subject": caller.subject ?? "demo-admin", ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? caller.rawBody ?? JSON.stringify(caller.body) : undefined,
  });
}
const params = (serviceAccountId: string) => ({ params: Promise.resolve({ serviceAccountId }) });
type Json = { error?: string; data: ServiceAccountCreated & { serviceAccounts: ServiceAccount[]; workspaces: Array<{ workspaceId: string; name: string }>; serviceAccount: ServiceAccount; credential?: { secret: string } } & ServiceAccount };
const body = async (response: Response) => (await response.json()) as Json;

test("the routes list, create, show and act on accounts for an Organization Admin, in the caller's tenant only", async () => {
  const tenant = `sa-routes-${Date.now()}`;
  const listed = await listGet(request("/access/service-accounts", { tenant }));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  const { data: list } = await body(listed);
  assert.equal(list.serviceAccounts.length, 3);
  assert.equal(list.workspaces[0]!.workspaceId, "workspace_demo");

  const created = await createPost(request("/access/service-accounts", { tenant, method: "POST", body: { name: "Route loader", purpose: "Loads published data", workspaceId: "workspace_demo", roleName: "reviewer" } }));
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const { data: made } = await body(created);
  assert.match(made.credential!.secret, /^corvis_sa_/);
  assert.equal(made.serviceAccount.roleName, "reviewer");
  const id = made.serviceAccount.serviceAccountId;

  const shown = await body(await itemGet(request(`/access/service-accounts/${id}`, { tenant }), params(id)));
  assert.equal(shown.data.name, "Route loader");
  assert.equal(JSON.stringify(shown).includes(made.credential!.secret), false);
  const rotated = await itemPost(request(`/access/service-accounts/${id}`, { tenant, method: "POST", body: { action: "rotate", overlapMinutes: 5 } }), params(id));
  assert.equal(rotated.status, 200);
  assert.ok((await body(rotated)).data.credential!.secret);
  const revoked = await body(await itemPost(request(`/access/service-accounts/${id}`, { tenant, method: "POST", body: { action: "revoke", reason: "Rotation drill" } }), params(id)));
  assert.equal(revoked.data.credential, undefined);
  assert.equal(revoked.data.serviceAccount.actions.canRevoke, false);
  const disabled = await body(await itemPost(request(`/access/service-accounts/${id}`, { tenant, method: "POST", body: { action: "disable", reason: "Integration retired" } }), params(id)));
  assert.equal(disabled.data.serviceAccount.status, "disabled");

  // Another tenant never sees it.
  const other = await itemGet(request(`/access/service-accounts/${id}`, { tenant: `${tenant}-other` }), params(id));
  assert.equal(other.status, 404);
  assert.equal((await body(other)).error, "service_account_not_found");
});

test("the routes answer stable codes for bad input, a stale state and a caller who is not an Organization Admin", async () => {
  const tenant = `sa-codes-${Date.now()}`;
  const valid = { name: "Code loader", purpose: "Loads published data", workspaceId: "workspace_demo", roleName: "viewer" };
  for (const [overrides, error] of [[{ name: "x" }, "invalid_name"], [{ purpose: "" }, "invalid_purpose"], [{ roleName: "tenant_admin" }, "invalid_role"], [{ workspaceId: "a b" }, "invalid_workspace"], [{ expiresInDays: 9999 }, "invalid_expiry"]] as const) {
    const response = await createPost(request("/access/service-accounts", { tenant, method: "POST", body: { ...valid, ...overrides } }));
    assert.deepEqual([response.status, (await body(response)).error], [400, error]);
  }
  assert.equal((await createPost(request("/access/service-accounts", { tenant, method: "POST", rawBody: "{not json" }))).status, 400);
  assert.equal((await createPost(request("/access/service-accounts", { tenant, method: "POST", body: { ...valid, workspaceId: "elsewhere" } }))).status, 404);
  const made = await body(await createPost(request("/access/service-accounts", { tenant, method: "POST", body: valid })));
  const id = made.data.serviceAccount.serviceAccountId;
  assert.equal((await createPost(request("/access/service-accounts", { tenant, method: "POST", body: valid }))).status, 409, "the name is in use");
  for (const [command, status, error] of [
    [{ action: "issue" }, 409, "service_account_credential_exists"],
    [{ action: "teleport" }, 400, "invalid_action"],
    [{ action: "revoke" }, 400, "invalid_reason"],
    [{ action: "rotate", overlapMinutes: 5000 }, 400, "invalid_overlap"],
  ] as const) {
    const response = await itemPost(request(`/access/service-accounts/${id}`, { tenant, method: "POST", body: command }), params(id));
    assert.deepEqual([response.status, (await body(response)).error], [status, error], JSON.stringify(command));
  }
  assert.equal((await itemPost(request(`/access/service-accounts/${id}`, { tenant, method: "POST", rawBody: "[]" }), params(id))).status, 400);

  // A role without admin:manage is a 403 forbidden; the demo admin who is not an Organization Admin never gets this far.
  for (const roles of ["analyst", "reviewer", "read_only", "api_client"]) {
    assert.equal((await listGet(request("/access/service-accounts", { tenant, roles }))).status, 403, roles);
    assert.equal((await createPost(request("/access/service-accounts", { tenant, roles, method: "POST", body: valid }))).status, 403, roles);
    assert.equal((await itemPost(request(`/access/service-accounts/${id}`, { tenant, roles, method: "POST", body: { action: "disable", reason: "Nope" } }), params(id))).status, 403, roles);
  }
  assert.equal((await body(await itemGet(request(`/access/service-accounts/${id}`, { tenant }), params(id)))).data.status, "active", "a refused call changed nothing");
});
