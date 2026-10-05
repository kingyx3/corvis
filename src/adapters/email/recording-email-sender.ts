import type { EmailSender, EmailSendResult, OutboundEmail } from "../../core/notifications.ts";

/** In-memory sender for tests. Never selected by runtime configuration. */
export class RecordingEmailSender implements EmailSender {
  readonly configured = true;
  readonly sent: OutboundEmail[] = [];
  private readonly results: EmailSendResult[];

  /** `results` are returned in order for successive sends; after they run out every send succeeds. */
  constructor(results: EmailSendResult[] = []) { this.results = [...results]; }

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    const result = this.results.shift() ?? { status: "sent", providerMessageId: `recorded-${this.sent.length + 1}` };
    if (result.status === "sent") this.sent.push(email);
    return result;
  }
}
