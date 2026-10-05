import { normalizeDisplayPreferences, type DisplayPreferences } from "../../workspace/domain/display-preferences.ts";
import { randomUUID } from "node:crypto";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import {
  AUDIENCE_ROLES,
  NOTIFICATION_CATEGORIES,
  NotificationPreferenceError,
  categoryVisibleTo,
  effectivePreference,
  normalizePreferenceChanges,
  notificationCategory,
  renderEmail,
  type EmailSender,
  type NotificationCategoryId,
  type NotificationSettings,
  type OutboxCategory,
  type StoredPreference,
} from "../domain/notifications.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import { configuredEmailSender } from "./email-sender.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { logEvent } from "../../../platform/observability/telemetry.ts";

export { NotificationPreferenceError };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_RETRY_BASE_MS = 60_000;
const EMAIL_RETRY_MAX_MS = 60 * 60_000;
/** A digest is sent once the recipient's oldest pending item is this old. */
export const DIGEST_WINDOW_HOURS = 24;
const SENDING_LEASE_MINUTES = 5;

function dbDefault(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }
function text(row: PostgresRow | undefined, key: string): string { return row?.[key] == null ? "" : String(row[key]); }
function isHuman(identity: RequestIdentity): boolean { return identity.authMethod === "oidc" || identity.authMethod === "saml"; }
function viewerOf(identity: RequestIdentity) { return { isAdmin: identity.roles.includes("admin"), isTenantAdmin: identity.isTenantAdmin === true }; }
function json(value: unknown): string { return JSON.stringify(value); }

export function computeEmailRetryDelayMs(attempt: number): number {
  return Math.min(EMAIL_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), EMAIL_RETRY_MAX_MS);
}

/**
 * Runs `fn` so that a failure can never abort the caller's command.
 * Notifications are a side effect: a notification bug must never block
 * publishing, access administration or export delivery. Pass `inTransaction`
 * when `db` is an open transaction: a savepoint then isolates the failed
 * statement so the caller's transaction can still commit (on a transport with
 * no transaction the savepoint fails and `fn` simply runs best effort).
 */
export async function bestEffortNotification(db: PostgresSqlApi, label: string, fn: () => Promise<void>, options: { inTransaction?: boolean } = {}): Promise<void> {
  let savepoint = false;
  if (options.inTransaction) {
    try { await db.execute("savepoint corvis_notification"); savepoint = true; } catch { /* not in a transaction */ }
  }
  try {
    await fn();
    if (savepoint) await db.execute("release savepoint corvis_notification");
  } catch (error) {
    if (savepoint) await db.execute("rollback to savepoint corvis_notification").catch(() => undefined);
    logEvent("error", "notifications.enqueue_failed", { correlationId: label }, { label, errorName: error instanceof Error ? error.name : typeof error });
  }
}

// ---------------------------------------------------------------------------
// Recipients and preferences
// ---------------------------------------------------------------------------

/**
 * Records the caller's address from a verified identity claim. Unverified or
 * missing claims, service identities and demo mode are ignored. The row is
 * only rewritten when the address actually changed.
 */
export async function captureVerifiedRecipient(identity: RequestIdentity, db?: PostgresSqlApi): Promise<void> {
  if (getServerConfig().demoMode || !isHuman(identity) || identity.emailVerified !== true) return;
  const email = identity.authenticatedEmail?.trim().toLowerCase() ?? "";
  if (!EMAIL.test(email) || email.length > 320) return;
  await (db ?? dbDefault()).execute(`insert into corvis_control.notification_recipient (tenant_id,user_id,email,source,verified_at,updated_at)
    select s.tenant_id,s.user_id,$4,'verified_identity_claim',now(),now()
    from corvis_control.identity_subject s
    where s.tenant_id=$1::uuid and s.auth_method=$2 and s.subject=$3 and s.status='active'
    limit 1
    on conflict (tenant_id,user_id) do update set email=excluded.email,source=excluded.source,verified_at=now(),updated_at=now()
      where corvis_control.notification_recipient.email <> excluded.email`,
  [identity.tenantId, identity.authMethod, identity.subject, email]);
}

/** An accepted invitation proves the invited address belongs to the new user. */
export async function recordAcceptedInvitationRecipient(db: PostgresSqlApi, tenantId: string, userId: string, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 320) return;
  await db.execute(`insert into corvis_control.notification_recipient (tenant_id,user_id,email,source,verified_at,updated_at)
    values ($1::uuid,$2::uuid,$3,'accepted_invitation',now(),now())
    on conflict (tenant_id,user_id) do update set email=excluded.email,source=excluded.source,verified_at=now(),updated_at=now()
      where corvis_control.notification_recipient.email <> excluded.email`, [tenantId, userId, normalized]);
}

type SettingsDependencies = { db?: PostgresSqlApi; sender?: EmailSender };

function buildSettings(identity: RequestIdentity, address: string | null, stored: StoredPreference[], sender: EmailSender): NotificationSettings {
  const viewer = viewerOf(identity);
  const byCategory = new Map(stored.map((row) => [row.category, row]));
  return {
    emailDelivery: sender.configured && getServerConfig().publicAppUrl ? "active" : "not_configured",
    address,
    categories: NOTIFICATION_CATEGORIES.filter((category) => categoryVisibleTo(category, viewer)).map((category) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      mandatory: category.mandatory,
      ...effectivePreference(category, byCategory.get(category.id)),
    })),
  };
}

async function userIdFor(db: PostgresSqlApi, identity: RequestIdentity): Promise<string | null> {
  const rows = await db.query(`select user_id::text from corvis_control.identity_subject
    where tenant_id=$1::uuid and auth_method=$2 and subject=$3 and status='active' limit 1`,
  [identity.tenantId, identity.authMethod, identity.subject]);
  return text(rows[0], "user_id") || null;
}

export async function getNotificationSettings(identity: RequestIdentity, dependencies: SettingsDependencies = {}): Promise<NotificationSettings> {
  const sender = dependencies.sender ?? configuredEmailSender();
  if (getServerConfig().demoMode || identity.authMethod === "demo") {
    return buildSettings(identity, identity.authenticatedEmail ?? null, [], sender);
  }
  if (!isHuman(identity)) throw new NotificationPreferenceError("human_identity_required", 403);
  const db = dependencies.db ?? dbDefault();
  const userId = await userIdFor(db, identity);
  if (!userId) return buildSettings(identity, null, [], sender);
  const [recipients, preferences] = await Promise.all([
    db.query(`select email from corvis_control.notification_recipient where tenant_id=$1::uuid and user_id=$2::uuid`, [identity.tenantId, userId]),
    db.query(`select category,enabled,delivery from corvis_control.notification_preference where tenant_id=$1::uuid and user_id=$2::uuid`, [identity.tenantId, userId]),
  ]);
  return buildSettings(identity, text(recipients[0], "email") || null, preferences.map((row) => ({
    category: text(row, "category"), enabled: row.enabled === true || row.enabled === "true", delivery: text(row, "delivery"),
  })), sender);
}

export async function updateNotificationPreferences(identity: RequestIdentity, body: unknown, dependencies: SettingsDependencies = {}): Promise<NotificationSettings> {
  const changes = normalizePreferenceChanges(body, viewerOf(identity));
  const sender = dependencies.sender ?? configuredEmailSender();
  if (getServerConfig().demoMode || identity.authMethod === "demo") {
    // Demo mode keeps no per-user state; echo the validated change.
    return buildSettings(identity, identity.authenticatedEmail ?? null, changes.map((change) => ({ category: change.id, enabled: change.enabled, delivery: change.delivery })), sender);
  }
  if (!isHuman(identity)) throw new NotificationPreferenceError("human_identity_required", 403);
  const db = dependencies.db ?? dbDefault();
  const userId = await userIdFor(db, identity);
  if (!userId) throw new NotificationPreferenceError("identity_not_found", 404);
  for (const change of changes) {
    await db.execute(`insert into corvis_control.notification_preference (tenant_id,user_id,category,enabled,delivery,updated_at)
      values ($1::uuid,$2::uuid,$3,$4,$5,now())
      on conflict (tenant_id,user_id,category) do update set enabled=excluded.enabled,delivery=excluded.delivery,updated_at=now()`,
    [identity.tenantId, userId, change.id, change.enabled, change.delivery]);
  }
  return getNotificationSettings(identity, { db, sender });
}

// ---------------------------------------------------------------------------
// Enqueueing (the transactional side of the outbox)
// ---------------------------------------------------------------------------

type Scope = { workspaceId?: string | null; fundId?: string | null; requiredRoles?: readonly string[] | null };

const INSERT_COLUMNS = "tenant_id,category,recipient_user_id,workspace_id,fund_id,required_roles,template_params,dedupe_key";
const ROLES_SQL = (parameter: string) => `case when ${parameter}::jsonb is null then null else array(select jsonb_array_elements_text(${parameter}::jsonb)) end`;

export async function enqueueForUser(db: PostgresSqlApi, input: Scope & {
  tenantId: string; userId: string; category: NotificationCategoryId; params?: Record<string, PostgresPrimitive>; dedupeKey: string;
}): Promise<void> {
  await db.execute(`insert into corvis_control.email_outbox (${INSERT_COLUMNS})
    values ($1::uuid,$2::text,$3::uuid,$4::uuid,$5::text,${ROLES_SQL("$6")},$7::jsonb,$8::text)
    on conflict (tenant_id,dedupe_key) do nothing`,
  [input.tenantId, input.category, input.userId, input.workspaceId ?? null, input.fundId ?? null,
    input.requiredRoles ? json(input.requiredRoles) : null, json(input.params ?? {}), input.dedupeKey]);
}

/** One row per active member holding one of `roles` (in `workspaceId`, or anywhere in the tenant). */
export async function enqueueForRoleAudience(db: PostgresSqlApi, input: {
  tenantId: string; workspaceId: string | null; roles: readonly string[]; category: NotificationCategoryId;
  params?: Record<string, PostgresPrimitive>; dedupeBase: string;
}): Promise<void> {
  await db.execute(`insert into corvis_control.email_outbox (${INSERT_COLUMNS})
    select distinct m.tenant_id,$2::text,m.user_id,$3::uuid,null::text,${ROLES_SQL("$4")},$5::jsonb,$6::text || ':' || m.user_id::text
    from corvis_control.membership m
    where m.tenant_id=$1::uuid and ($3::uuid is null or m.workspace_id=$3::uuid)
      and m.role_name in (select jsonb_array_elements_text($4::jsonb))
      and m.status='active' and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now())
    on conflict (tenant_id,dedupe_key) do nothing`,
  [input.tenantId, input.category, input.workspaceId, json(input.roles), json(input.params ?? {}), input.dedupeBase]);
}

export async function enqueueExportReady(db: PostgresSqlApi, input: {
  tenantId: string; exportId: string; workspaceId: string | null; authMethod: string; subject: string; format: string;
}): Promise<void> {
  await db.execute(`insert into corvis_control.email_outbox (${INSERT_COLUMNS})
    select s.tenant_id,'export_ready',s.user_id,$4::uuid,null,null,jsonb_build_object('format',$5::text),'export_ready:' || $6::text
    from corvis_control.identity_subject s
    where s.tenant_id=$1::uuid and s.auth_method=$2::text and s.subject=$3::text and s.auth_method in ('oidc','saml')
    limit 1
    on conflict (tenant_id,dedupe_key) do nothing`,
  [input.tenantId, input.authMethod, input.subject, input.workspaceId, input.format, input.exportId]);
}

/** Everyone who pinned the snapshot's fund, per workspace they pinned it in. Entitlement is re-checked at send time. */
export async function enqueuePinnedFundPublished(db: PostgresSqlApi, input: { tenantId: string; snapshotId: string }): Promise<void> {
  await db.execute(`insert into corvis_control.email_outbox (${INSERT_COLUMNS})
    select distinct p.tenant_id,'pinned_fund_published',s.user_id,p.workspace_id,snap.fund_id,null::text[],'{}'::jsonb,
      'pinned_fund_published:' || snap.snapshot_id::text || ':' || snap.version::text || ':' || p.workspace_id::text || ':' || s.user_id::text
    from (
      select fund_id,snapshot_id,version from corvis_consolidated.fund_period_snapshot
      where tenant_id=$1::uuid and snapshot_id=$2::uuid and status='published'
      order by version desc limit 1
    ) snap
    join corvis_control.workspace_user_preference p on p.tenant_id=$1::uuid and snap.fund_id=any(p.pinned_fund_ids)
    join corvis_control.identity_subject s on s.tenant_id=p.tenant_id and s.auth_method=p.auth_method and s.subject=p.subject and s.status='active'
    where p.auth_method in ('oidc','saml')
    on conflict (tenant_id,dedupe_key) do nothing`, [input.tenantId, input.snapshotId]);
}

export function supportAccessAudienceRoles(): readonly string[] { return AUDIENCE_ROLES.organization_admins; }
export function sourceAttentionAudienceRoles(): readonly string[] { return AUDIENCE_ROLES.workspace_admins; }

// ---------------------------------------------------------------------------
// Dispatch (the worker side of the outbox)
// ---------------------------------------------------------------------------

export type OutboxRunResult = { claimed: number; sent: number; suppressed: number; digestPending: number; retried: number; deadLettered: number };

type DispatchDependencies = { db?: PostgresSqlApi; sender?: EmailSender; appUrl?: string | null; limit?: number };

type Eligibility = {
  email: string | null;
  preference?: StoredPreference;
  identityActive: boolean;
  memberActive: boolean;
  fundEntitled: boolean;
  workspaceName: string | null;
  displayPreferences?: DisplayPreferences;
};

async function eligibility(db: PostgresSqlApi, row: PostgresRow): Promise<Eligibility> {
  const category = text(row, "category");
  const requireMembership = category !== "role_changed";
  const roles = Array.isArray(row.required_roles) ? row.required_roles.map(String) : null;
  const result = (await db.query(`select
      (select p.display_preferences from corvis_control.workspace_user_preference p join corvis_control.identity_subject s on s.tenant_id=p.tenant_id and s.auth_method=p.auth_method and s.subject=p.subject where s.tenant_id=$1::uuid and s.user_id=$2::uuid and p.display_preferences is not null order by p.updated_at desc limit 1) as display_preferences,
      (select r.email from corvis_control.notification_recipient r where r.tenant_id=$1::uuid and r.user_id=$2::uuid) as email,
      (select p.enabled from corvis_control.notification_preference p where p.tenant_id=$1::uuid and p.user_id=$2::uuid and p.category=$3) as pref_enabled,
      (select p.delivery from corvis_control.notification_preference p where p.tenant_id=$1::uuid and p.user_id=$2::uuid and p.category=$3) as pref_delivery,
      exists (select 1 from corvis_control.identity_subject s
        where s.tenant_id=$1::uuid and s.user_id=$2::uuid and s.status='active' and s.auth_method in ('oidc','saml')) as identity_active,
      (not $7::boolean or exists (select 1 from corvis_control.membership m
        join corvis_control.workspace w on w.tenant_id=m.tenant_id and w.workspace_id=m.workspace_id and w.status='active'
        where m.tenant_id=$1::uuid and m.user_id=$2::uuid and ($4::uuid is null or m.workspace_id=$4::uuid)
          and ($5::jsonb is null or m.role_name in (select jsonb_array_elements_text($5::jsonb)))
          and m.status='active' and m.valid_from<=now() and (m.valid_until is null or m.valid_until>now()))) as member_active,
      ($6::text is null or exists (select 1 from corvis_control.resource_entitlement e
        where e.tenant_id=$1::uuid and e.workspace_id=$4::uuid and e.subject_user_id=$2::uuid
          and e.resource_type='fund' and e.resource_id=$6 and e.permission='read'
          and e.valid_from<=now() and (e.valid_until is null or e.valid_until>now())
          and coalesce((select bool_and(dr.client_visible) from corvis_control.data_rights dr
            where dr.tenant_id=e.tenant_id and dr.resource_type='fund' and dr.resource_id=e.resource_id
              and dr.effective_from<=now() and (dr.effective_to is null or dr.effective_to>now())), false))) as fund_entitled,
      (select w.display_name from corvis_control.workspace w where w.tenant_id=$1::uuid and w.workspace_id=$4::uuid) as workspace_name`,
  [text(row, "tenant_id"), text(row, "recipient_user_id"), category, row.workspace_id == null ? null : text(row, "workspace_id"),
    roles ? json(roles) : null, row.fund_id == null ? null : text(row, "fund_id"), requireMembership]))[0] ?? {};
  const truthy = (value: unknown) => value === true || value === "true" || value === "t";
  return {
    displayPreferences: result.display_preferences ? normalizeDisplayPreferences(result.display_preferences) : undefined,
    email: text(result, "email") || null,
    preference: result.pref_enabled == null ? undefined : { category, enabled: truthy(result.pref_enabled), delivery: text(result, "pref_delivery") },
    identityActive: truthy(result.identity_active),
    memberActive: truthy(result.member_active),
    fundEntitled: truthy(result.fund_entitled),
    workspaceName: text(result, "workspace_name") || null,
  };
}

async function settle(db: PostgresSqlApi, row: PostgresRow, set: string, parameters: PostgresPrimitive[]): Promise<void> {
  // Conditioned on the lease this worker holds, so a reclaimed row is never double-settled.
  await db.execute(`update corvis_control.email_outbox set ${set},locked_until=null,updated_at=now()
    where email_id=$1::uuid and status='sending' and attempts=$2`, [text(row, "email_id"), Number(row.attempts ?? 0), ...parameters]);
}

function paramsOf(row: PostgresRow): Record<string, unknown> {
  const value = row.template_params;
  if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Claims due rows, re-checks each recipient's eligibility and preference at
 * send time, then sends, defers to the daily digest, or suppresses with a
 * recorded reason. Failures retry with capped exponential backoff and
 * dead-letter after {@link EMAIL_MAX_ATTEMPTS}.
 */
export async function processEmailOutbox(dependencies: DispatchDependencies = {}): Promise<OutboxRunResult> {
  const db = dependencies.db ?? dbDefault();
  const sender = dependencies.sender ?? configuredEmailSender();
  const appUrl = dependencies.appUrl === undefined ? getServerConfig().publicAppUrl ?? null : dependencies.appUrl;
  const result: OutboxRunResult = { claimed: 0, sent: 0, suppressed: 0, digestPending: 0, retried: 0, deadLettered: 0 };
  const rows = await db.query(`update corvis_control.email_outbox o
    set status='sending',attempts=o.attempts+1,locked_until=now()+make_interval(mins => $2),updated_at=now()
    where o.email_id in (
      select email_id from corvis_control.email_outbox
      where (status in ('queued','retry') and next_attempt_at<=now()) or (status='sending' and locked_until<now())
      order by next_attempt_at,created_at
      limit $1
      for update skip locked
    )
    returning o.*`, [dependencies.limit ?? 50, SENDING_LEASE_MINUTES]);
  result.claimed = rows.length;

  for (const row of rows) {
    const category = text(row, "category") as OutboxCategory;
    const emailId = text(row, "email_id");
    const attempt = Number(row.attempts ?? 1);
    const suppress = async (reason: string) => { await settle(db, row, "status='suppressed',suppression_reason=$3", [reason]); result.suppressed++; };
    try {
      if (!row.recipient_user_id) { await suppress("not_eligible"); continue; }
      const who = await eligibility(db, row);
      if (!who.identityActive || !who.memberActive || !who.fundEntitled) { await suppress("not_eligible"); continue; }
      const definition = notificationCategory(category);
      if (definition && !definition.mandatory) {
        const preference = effectivePreference(definition, who.preference);
        if (!preference.enabled) { await suppress("opted_out"); continue; }
        if (preference.delivery === "daily_digest") {
          await settle(db, row, "status='digest_pending',attempts=0", []);
          result.digestPending++;
          continue;
        }
      }
      if (!who.email) { await suppress("no_verified_address"); continue; }
      if (!sender.configured) { await suppress("provider_not_configured"); continue; }
      if (!appUrl) { await suppress("app_url_not_configured"); continue; }
      const rendered = renderEmail(category, paramsOf(row), { appUrl, workspaceName: who.workspaceName ?? undefined, displayPreferences: who.displayPreferences });
      const outcome = await sender.send({ to: who.email, ...rendered, category, idempotencyKey: emailId });
      if (outcome.status === "sent") {
        await settle(db, row, "status='sent',sent_at=now(),provider_message_id=$3,last_error_class=null", [outcome.providerMessageId ?? null]);
        result.sent++;
      } else if (outcome.status === "not_configured") {
        await suppress("provider_not_configured");
      } else if (outcome.retryable && attempt < EMAIL_MAX_ATTEMPTS) {
        await settle(db, row, "status='retry',next_attempt_at=now()+($3::double precision * interval '1 millisecond'),last_error_class=$4", [computeEmailRetryDelayMs(attempt), outcome.errorClass.slice(0, 80)]);
        result.retried++;
      } else {
        await settle(db, row, "status='dead_letter',last_error_class=$3", [outcome.errorClass.slice(0, 80)]);
        result.deadLettered++;
      }
    } catch (error) {
      const errorClass = error instanceof Error ? error.name.slice(0, 80) : "unknown_error";
      if (attempt < EMAIL_MAX_ATTEMPTS) {
        await settle(db, row, "status='retry',next_attempt_at=now()+($3::double precision * interval '1 millisecond'),last_error_class=$4", [computeEmailRetryDelayMs(attempt), errorClass]).catch(() => undefined);
        result.retried++;
      } else {
        await settle(db, row, "status='dead_letter',last_error_class=$3", [errorClass]).catch(() => undefined);
        result.deadLettered++;
      }
      logEvent("error", "notifications.email_dispatch_failed", { correlationId: `email:${emailId}`, tenantId: text(row, "tenant_id") }, { category, attempt, errorClass });
    }
  }
  return result;
}

/**
 * Bundles each recipient's deferred items into one digest email once their
 * oldest item has waited {@link DIGEST_WINDOW_HOURS}. Items were deferred at
 * claim time, so eligibility and the preference are re-checked here exactly as
 * the claim path does: an item whose category was switched off, moved back to
 * immediate delivery, or whose recipient lost access in the meantime is
 * suppressed instead of bundled. The digest row and the `digested` marks of the
 * surviving items commit in one statement.
 */
export async function processEmailDigests(dependencies: { db?: PostgresSqlApi; limit?: number } = {}): Promise<{ digests: number }> {
  const db = dependencies.db ?? dbDefault();
  const due = await db.query(`select tenant_id::text,recipient_user_id::text from corvis_control.email_outbox
    where status='digest_pending'
    group by tenant_id,recipient_user_id
    having min(created_at) <= now()-make_interval(hours => $2)
    limit $1`, [dependencies.limit ?? 100, DIGEST_WINDOW_HOURS]);
  let digests = 0;
  for (const recipient of due) {
    const tenantId = text(recipient, "tenant_id");
    const userId = text(recipient, "recipient_user_id");
    const pendingRows = await db.query(`select email_id::text,tenant_id::text,category,recipient_user_id::text,workspace_id::text,fund_id,required_roles
      from corvis_control.email_outbox
      where tenant_id=$1::uuid and recipient_user_id=$2::uuid and status='digest_pending'`, [tenantId, userId]);
    const bundled: string[] = [];
    for (const row of pendingRows) {
      const emailId = text(row, "email_id");
      const reason = await digestSuppressionReason(db, row);
      if (reason) {
        await db.execute(`update corvis_control.email_outbox set status='suppressed',suppression_reason=$2,locked_until=null,updated_at=now()
          where email_id=$1::uuid and status='digest_pending'`, [emailId, reason]);
      } else {
        bundled.push(emailId);
      }
    }
    if (!bundled.length) continue;
    const digestId = randomUUID();
    const rows = await db.query(`with pending as (
        select email_id,category from corvis_control.email_outbox
        where tenant_id=$1::uuid and recipient_user_id=$2::uuid and status='digest_pending'
          and email_id in (select jsonb_array_elements_text($4::jsonb)::uuid)
        for update skip locked
      ), digest as (
        insert into corvis_control.email_outbox (email_id,tenant_id,category,recipient_user_id,template_params,dedupe_key)
        select $3::uuid,$1::uuid,'digest'::text,$2::uuid,
          jsonb_build_object('items',(select jsonb_agg(jsonb_build_object('category',c.category,'count',c.n) order by c.category)
            from (select category,count(*)::int as n from pending group by category) c)),
          'digest:' || $3::text
        where exists (select 1 from pending)
        returning email_id
      )
      update corvis_control.email_outbox o set status='digested',digest_email_id=d.email_id,updated_at=now()
      from pending p, digest d
      where o.email_id=p.email_id
      returning o.email_id`, [tenantId, userId, digestId, json(bundled)]);
    if (rows.length) digests++;
  }
  return { digests };
}

/** Why a deferred item must not be bundled any more, mirroring the claim path's checks. */
async function digestSuppressionReason(db: PostgresSqlApi, row: PostgresRow): Promise<"not_eligible" | "opted_out" | null> {
  const who = await eligibility(db, row);
  if (!who.identityActive || !who.memberActive || !who.fundEntitled) return "not_eligible";
  const definition = notificationCategory(text(row, "category"));
  if (definition && !definition.mandatory) {
    const preference = effectivePreference(definition, who.preference);
    if (!preference.enabled || preference.delivery !== "daily_digest") return "opted_out";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invitations (sent inline: the link carries a single-use token that must
// never be persisted, so there is nothing to retry from the outbox)
// ---------------------------------------------------------------------------

export type InvitationEmailStatus = "sent" | "not_configured" | "failed";

export type InvitationForEmail = { invitationId: string; tenantId: string; workspaceId: string; workspaceName: string; email: string; roleName: string; expiresAt: string };

export function invitationLink(appUrl: string, invitation: Pick<InvitationForEmail, "tenantId" | "workspaceId">, token: string): string {
  const url = new URL("/invite", appUrl);
  url.searchParams.set("tenantId", invitation.tenantId);
  url.searchParams.set("workspaceId", invitation.workspaceId);
  url.hash = token;
  return url.toString();
}

/**
 * Emails a freshly issued invitation after its transaction committed. Never
 * throws: the admin always keeps the manual copy-link fallback. The outbox row
 * records the outcome for visibility, without the link.
 */
export async function deliverInvitationEmail(invitation: InvitationForEmail, token: string, dependencies: { db?: PostgresSqlApi; sender?: EmailSender; appUrl?: string | null } = {}): Promise<InvitationEmailStatus> {
  const config = getServerConfig();
  if (config.demoMode) return "not_configured";
  const sender = dependencies.sender ?? configuredEmailSender(config);
  const appUrl = dependencies.appUrl === undefined ? config.publicAppUrl ?? null : dependencies.appUrl;
  let db: PostgresSqlApi | undefined;
  // The outbox row is only a visibility record: failing to write it must never change what the send reported.
  const record = async (status: "sent" | "suppressed" | "dead_letter", extra: { reason?: string; providerMessageId?: string; errorClass?: string } = {}) => {
    try {
      db ??= dependencies.db ?? dbDefault();
      await db.execute(`insert into corvis_control.email_outbox
          (tenant_id,category,recipient_email,workspace_id,template_params,dedupe_key,status,suppression_reason,attempts,sent_at,provider_message_id,last_error_class)
        values ($1::uuid,'invitation',$2::text,$3::uuid,$4::jsonb,$5::text,$6::text,$7::text,1,case when $6::text='sent' then now() else null end,$8::text,$9::text)
        on conflict (tenant_id,dedupe_key) do nothing`,
      [invitation.tenantId, invitation.email, invitation.workspaceId, json({ roleName: invitation.roleName }),
        `invitation:${invitation.invitationId}:${invitation.expiresAt}`, status, extra.reason ?? null, extra.providerMessageId ?? null, extra.errorClass ?? null]);
    } catch (error) {
      logEvent("error", "notifications.invitation_record_failed", { correlationId: `invitation:${invitation.invitationId}`, tenantId: invitation.tenantId }, { status, errorName: error instanceof Error ? error.name : typeof error });
    }
  };
  try {
    if (!sender.configured) { await record("suppressed", { reason: "provider_not_configured" }); return "not_configured"; }
    if (!appUrl) { await record("suppressed", { reason: "app_url_not_configured" }); return "not_configured"; }
    db ??= dependencies.db ?? dbDefault();
    const profile = (await db.query(`select p.display_preferences from corvis_control.workspace_user_preference p
      join corvis_control.identity_subject s on s.tenant_id=p.tenant_id and s.auth_method=p.auth_method and s.subject=p.subject
      join corvis_control.notification_recipient r on r.tenant_id=s.tenant_id and r.user_id=s.user_id
      where p.tenant_id=$1::uuid and r.email=$2 and s.status='active' and p.display_preferences is not null order by p.updated_at desc limit 1`, [invitation.tenantId, invitation.email]))[0];
    const expiresOn = new Date(invitation.expiresAt);
    const rendered = renderEmail("invitation", {
      roleName: invitation.roleName,
      invitationUrl: invitationLink(appUrl, invitation, token),
      expiresAt: Number.isNaN(expiresOn.getTime()) ? "" : expiresOn.toISOString(),
    }, { appUrl, workspaceName: invitation.workspaceName, displayPreferences: profile?.display_preferences ? normalizeDisplayPreferences(profile.display_preferences) : undefined });
    const outcome = await sender.send({ to: invitation.email, ...rendered, category: "invitation", idempotencyKey: `invitation:${invitation.invitationId}:${invitation.expiresAt}` });
    if (outcome.status === "sent") { await record("sent", { providerMessageId: outcome.providerMessageId }); return "sent"; }
    if (outcome.status === "not_configured") { await record("suppressed", { reason: "provider_not_configured" }); return "not_configured"; }
    await record("dead_letter", { errorClass: outcome.errorClass.slice(0, 80) });
    return "failed";
  } catch (error) {
    logEvent("error", "notifications.invitation_email_failed", { correlationId: `invitation:${invitation.invitationId}`, tenantId: invitation.tenantId }, { errorName: error instanceof Error ? error.name : typeof error });
    return "failed";
  }
}
