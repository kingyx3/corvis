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
  getNotificationSettings, invitationLink, NotificationPreferenceError,
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
  assert.equal(await deliverInvitationEmail(invitation, "a".repeat(43), { db: broken, sender: new DisabledEmailSender(), appUrl: "https://app.corvis.test" }), "failed", "a recording failure never throws into the invitation flow");
});

test("email retries back off exponentially and cap at one hour", () => {
  assert.equal(computeEmailRetryDelayMs(1), 60_000);
  assert.equal(computeEmailRetryDelayMs(3), 240_000);
  assert.equal(computeEmailRetryDelayMs(20), 3_600_000);
});
