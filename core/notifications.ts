import { formatDisplayDate, formatDisplayNumber, type DisplayPreferences } from "./display-preferences.ts";
/**
 * Email notification domain contract (#258).
 *
 * The catalog decides who may configure what; templates decide what an email
 * may say. Emails never carry financial figures, document content or names of
 * funds/companies: only a short event description, a workspace name and a link
 * back into the app, where normal authorization applies.
 */

export type NotificationCategoryId =
  | "export_ready"
  | "pinned_fund_published"
  | "source_attention"
  | "data_issue_update"
  | "support_access"
  | "role_changed";

/** Outbox-only categories: never shown as a preference. */
export type OutboxCategory = NotificationCategoryId | "invitation" | "digest";

export type NotificationDelivery = "immediate" | "daily_digest";

export type NotificationAudience = "everyone" | "workspace_admins" | "organization_admins";

export type NotificationCategoryDefinition = {
  id: NotificationCategoryId;
  label: string;
  description: string;
  /** Security notices are always sent immediately and cannot be turned off. */
  mandatory: boolean;
  /** Who sees the category in settings (and who can ever receive it). */
  audience: NotificationAudience;
  defaultEnabled: boolean;
  defaultDelivery: NotificationDelivery;
};

export const NOTIFICATION_CATEGORIES: readonly NotificationCategoryDefinition[] = [
  { id: "export_ready", label: "Export ready", description: "An export you requested has finished and is ready to download.", mandatory: false, audience: "everyone", defaultEnabled: true, defaultDelivery: "immediate" },
  { id: "pinned_fund_published", label: "New data for pinned funds", description: "A new reporting period was published for a fund you pinned on your Overview.", mandatory: false, audience: "everyone", defaultEnabled: true, defaultDelivery: "daily_digest" },
  { id: "data_issue_update", label: "Data issue updates", description: "A data issue you reported on a published figure moved to a new status.", mandatory: false, audience: "everyone", defaultEnabled: true, defaultDelivery: "immediate" },
  { id: "source_attention", label: "Source connection needs attention", description: "A source connection in a workspace you administer needs to be reauthorized or was suspended.", mandatory: false, audience: "workspace_admins", defaultEnabled: true, defaultDelivery: "immediate" },
  { id: "support_access", label: "Corvis support access", description: "Corvis support was granted access to your organization, or a grant is waiting for your acknowledgement.", mandatory: true, audience: "organization_admins", defaultEnabled: true, defaultDelivery: "immediate" },
  { id: "role_changed", label: "Your access changed", description: "Your role in a workspace was changed or removed.", mandatory: true, audience: "everyone", defaultEnabled: true, defaultDelivery: "immediate" },
];

const CATEGORY_BY_ID = new Map(NOTIFICATION_CATEGORIES.map((category) => [category.id, category]));

export function notificationCategory(id: string): NotificationCategoryDefinition | undefined {
  return CATEGORY_BY_ID.get(id as NotificationCategoryId);
}

/** Database roles that make up each audience. */
export const AUDIENCE_ROLES: Record<Exclude<NotificationAudience, "everyone">, readonly string[]> = {
  workspace_admins: ["tenant_admin", "accountadmin"],
  organization_admins: ["tenant_admin"],
};

export function categoryVisibleTo(category: NotificationCategoryDefinition, viewer: { isAdmin: boolean; isTenantAdmin: boolean }): boolean {
  if (category.audience === "organization_admins") return viewer.isTenantAdmin;
  if (category.audience === "workspace_admins") return viewer.isAdmin || viewer.isTenantAdmin;
  return true;
}

export type NotificationPreferenceSetting = {
  id: NotificationCategoryId;
  label: string;
  description: string;
  mandatory: boolean;
  enabled: boolean;
  delivery: NotificationDelivery;
};

export type NotificationSettings = {
  /** `not_configured`: preferences are saved, but no email provider is active yet. */
  emailDelivery: "active" | "not_configured";
  /** The verified address emails go to, or null when none has been captured yet. */
  address: string | null;
  categories: NotificationPreferenceSetting[];
};

export type NotificationPreferenceChange = { id: NotificationCategoryId; enabled: boolean; delivery: NotificationDelivery };

export type StoredPreference = { category: string; enabled: boolean; delivery: string };

/** Merges stored rows over catalog defaults; mandatory categories ignore any stored row. */
export function effectivePreference(category: NotificationCategoryDefinition, stored?: StoredPreference): { enabled: boolean; delivery: NotificationDelivery } {
  if (category.mandatory) return { enabled: true, delivery: "immediate" };
  if (!stored) return { enabled: category.defaultEnabled, delivery: category.defaultDelivery };
  return { enabled: stored.enabled, delivery: stored.delivery === "daily_digest" ? "daily_digest" : "immediate" };
}

export class NotificationPreferenceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.name = "NotificationPreferenceError"; this.code = code; this.status = status; }
}

/**
 * Validates a PUT body. Unknown, hidden or mandatory categories are rejected
 * outright rather than ignored, so a client can never believe it opted out of
 * a security notice.
 */
export function normalizePreferenceChanges(value: unknown, viewer: { isAdmin: boolean; isTenantAdmin: boolean }): NotificationPreferenceChange[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotificationPreferenceError("invalid_request");
  const categories = (value as { categories?: unknown }).categories;
  if (!Array.isArray(categories) || categories.length === 0 || categories.length > NOTIFICATION_CATEGORIES.length) throw new NotificationPreferenceError("invalid_request");
  const seen = new Set<string>();
  return categories.map((item) => {
    if (!item || typeof item !== "object") throw new NotificationPreferenceError("invalid_request");
    const { id, enabled, delivery } = item as Record<string, unknown>;
    const category = typeof id === "string" ? notificationCategory(id) : undefined;
    if (!category || !categoryVisibleTo(category, viewer) || seen.has(category.id)) throw new NotificationPreferenceError("unknown_category");
    if (category.mandatory) throw new NotificationPreferenceError("category_not_configurable");
    if (typeof enabled !== "boolean" || (delivery !== "immediate" && delivery !== "daily_digest")) throw new NotificationPreferenceError("invalid_request");
    seen.add(category.id);
    return { id: category.id, enabled, delivery };
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type RenderedEmail = { subject: string; text: string; html: string };

export type TemplateContext = {
  /** Public origin of the customer app, e.g. https://app.example.com */
  appUrl: string;
  displayPreferences?: DisplayPreferences;
  workspaceName?: string;
};

const ROLE_LABELS: Record<string, string> = {
  tenant_admin: "Organization Admin",
  accountadmin: "Workspace Admin",
  workspace_admin: "Workspace Admin",
  reviewer: "Review Analyst",
  analyst: "Analyst",
  viewer: "Viewer",
};

export function rawRoleLabel(role: string): string { return ROLE_LABELS[role] ?? "a new role"; }

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category.id, category.label]));

/** Strips anything that could break a header or smuggle markup, and bounds length. */
export function safeInline(value: unknown, max = 120): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function settingsUrl(appUrl: string): string {
  const url = new URL("/", appUrl);
  url.searchParams.set("notifications", "settings");
  return url.toString();
}

function inWorkspace(context: TemplateContext): string {
  const name = safeInline(context.workspaceName);
  return name ? ` in ${name}` : "";
}

/** Names the new status in words only: no fund, company, metric or figure ever appears in the email. */
function dataIssueUpdateLine(status: unknown, where: string): string {
  if (status === "investigating") return `Data Operations is investigating a data issue you reported${where}.`;
  if (status === "corrected") return `A data issue you reported${where} was corrected. A replacement publication is available.`;
  if (status === "no_change") return `A data issue you reported${where} was reviewed and no change was needed.`;
  return `A data issue you reported${where} was updated.`;
}

type Body = { subject: string; lines: string[]; action: { label: string; url: string }; optional: boolean };

function body(category: OutboxCategory, params: Record<string, unknown>, context: TemplateContext): Body {
  const home = new URL("/", context.appUrl).toString();
  const where = inWorkspace(context);
  switch (category) {
    case "invitation": {
      const role = rawRoleLabel(safeInline(params.roleName, 40));
      const rawExpires = safeInline(params.expiresAt ?? params.expiresOn, 40);
      const expires = rawExpires ? formatDisplayDate(rawExpires, context.displayPreferences, params.expiresAt ? { timeStyle: "short" } : {}) : "";
      return {
        subject: "You're invited to Corvis",
        lines: [
          `You have been invited to join${where} as ${role}.`,
          "Sign in with your organization account to accept. The link works once and only for this email address.",
          ...(expires ? [`The invitation expires on ${expires}.`] : []),
        ],
        action: { label: "Accept invitation", url: safeInline(params.invitationUrl, 2000) },
        optional: false,
      };
    }
    case "export_ready":
      return { subject: "Your Corvis export is ready", lines: [`An export you requested${where} has finished and is ready to download.`, "Download links expire, so retrieve it from Delivery soon."], action: { label: "Open Delivery", url: home }, optional: true };
    case "pinned_fund_published":
      return { subject: "New data for a fund you pinned", lines: [`A new reporting period was published for a fund you pinned${where}.`], action: { label: "Open Overview", url: home }, optional: true };
    case "data_issue_update":
      return {
        subject: "Update on a data issue you reported",
        lines: [dataIssueUpdateLine(params.status, where), "Open Corvis to see the current status and any replacement publication."],
        action: { label: "Open Data issues", url: new URL("/#/issues", context.appUrl).toString() },
        optional: true,
      };
    case "source_attention": {
      const reauth = params.status === "reauthorization_required";
      return {
        subject: reauth ? "A Corvis source connection needs reauthorization" : "A Corvis source connection was suspended",
        lines: [reauth
          ? `A source connection${where} can no longer sign in to its provider and has stopped collecting documents.`
          : `A source connection${where} was suspended after repeated failures and has stopped collecting documents.`,
        "Open Corvis to see the reason and the action to take."],
        action: { label: "Review source connections", url: home },
        optional: true,
      };
    }
    case "support_access": {
      const pending = params.status === "pending_ack";
      return {
        subject: pending ? "Corvis support access needs your acknowledgement" : "Corvis support access was granted to your organization",
        lines: [pending
          ? `Corvis support has requested time-limited access${where}. It will not take effect until an Organization Admin acknowledges it.`
          : `Corvis support was granted time-limited access${where}.`,
        "Review the purpose, approver and expiry, or revoke it, in Access administration."],
        action: { label: "Review support access", url: home },
        optional: false,
      };
    }
    case "role_changed": {
      const role = typeof params.roleName === "string" && params.roleName ? rawRoleLabel(params.roleName) : null;
      return {
        subject: "Your Corvis access changed",
        lines: [role ? `Your role${where} was changed to ${role}.` : `A role you held${where} was removed.`, "If you did not expect this, contact your Organization Admin."],
        action: { label: "Open Corvis", url: home },
        optional: false,
      };
    }
    case "digest": {
      const items = Array.isArray(params.items) ? params.items : [];
      const lines = items.slice(0, 20).map((item) => {
        const entry = item as { category?: unknown; count?: unknown };
        const label = CATEGORY_LABELS[String(entry.category)] ?? "Update";
        const count = Number.isInteger(entry.count) && Number(entry.count) > 0 ? Number(entry.count) : 1;
        return `• ${label}${count > 1 ? ` (${formatDisplayNumber(count, context.displayPreferences)})` : ""}`;
      });
      return { subject: "Your Corvis daily summary", lines: ["Here is what happened in Corvis since your last summary:", ...lines], action: { label: "Open Corvis", url: home }, optional: true };
    }
  }
}

/**
 * Renders a plain-text and HTML email. Optional emails always end with a link
 * to notification settings so the recipient can turn them off.
 */
export function renderEmail(category: OutboxCategory, params: Record<string, unknown>, context: TemplateContext): RenderedEmail {
  const content = body(category, params, context);
  if (!/^https:\/\//.test(content.action.url) && !/^http:\/\/localhost[:/]/.test(content.action.url)) throw new Error("email action link must be an absolute https URL");
  const manage = settingsUrl(context.appUrl);
  const footer = content.optional
    ? `You received this because of your Corvis notification settings. Change them: ${manage}`
    : "This is a required notice about your Corvis account and cannot be turned off.";
  const text = [...content.lines, "", `${content.action.label}: ${content.action.url}`, "", footer].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#172b4d">${content.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p><a href="${escapeHtml(content.action.url)}">${escapeHtml(content.action.label)}</a></p><hr><p style="font-size:12px;color:#5e6c84">${content.optional ? `You received this because of your Corvis notification settings. <a href="${escapeHtml(manage)}">Change notification settings</a>.` : escapeHtml(footer)}</p></body></html>`;
  return { subject: safeInline(content.subject, 150), text, html };
}

// ---------------------------------------------------------------------------
// Delivery port
// ---------------------------------------------------------------------------

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  category: OutboxCategory;
  /** Stable per outbox row so a provider can drop a retried duplicate. */
  idempotencyKey: string;
};

export type EmailSendResult =
  | { status: "sent"; providerMessageId?: string }
  | { status: "not_configured" }
  | { status: "failed"; retryable: boolean; errorClass: string };

/** Provider boundary. Implementations live under adapters/email. */
export interface EmailSender {
  readonly configured: boolean;
  send(email: OutboundEmail): Promise<EmailSendResult>;
}
