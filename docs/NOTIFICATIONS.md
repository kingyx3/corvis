# Email notifications

Technical implementation of backlog story F2 (#258). The Confluence *Customer Web Workspace — User Story Backlog* owns the requirement; this document owns how it is built.

## What is sent, to whom

| Category | Trigger | Recipients | Configurable |
| --- | --- | --- | --- |
| `invitation` | Invitation issued or resent (C2/C3/C12/C15) | The invited address | No (transactional) |
| `export_ready` | Export job reaches `complete` | The requesting person | On/off, immediate or daily digest (default: on, immediate) |
| `pinned_fund_published` | Snapshot published | Everyone who pinned that fund, per workspace | On/off, immediate or daily digest (default: on, digest) |
| `source_attention` | Sync moves a connection to `reauthorization_required` or `suspended` | `tenant_admin` and `accountadmin` members of the workspace | On/off, immediate or daily digest (default: on, immediate) |
| `support_access` | Support access granted (active or pending acknowledgement) | Every `tenant_admin` | No: always sent immediately |
| `role_changed` | Tenant admin changes or removes a member's role | The affected member | No: always sent immediately |
| `digest` | Oldest deferred item for a person is 24 hours old | That person | Follows the categories it bundles |

`source_attention` is a one-shot email enqueued when a sync moves a connection to `reauthorization_required` or `suspended`; it is deduplicated per run and there is no stored in-app notification record to clear. The in-app signal (the attention banner on Documents and the connection list) is derived from the live connection status, so it disappears as soon as the connection is healthy again. Only reauthorization returns a `reauthorization_required` or `suspended` connection to `active`: a successful sync cannot, because `runConnectionSync` refuses any connection that is not already `active`.

The catalog, audiences and templates live in `core/notifications.ts`. Stories that don't exist yet (F3 assignment/mentions, F5 data-issue updates, F7 sign-in policy) add a category there when they ship.

## Content rules

Emails never contain financial figures, document content, fund or company names, or support-grant purposes. They carry a short event description, at most a workspace name, and a link back into the app, where normal authorization applies. Every optional email links to `/?notifications=settings`, which opens the settings dialog. Mandatory notices say they cannot be turned off. Names are escaped and length-bounded, and a link that is not absolute `https` is refused at render time.

## Recipient addresses

`corvis_control.notification_recipient` holds one address per tenant user. It is written only:

- from a **verified** OIDC/SAML email claim, on `GET /api/v1/me` (the app calls it on every load, so the address follows the identity provider), or
- from an **accepted invitation**, whose acceptance already required a matching verified email.

It is never taken from free-text input. A person with no verified address gets nothing, and the outbox records `no_verified_address`.

## Data model (migration 071)

- `notification_recipient` — `(tenant_id, user_id)` → verified address.
- `notification_preference` — `(tenant_id, user_id, category)` → `enabled`, `delivery`. A missing row means the catalog default. Mandatory categories are never stored.
- `email_outbox` — durable queue. It stores only enums and identifiers (`workspace_id`, `fund_id`, `required_roles`) plus a `dedupe_key` unique per tenant, so re-running a trigger never queues a duplicate.

All three have RLS enabled and forced, with no client policies. The service role accesses them with explicit tenant predicates.

## Delivery pipeline

1. **Enqueue.** Triggers insert outbox rows. Inside a business transaction (role change, support grant, snapshot publish) the insert runs under a savepoint via `bestEffortNotification`, so a notification failure can never block the business action. Export completion and connector sync enqueue best-effort after their own writes.
2. **Dispatch.** `processEmailOutbox`, on the private worker's delivery tick (`/api/internal/delivery`), claims due rows with `FOR UPDATE SKIP LOCKED` and a 5-minute lease. At send time it re-checks that the identity is active, the membership (and role, and fund entitlement for pinned funds) still holds, and the preference is still on. Anyone who lost access in between is suppressed as `not_eligible`.
3. **Digest.** `processEmailDigests` bundles a person's `digest_pending` rows into one `digest` row once the oldest is 24 hours old. The bundle and the `digested` marks commit in one statement.
4. **Outcomes.** `sent`, `suppressed` (with a reason: `opted_out`, `no_verified_address`, `not_eligible`, `provider_not_configured`, `app_url_not_configured`), `retry` (capped exponential backoff: 1, 2, 4, 8 minutes up to 1 hour) and `dead_letter` after 5 attempts.

**Invitations** are sent inline right after the invitation commits, because the link embeds a single-use token that must never be persisted. The outbox gets a record of the outcome without the link. The API response carries `emailDelivery: "sent" | "not_configured" | "failed"`, and the one-time link is still returned for the manual fallback.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CORVIS_EMAIL_PROVIDER` | `disabled` | Provider adapter. Only `disabled` exists today; any unknown value fails closed to disabled and is logged once. |
| `CORVIS_EMAIL_FROM` | unset | Sender address for the provider adapter. |
| `CORVIS_PUBLIC_APP_URL` | unset | Public `https` origin used to build links. Terraform derives it from the customer hostname in uat/prod. Without it, emails are suppressed (`app_url_not_configured`). |

Demo mode never sends.

## Activating a provider

Nothing is emailed until a provider is activated. Activation needs:

1. A vendor decision and an entry in the Confluence *Critical Vendor, Subprocessor, Data Location & AI System Register*: recipient addresses and event types leave Corvis.
2. An adapter under `adapters/email/` implementing `EmailSender`, selected in `lib/server/email-sender.ts`, with its API key in Secret Manager (see `RUNTIME_SECRETS.md`).
3. Sending-domain DNS (SPF, DKIM, DMARC) on the Cloudflare zone.
4. `CORVIS_EMAIL_PROVIDER` / `CORVIS_EMAIL_FROM` set per environment.

Until then, the settings dialog says "Email delivery isn't switched on yet", and choices are saved and apply on activation.

## Tests

- `core/notifications.test.ts` — audiences, mandatory rules, preference validation, template content and escaping.
- `lib/server/notifications.test.ts` — savepoint isolation, provider selection, recipient capture rules, invitation outcomes (the token is never written).
- `lib/server/route-authorization.test.ts` — service identities are refused; mandatory and hidden categories cannot be changed.
- `db/postgres/tests/email-notifications.mjs` — end to end against real Postgres in CI: capture, preferences, audience enqueueing, deduplication, send-time eligibility, retries, digests, invitation records.
- `e2e/notification-settings.spec.ts` — dialog reachable from the sidebar, the mobile workspace dialog, the command palette and the email link; axe in light and dark.
