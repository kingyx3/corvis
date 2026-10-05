import { parseViewHash } from "./view-hash.ts";

/**
 * In-app help and support (F9). Everything here is pure: it turns a fixed allow-list of identifiers
 * into a "Contact support" link and resolves the configurable help URLs. The support context is
 * deliberately limited to non-financial identifiers (workspace, view, error digest, latest request id).
 * Document names, fund names, metric values, user input and URLs with query strings are never read,
 * so nothing sensitive can reach a support request by accident.
 */

/** Where help lives. Set at build time through the `NEXT_PUBLIC_CORVIS_SUPPORT_*` variables (see docs/features/SUPPORT.md). */
export type SupportConfig = {
  /** Mailbox that "Contact support" composes an email to. */
  supportEmail: string;
  /** Optional help-desk URL; when present "Contact support" opens it (with the context as query parameters) instead of composing an email. */
  supportUrl?: string;
  docsUrl: string;
  statusUrl: string;
  releaseNotesUrl: string;
};

export type SupportConfigInput = { [Key in keyof SupportConfig]?: string | undefined };

/**
 * Used for any value that is unset or invalid. The reserved `.example` domain is intentional: it never
 * resolves, so an unconfigured deployment cannot send support mail or users to somebody else's host.
 * Every real deployment sets the variables.
 */
export const DEFAULT_SUPPORT_CONFIG: Readonly<Omit<SupportConfig, "supportUrl">> = {
  supportEmail: "support@corvis.example",
  docsUrl: "https://docs.corvis.example/",
  statusUrl: "https://status.corvis.example/",
  releaseNotesUrl: "https://docs.corvis.example/release-notes",
};

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function emailAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length <= 254 && EMAIL.test(trimmed) ? trimmed : undefined;
}

/** An absolute https URL without embedded credentials; anything else (http, javascript:, mailto:, relative) is rejected. */
function httpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSupportConfig(input: SupportConfigInput): SupportConfig {
  const supportUrl = httpsUrl(input.supportUrl);
  return {
    supportEmail: emailAddress(input.supportEmail) ?? DEFAULT_SUPPORT_CONFIG.supportEmail,
    ...(supportUrl ? { supportUrl } : {}),
    docsUrl: httpsUrl(input.docsUrl) ?? DEFAULT_SUPPORT_CONFIG.docsUrl,
    statusUrl: httpsUrl(input.statusUrl) ?? DEFAULT_SUPPORT_CONFIG.statusUrl,
    releaseNotesUrl: httpsUrl(input.releaseNotesUrl) ?? DEFAULT_SUPPORT_CONFIG.releaseNotesUrl,
  };
}

/**
 * Reads the build-time configuration. Each variable is referenced literally because Next.js only inlines
 * `process.env.NEXT_PUBLIC_*` into the browser bundle for literal property accesses.
 */
export function supportConfigFromEnv(): SupportConfig {
  return resolveSupportConfig({
    supportEmail: process.env.NEXT_PUBLIC_CORVIS_SUPPORT_EMAIL,
    supportUrl: process.env.NEXT_PUBLIC_CORVIS_SUPPORT_URL,
    docsUrl: process.env.NEXT_PUBLIC_CORVIS_DOCS_URL,
    statusUrl: process.env.NEXT_PUBLIC_CORVIS_STATUS_URL,
    releaseNotesUrl: process.env.NEXT_PUBLIC_CORVIS_RELEASE_NOTES_URL,
  });
}

/** What the browser knows about where the user is. Every field is optional and validated before use. */
export type SupportContextInput = {
  tenantId?: string | null;
  workspaceId?: string | null;
  /** Workspace view id (`documents`) or a route path; never a URL with a query string. */
  view?: string | null;
  /** The Next.js error digest of the failure the user is looking at. */
  reference?: string | null;
  /** Correlation id of the latest API response (see `lib/request-correlation.ts`). */
  correlationId?: string | null;
};

export type SupportContext = { tenantId?: string; workspaceId?: string; view?: string; reference?: string; correlationId?: string };

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const VIEW = /^(?:[a-z]{1,40}|\/[A-Za-z0-9/_-]{0,120})$/;
const DIGEST = /^[A-Za-z0-9_-]{1,64}$/;

function accepted(value: string | null | undefined, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/** Keeps only well-formed identifiers; free text, financial values and unknown fields are dropped, never truncated. */
export function buildSupportContext(input: SupportContextInput): SupportContext {
  const candidates: SupportContext = {
    tenantId: accepted(input.tenantId, IDENTIFIER),
    workspaceId: accepted(input.workspaceId, IDENTIFIER),
    view: accepted(input.view, VIEW),
    reference: accepted(input.reference, DIGEST),
    correlationId: accepted(input.correlationId, IDENTIFIER),
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== undefined)) as SupportContext;
}

/** The workspace view for a location: the view in the hash (`#/documents`), else the route path. */
export function viewFromLocation(location: { hash: string; pathname: string }): string {
  return parseViewHash(location.hash) ?? location.pathname;
}

/** Human-readable lines for the context, shown to the user before they send it and written into the email body. */
export function supportContextLines(context: SupportContext): string[] {
  const lines: Array<[string, string | undefined]> = [
    ["Workspace ID", context.workspaceId],
    ["Organization ID", context.tenantId],
    ["Current view", context.view],
    ["Error reference", context.reference],
    ["Latest request ID", context.correlationId],
  ];
  return lines.flatMap(([label, value]) => value === undefined ? [] : [`${label}: ${value}`]);
}

export type SupportRequest = {
  channel: "email" | "web";
  /** `mailto:` link, or the configured help-desk URL carrying the context as query parameters. */
  href: string;
  /** True when `href` is a web page (open it in a new tab); a `mailto:` link hands over to the mail client. */
  opensInNewTab: boolean;
  subject: string;
  context: SupportContext;
  contextLines: string[];
};

export const SUPPORT_SUBJECT = "Corvis support request";

const DISCLAIMER = "Identifiers only: no financial data or documents are attached.";

const WEB_PARAMETERS: ReadonlyArray<readonly [keyof SupportContext, string]> = [
  ["workspaceId", "workspace_id"],
  ["tenantId", "organization_id"],
  ["view", "view"],
  ["reference", "error_reference"],
  ["correlationId", "request_id"],
];

/** Builds the "Contact support" action for the current state. This is the single entry point used by the Help menu, the palette and every error state. */
export function buildSupportRequest(config: SupportConfig, input: SupportContextInput): SupportRequest {
  const context = buildSupportContext(input);
  const contextLines = supportContextLines(context);
  if (config.supportUrl) {
    const url = new URL(config.supportUrl);
    url.searchParams.set("subject", SUPPORT_SUBJECT);
    for (const [field, parameter] of WEB_PARAMETERS) {
      const value = context[field];
      if (value !== undefined) url.searchParams.set(parameter, value);
    }
    return { channel: "web", href: url.href, opensInNewTab: true, subject: SUPPORT_SUBJECT, context, contextLines };
  }
  const body = [
    "Hello Corvis support,",
    "",
    "What happened, and what were you trying to do?",
    "(Please do not paste financial data or documents into this email.)",
    "",
    "",
    "--",
    "Included automatically. " + DISCLAIMER,
    ...contextLines,
  ].join("\n");
  const href = `mailto:${config.supportEmail}?subject=${encodeURIComponent(SUPPORT_SUBJECT)}&body=${encodeURIComponent(body)}`;
  return { channel: "email", href, opensInNewTab: false, subject: SUPPORT_SUBJECT, context, contextLines };
}

export type HelpEntryId = "contact" | "docs" | "status" | "release-notes";

export type HelpLink = {
  id: Exclude<HelpEntryId, "contact">;
  label: string;
  description: string;
  /** Extra words the command palette matches on. */
  keywords: string;
  href: string;
};

export type HelpEntry = {
  id: HelpEntryId;
  label: string;
  description: string;
  keywords: string;
  href: string;
  opensInNewTab: boolean;
};

export const CONTACT_SUPPORT = {
  id: "contact",
  label: "Contact support",
  description: "Email the Corvis team with your workspace and the latest request reference filled in.",
  keywords: "help support contact email ticket problem issue error",
} as const;

/** The three external help destinations, from configuration. */
export function helpLinks(config: SupportConfig): HelpLink[] {
  return [
    { id: "docs", label: "Documentation", description: "Product guides and how-tos.", keywords: "help docs documentation guide manual how to", href: config.docsUrl },
    { id: "status", label: "Service status", description: "Current availability and incident history.", keywords: "help status uptime outage incident availability", href: config.statusUrl },
    { id: "release-notes", label: "Release notes", description: "What changed in recent releases.", keywords: "help release notes changelog what's new updates", href: config.releaseNotesUrl },
  ];
}

/** The full Help menu: Contact support first, then the external links. */
export function helpEntries(config: SupportConfig, request: SupportRequest): HelpEntry[] {
  return [
    { ...CONTACT_SUPPORT, href: request.href, opensInNewTab: request.opensInNewTab },
    ...helpLinks(config).map((link): HelpEntry => ({ ...link, opensInNewTab: true })),
  ];
}
