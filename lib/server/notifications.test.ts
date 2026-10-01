import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { DisabledEmailSender } from "../../adapters/email/disabled-email-sender.ts";
import { RecordingEmailSender } from "../../adapters/email/recording-email-sender.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

process.env.CORVIS_DEMO_MODE = "";
delete process.env.CORVIS_EMAIL_PROVIDER;
delete process.env.CORVIS_PUBLIC_APP_URL;

const { getServerConfig } = await import("./config.ts");
const { configuredEmailSender } = await import("./email-sender.ts");
const {
  bestEffortNotification, captureVerifiedRecipient, computeEmailRetryDelayMs, deliverInvitationEmail,
  getNotificationSettings, invitationLink, NotificationPreferenceError, processEmailDigests,
} = await import("./notifications.ts");

const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
const WORKSPACE = "33333333-cccc-4ccc-8ccc-333333333333";

class RecordingDb implements PostgresSqlApi {
  statements: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  failOn?: RegExp;
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> { await this.execute(sql, parameters); return []; }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    this.statements.push({ sql, parameters });
    if (this.failOn?.test(sql)) throw new Error("boom");
  }
  async health() { return true; }
}

function identity(overrides: Partial<RequestIdentity> = {}): RequestIdentity {
  return {
    subject: "person", tenantId: TENANT, workspaceId: WORKSPACE, roles: ["analyst"], authMethod: "oidc", sessionId: "s",
    entitlements: { workspaceIds: [WORKSPACE], sourceDocumentAccessAllowed: false }, authenticatedEmail: "Person@Example.com", emailVerified: true,
    ...overrides,
  };
}

const invitation = { invitationId: "i-1", tenantId: TENANT, workspaceId: WORKSPACE, workspaceName: "Growth", email: "new@example.com", roleName: "analyst", expiresAt: "2026-10-07T00:00:00.000Z" };

test("a notification failure inside a transaction is rolled back to its savepoint and never propagates", async () => {
  const db = new RecordingDb();
  db.failOn = /email_outbox/;
  await bestEffortNotification(db, "t", () => db.execute("insert into corvis_control.email_outbox values (1)"), { inTransaction: true });
  assert.deepEqual(db.statements.map((statement) => statement.sql.split(" ").slice(0, 3).join(" ")),
    ["savepoint corvis_notification", "insert into corvis_control.email_outbox", "rollback to savepoint"]);

  const outside = new RecordingDb();
  await bestEffortNotification(outside, "t", async () => { await outside.execute("insert into corvis_control.email_outbox values (1)"); });
  assert.equal(outside.statements.length, 1, "no savepoint outside a transaction");
});

test("an unknown or unset provider never sends: it fails closed to the disabled sender", () => {
  assert.equal(configuredEmailSender(getServerConfig({ NODE_ENV: "test" })).configured, false);
  assert.equal(configuredEmailSender(getServerConfig({ NODE_ENV: "test", CORVIS_EMAIL_PROVIDER: "definitely-not-reviewed" })).configured, false);
  assert.equal(configuredEmailSender(getServerConfig({ NODE_ENV: "test", CORVIS_DEMO_MODE: "true", CORVIS_EMAIL_PROVIDER: "disabled" })).configured, false);
});

test("the public app URL must be an https origin", () => {
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "https://app.example.com/some/path" }).publicAppUrl, "https://app.example.com");
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "http://app.example.com" }).publicAppUrl, undefined);
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "http://localhost:3000" }).publicAppUrl, "http://localhost:3000");
  assert.equal(getServerConfig({ NODE_ENV: "test", CORVIS_PUBLIC_APP_URL: "not a url" }).publicAppUrl, undefined);
});

test("only a verified claim from a human identity is recorded as a recipient address", async () => {
  for (const skipped of [identity({ emailVerified: false }), identity({ emailVerified: undefined }), identity({ authMethod: "service_account" }), identity({ authenticatedEmail: "not-an-email" })]) {
    const db = new RecordingDb();
    await captureVerifiedRecipient(skipped, db);
    assert.equal(db.statements.length, 0);
  }
  const db = new RecordingDb();
  await captureVerifiedRecipient(identity(), db);
  assert.deepEqual(db.statements[0]!.parameters, [TENANT, "oidc", "person", "person@example.com"], "addresses are normalized");
});

test("service identities have no notification settings", async () => {
  await assert.rejects(getNotificationSettings(identity({ authMethod: "service_account" }), { db: new RecordingDb(), sender: new DisabledEmailSender() }),
    (error) => error instanceof NotificationPreferenceError && error.status === 403);
});

test("invitation emails report their outcome, carry the one-time link, and never persist it", async () => {
  const off = new RecordingDb();
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: off, sender: new DisabledEmailSender(), appUrl: "https://app.corvis.test" }), "not_configured");
  assert.ok(off.statements[0]!.parameters.includes("provider_not_configured"));

  const noUrl = new RecordingDb();
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: noUrl, sender: new RecordingEmailSender(), appUrl: null }), "not_configured");
  assert.ok(noUrl.statements[0]!.parameters.includes("app_url_not_configured"));

  const db = new RecordingDb();
  const sender = new RecordingEmailSender();
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db, sender, appUrl: "https://app.corvis.test" }), "sent");
  assert.equal(sender.sent[0]!.to, "new@example.com");
  assert.ok(sender.sent[0]!.text.includes(invitationLink("https://app.corvis.test", invitation, "a".repeat(43))));
  assert.ok(db.statements.every((statement) => statement.parameters.every((value) => !String(value).includes("a".repeat(43)))), "the token is never written");

  const failing = new RecordingEmailSender([{ status: "failed", retryable: true, errorClass: "provider_timeout" }]);
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: new RecordingDb(), sender: failing, appUrl: "https://app.corvis.test" }), "failed");

  const broken = new RecordingDb();
  broken.failOn = /email_outbox/;
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: broken, sender: new DisabledEmailSender(), appUrl: "https://app.corvis.test" }), "not_configured", "a recording failure never throws into the invitation flow or changes its outcome");
});

test("an outbox insert failure after a successful send still reports the invitation as sent", async () => {
  const broken = new RecordingDb();
  broken.failOn = /email_outbox/;
  const sender = new RecordingEmailSender();
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: broken, sender, appUrl: "https://app.corvis.test" }), "sent");
  assert.equal(sender.sent.length, 1, "the email went out exactly once");
  assert.equal(broken.statements.length, 1, "the failed record is not retried");

  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: broken, sender: new RecordingEmailSender([{ status: "failed", retryable: false, errorClass: "rejected" }]), appUrl: "https://app.corvis.test" }), "failed");
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: broken, sender: new RecordingEmailSender(), appUrl: null }), "not_configured");
});

/** In-memory outbox + preference store answering exactly the statements processEmailDigests issues. */
class DigestDb extends RecordingDb {
  pending = new Map<string, { category: string; status: string; reason?: string }>();
  preferences = new Map<string, { enabled: boolean; delivery: string }>();
  identityActive = true;
  digestParameters?: PostgresPrimitive[];
  override async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.statements.push({ sql, parameters });
    if (sql.includes("group by tenant_id,recipient_user_id")) {
      return [...this.pending.values()].some((row) => row.status === "digest_pending") ? [{ tenant_id: TENANT, recipient_user_id: USER }] : [];
    }
    if (sql.includes("where tenant_id=$1::uuid and recipient_user_id=$2::uuid and status='digest_pending'") && sql.includes("workspace_id::text")) {
      return [...this.pending].filter(([, row]) => row.status === "digest_pending")
        .map(([id, row]) => ({ email_id: id, tenant_id: TENANT, category: row.category, recipient_user_id: USER, workspace_id: WORKSPACE, fund_id: null, required_roles: null }));
    }
    if (sql.includes("as pref_enabled")) {
      const preference = this.preferences.get(String(parameters[2]));
      return [{ email: "person@example.com", pref_enabled: preference?.enabled ?? null, pref_delivery: preference?.delivery ?? null,
        identity_active: this.identityActive, member_active: true, fund_entitled: true, workspace_name: "Growth" }];
    }
    if (sql.includes("'digest'::text")) {
      this.digestParameters = parameters;
      const ids = JSON.parse(String(parameters[3])) as string[];
      const bundled = ids.filter((id) => this.pending.get(id)?.status === "digest_pending");
      for (const id of bundled) this.pending.get(id)!.status = "digested";
      return bundled.length ? bundled.map((id) => ({ email_id: id })) : [];
    }
    return [];
  }
  override async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    await super.execute(sql, parameters);
    if (sql.includes("status='suppressed'") && sql.includes("status='digest_pending'")) {
      const row = this.pending.get(String(parameters[0]));
      if (row?.status === "digest_pending") { row.status = "suppressed"; row.reason = String(parameters[1]); }
    }
  }
}

const USER = "22222222-bbbb-4bbb-8bbb-222222222222";

function digestFixture() {
  const db = new DigestDb();
  db.pending.set("e-pinned", { category: "pinned_fund_published", status: "digest_pending" });
  db.pending.set("e-source", { category: "source_attention", status: "digest_pending" });
  return db;
}

test("the daily digest bundles deferred items that are still enabled and still on daily_digest", async () => {
  const db = digestFixture();
  db.preferences.set("source_attention", { enabled: true, delivery: "daily_digest" });
  assert.deepEqual(await processEmailDigests({ db }), { digests: 1 });
  assert.deepEqual(JSON.parse(String(db.digestParameters![3])).sort(), ["e-pinned", "e-source"]);
  assert.deepEqual([...db.pending.values()].map((row) => row.status), ["digested", "digested"]);
});

test("the daily digest drops items whose category was switched off after they were deferred", async () => {
  const db = digestFixture();
  db.preferences.set("pinned_fund_published", { enabled: false, delivery: "daily_digest" });
  db.preferences.set("source_attention", { enabled: true, delivery: "daily_digest" });
  assert.deepEqual(await processEmailDigests({ db }), { digests: 1 });
  assert.deepEqual(db.pending.get("e-pinned"), { category: "pinned_fund_published", status: "suppressed", reason: "opted_out" });
  assert.equal(db.pending.get("e-source")!.status, "digested");
  assert.deepEqual(JSON.parse(String(db.digestParameters![3])), ["e-source"], "only the still-enabled item is bundled");

  const allOff = digestFixture();
  allOff.preferences.set("pinned_fund_published", { enabled: false, delivery: "daily_digest" });
  allOff.preferences.set("source_attention", { enabled: false, delivery: "immediate" });
  assert.deepEqual(await processEmailDigests({ db: allOff }), { digests: 0 });
  assert.equal(allOff.digestParameters, undefined, "no digest row is created when nothing survives");
  assert.deepEqual([...allOff.pending.values()].map((row) => [row.status, row.reason]), [["suppressed", "opted_out"], ["suppressed", "opted_out"]]);
});

test("the daily digest drops items for a recipient who lost access after they were deferred", async () => {
  const db = digestFixture();
  db.identityActive = false;
  assert.deepEqual(await processEmailDigests({ db }), { digests: 0 });
  assert.deepEqual([...db.pending.values()].map((row) => [row.status, row.reason]), [["suppressed", "not_eligible"], ["suppressed", "not_eligible"]]);
});

test("email retries back off exponentially and cap at one hour", () => {
  assert.equal(computeEmailRetryDelayMs(1), 60_000);
  assert.equal(computeEmailRetryDelayMs(3), 240_000);
  assert.equal(computeEmailRetryDelayMs(20), 3_600_000);
});
