import type { EmailSender } from "../domain/notifications.ts";
import { DisabledEmailSender } from "../adapters/disabled-email-sender.ts";
import { getServerConfig, type ServerConfig } from "../../../platform/config.ts";
import { logEvent } from "../../../platform/telemetry.ts";

/** Providers with a reviewed adapter. Activation also needs a vendor/subprocessor approval (see docs/features/NOTIFICATIONS.md). */
export const SUPPORTED_EMAIL_PROVIDERS = ["disabled"] as const;

let warnedProvider: string | undefined;

/**
 * Selects the email provider adapter. Demo mode never sends. An unknown
 * provider name fails closed to the disabled sender and is logged once, so a
 * typo can never route customer email somewhere unreviewed.
 */
export function configuredEmailSender(config: ServerConfig = getServerConfig()): EmailSender {
  if (config.demoMode || !config.emailProvider || config.emailProvider === "disabled") return new DisabledEmailSender();
  if (warnedProvider !== config.emailProvider) {
    warnedProvider = config.emailProvider;
    logEvent("warn", "notifications.email_provider_unsupported", { correlationId: "config" }, { provider: config.emailProvider, supported: SUPPORTED_EMAIL_PROVIDERS });
  }
  return new DisabledEmailSender();
}
