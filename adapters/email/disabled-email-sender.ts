import type { EmailSender, EmailSendResult } from "../../core/notifications.ts";

/**
 * The default until a reviewed provider is activated: nothing leaves Corvis.
 * The outbox records these rows as suppressed (`provider_not_configured`) so
 * delivery status stays honest instead of silently pretending to send.
 */
export class DisabledEmailSender implements EmailSender {
  readonly configured = false;
  async send(): Promise<EmailSendResult> { return { status: "not_configured" }; }
}
