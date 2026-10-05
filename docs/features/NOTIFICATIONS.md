# Email notifications

Technical implementation of backlog story F2 (#258). The Confluence *Customer Web Workspace — User Story Backlog* owns the requirement; this document owns how it is built.

## What is sent, to whom

| Category | Trigger | Recipients | Configurable |
| --- | --- | --- | --- |
| `invitation` | Invitation issued or resent (C2/C3/C12/C15) | The invited address | No (transactional) |
| `export_ready` | Export job reaches `complete` | The requesting person | On/off, immediate or daily digest (default: on, immediate) |
| `pinned_fund_published` | Snapshot published | Everyone who pinned that fund, per workspace | On/off, immediate or daily digest (default: on, digest) |
| `data_issue_update` | A data issue case you reported moves to Investigating, Corrected or No change (F5) | The person who reported it (a verified human identity; service identities get the in-app status only) | On/off, immediate or daily digest (default: on, immediate) |
| `review_discussion` | A review item is assigned to you, or you are @mentioned in its discussion (F3) | The assigned or mentioned person, who must still hold review access to the item's fund in that workspace | On/off, immediate or daily digest (default: on, immediate) |
| `export_schedule_failed` | A scheduled export you own was refused at run time (fail-closed) or its export could not be delivered (F4b) | The schedule's owner (a verified human identity), unless they switched emails off for that schedule | On/off, immediate or daily digest (default: on, immediate), and per schedule |
| `source_attention` | Sync moves a connection to `reauthorization_required` or `suspended` | `tenant_admin` and `accountadmin` members of the workspace | On/off, immediate or daily digest (default: on, immediate) |
| `support_access` | Support access granted (active or pending acknowledgement) | Every `tenant_admin` | No: always sent immediately |
| `security_policy` | An Organization Admin changes the organization's session policy, or signs a user out of every session (F7) | Every `tenant_admin` | No: always sent immediately |
| `tenant_export_approval` | An Organization Admin requests a full tenant data export, which a different Organization Admin must approve (F10d) | Every other active `tenant_admin` | No: always sent immediately |
| `tenant_export_outcome` | The requester's full export is approved, rejected, ready to download, or could not be built (F10d) | The requester (an Organization Admin) | On/off, immediate or daily digest (default: on, immediate) |
| `deletion_request_approval` | An Organization Admin requests deletion of some of the organization's data, which a different Organization Admin must approve (F10e) | Every other active human `tenant_admin` | No: always sent immediately |
| `service_account_expiry` | A service account, or the API credential it uses, enters its 14-day (then 3-day) expiry window (F6d) | Every active human `tenant_admin` | No: always sent immediately |
| `role_changed` | Tenant admin changes or removes a member's role | The affected member | No: always sent immediately |
| `digest` | Oldest deferred item for a person is 24 hours old | That person | Follows the categories it bundles |

`source_attention` is a one-shot email enqueued when a sync moves a connection to `reauthorization_required` or `suspended`; it is deduplicated per run and there is no stored in-app notification record to clear. The in-app signal (the attention banner on Documents and the connection list) is derived from the live connection status, so it disappears as soon as the connection is healthy again. Only reauthorization returns a `reauthorization_required` or `suspended` connection to `active`: a successful sync cannot, because `runConnectionSync` refuses any connection that is not already `active`.

The catalog, audiences and templates live in `core/notifications.ts`. F7 session policy changes shipped as `security_policy` (below), F5 data-issue updates shipped as `data_issue_update` and F3 assignments and mentions as `review_discussion` (both below).

### F5 data-issue updates

`data_issue_update` is enqueued in the same transaction as the case's status change (`lib/server/data-issue.ts`, through `bestEffortNotification` and `enqueueForUser`, so a notification fault never blocks the change), once per case and status (`dedupe_key = data_issue_update:<caseId>:<status>`). It happens on every Data Operations move (`PATCH /api/v1/admin/data-issues/{caseId}`) and when resolving a governed correction closes the cases linked to it (`POST /api/v1/admin/data-corrections` `resolve`). The outbox row carries only the reporter's user id, the workspace, the case's `fund_id` (so send-time eligibility re-checks the fund entitlement and workspace membership, exactly as for `pinned_fund_published`) and `template_params = {"status": "..."}`.

The email says only that a data issue the person reported moved to a status ("Data Operations is investigating...", "was corrected. A replacement publication is available.", "was reviewed and no change was needed.") and links to `/#/issues`. It never names the fund, company, metric, period or snapshot, never quotes the comment or a resolution note, and never carries a figure: those live in the Data issues view, behind normal authorization. The in-app signal is independent of email: the reporter's case list shows an **Updated** badge and the sidebar a count until they open or acknowledge the case (`reporter_seen_status` on the case, cleared by `PATCH /api/v1/data-issues/{caseId}` `{"seen": true}`), so a person with no verified address, a service identity, or one who switched the category off still sees the change in the app.

### F7 sign-in and session policy changes

`security_policy` is the mandatory security notice for Organization Admins: it is queued by `lib/server/session-policy.ts` (through `bestEffortNotification` and `enqueueForRoleAudience`, inside the same transaction as the change, so a notification fault never blocks it) when the session policy actually changes (saving the values it already has queues nothing) and when an Organization Admin signs a user out of every session. Recipients are every active `tenant_admin` of the tenant, including the admin who made the change, resolved from membership when it is queued and re-checked at send time (`required_roles = ['tenant_admin']`, tenant-wide, no workspace). Each change gets its own `dedupe_key` (`security_policy:<uuid>`), so two changes are two emails. Like `support_access` and `role_changed` it is mandatory: it ignores any stored preference, is always immediate, is not a preference category (the `notification_preference` check does not list it and the preference API refuses it) and its email has no "change your settings" footer.

The email says only that the policy changed ("An Organization Admin changed the sign-in and session policy") or that a user was signed out of every session, and links to `/access-self-service`, where the access audit trail shows who did it, why and the before and after values. It never names the people involved or states the new limits. Migration 087 adds the category to the `email_outbox` check.

### F10e deletion request approval

`deletion_request_approval` follows the customer deletion request (`API_CONVENTIONS.md`, "Deletion requests (F10e)"), queued by `corvis_control.request_customer_deletion` (migration 098) in the same transaction as the request, to every *other* active human Organization Admin (never the requester, a revoked admin or a service identity), once per request and recipient (`dedupe_key = deletion_request_approval:<requestId>:<userId>`). A failure to queue it is a warning and never fails the request.

**Mandatory, and why.** Like `tenant_export_approval` it is the notice that lets the four-eyes control work: a deletion needs a *different* Organization Admin to approve it, so an admin who could opt out of being asked would weaken the control, and an unexpected request is itself a security signal. It is not a stored preference (`notification_preference_category_check` is unchanged), and the rows carry `required_roles = {tenant_admin}`, so an admin demoted after it was queued is suppressed as `not_eligible` when it is sent. There is deliberately no outcome category: the requester sees the decision in the request list, and the audit trail records it.

**Content.** Words only: that an Organization Admin asked for deletion of some of the organization's data, that a different Organization Admin must approve it before Corvis acts on it, and a link to `/access-self-service` (the Deletion requests list, where the request can be approved or rejected). It never names the requester, the reason or the data classes.

### F10d full tenant export approval and outcome

Two categories follow the full tenant data export (F10, `API_CONVENTIONS.md`), queued by the `tenant_export_request_event_notify` trigger of migration 089 in the same transaction as the step (so the approval workflow, the build worker and a build failed by the lease reclaim all notify, and an outbox fault is a warning that never undoes the step).

**Mandatory or optional, and why.** `tenant_export_approval` is mandatory (the F2 rule for notices that make a security control work): the export needs a *different* Organization Admin to approve it, so an admin who could opt out of being asked would weaken the four-eyes control, and a request nobody expected is itself a signal the other admins should see. It goes to every other active human `tenant_admin`, never to the requester, and cannot be turned off or deferred to a digest. `tenant_export_outcome` is a normal preference (default on, immediate, digest allowed) for the requester: it reports what happened to their own request, which the access page shows anyway. It is only visible in notification settings to Organization Admins, who are the only people who can request an export. A withdrawal by the requester and a request that lapses unapproved queue nothing (the requester did the first, and the second is shown on the access page).

The recipient's eligibility is re-checked when the email is sent, like every other category: the rows carry `required_roles = {tenant_admin}`, so an admin demoted or removed after the notice was queued is suppressed as `not_eligible` (`opted_out` for a requester who switched the outcome category off, `no_verified_address` without an address).

**Content.** Words only. The approval email says that an Organization Admin asked for a full export of the organization's data and that a different Organization Admin must approve it before anything is built, and links to `/access-self-service`. It never names the requester, quotes the stated reason or says what the export contains. The outcome email says one of "was approved and is being built", "was rejected by a different Organization Admin", "is ready to download" or "could not be built", and links to the same page; it never quotes the rejection note, names the approver or carries a figure. The `event` parameter (`approval_needed`, `approved`, `rejected`, `ready`, `failed`) is the only content in the outbox row.

**In-app.** The email is not the only signal: the access self-service page shows a notice at the top ("A data export is awaiting your approval", linking to the request) to an Organization Admin while a colleague's request waits for them, with no new navigation item. It works whether or not email is switched on and clears when the request is decided.

### F6d service account and credential expiry

`service_account_expiry` is mandatory (the F2 rule for a notice that makes a control work: an account's finite lifetime and review is the 009 lifecycle control, and an admin who could opt out of hearing that a credential is about to stop would defeat it) and goes to every active human `tenant_admin`. It is queued by the `serviceAccountExpirySweep` task of the private delivery tick (`lib/server/service-account-expiry-sweep.ts`, `corvis_control.queue_service_account_expiry_notices`, migration 096), not by a trigger: an expiry is a point in time, not an event. Per active account of an active tenant it queues one notice per admin and per window when the account, or the credential in use, is within 14 days of expiring (`warning`) and again within 3 days (`final`), only the tightest window that applies. `dedupe_key = service_account_expiry:<account|credential>:<id>:<window>:<expiry epoch>:<admin user id>`, so the sweep is idempotent however often it runs, a renewal starts its own windows instead of repeating an old one, and nothing is queued for a deactivated or expired account, a revoked or rotating-out credential, a credential that ends with its account (the account's notice covers it) or a suspended tenant. A recipient who loses the role between queueing and sending is suppressed as `not_eligible` (`required_roles = {tenant_admin}`, tenant-wide, no workspace). Migration 096 re-lists every category in `email_outbox_category_check` (including `service_account_expiry`); mandatory categories are never stored as preferences.

Content is **words only**: the outbox row holds `{subject: "account" | "credential", window: "warning" | "final"}` and the email says that a service account, or an API credential for one, in the organization expires within the next 14 or 3 days, what to do (extend it or plan its replacement, or rotate the credential) and links to `/access-self-service`. It names no account, workspace, owner, purpose or credential, and says it cannot be turned off. Which account is in the page behind the link ("Needs attention", "Expiring soon").

### F4 scheduled exports

A scheduled run creates an ordinary export job, so its completion sends the same `export_ready` email to the schedule's owner (subject to their preference: switch the category off or to a daily digest to quieten a busy schedule), and `ExportRequested` webhook subscribers receive the event for every run.

**F4b: per-schedule switch, refusal email and webhook events (migration 090).** Each schedule has `notify_on_completion` (default on), chosen when it is saved and changed by its owner only (audited as `export_schedule.notify`). With it off, nothing is emailed about that schedule's runs: `enqueueExportReady` skips an export that an opted-out schedule requested, and no failure email is queued. It is a second gate beside, not instead of, the owner's category preferences. `export_schedule_failed` is queued by `lib/server/export-schedule-notifications.ts` (through `bestEffortNotification`, with a savepoint when it runs in the transaction that records the run, so a notification fault never blocks the run) in two cases: a run is refused at run time (every fail-closed reason, including `owner_inactive` and `redistribution_not_permitted`), and the governed export a run requested ran out of delivery attempts (`export_failed`). It is once per run (`dedupe_key = export_schedule_failed:<runId>`), goes to the owner only when they have a verified human identity (a service identity gets no email), and the row carries the owner, the workspace and `template_params = {"reason": "<code>"}`; send-time eligibility re-checks the identity and the workspace membership, so an owner who lost access is suppressed as `not_eligible`.

The email says only that a scheduled export in the workspace did not run and gives the reason in words from a closed set ("because you no longer have permission to create exports", "because your organization's data rights no longer permit redistribution", "because its scope no longer resolves to published data", "was requested but could not be delivered", and so on), then links to Data delivery, where normal authorization applies and the run shows with its schedule name. It never names the schedule, its scope, a fund, a company or a snapshot, and never carries a figure; `core/notifications.test.ts` and `db/postgres/tests/export-schedules.mjs` pin that. The same refusals and delivery failures also reach webhook subscribers as `ExportScheduleRunFailed` (and completion as `ExportScheduleRunCompleted`) with the schedule id and label only, independent of the owner's email switch; see `API_CONVENTIONS.md` (Scheduled exports).

### F3 review assignments and mentions

`review_discussion` is enqueued by `lib/server/review-discussion.ts` (through `bestEffortNotification` and `enqueueForUser`, inside the same transaction as the assignment or comment, so a notification fault never blocks it) in two cases: a review item is assigned or reassigned to someone other than the person acting (`dedupe_key = review_discussion:assigned:<kind>:<id>:<thread version>`), and a comment mentions a teammate other than its author (`review_discussion:mention:<commentId>:<userId>`). The outbox row carries the recipient, the workspace, the item's `fund_id`, `required_roles = [tenant_admin, accountadmin, reviewer]` and `template_params = {"event": "assigned" | "mentioned"}`, so send-time eligibility re-checks the identity, the workspace membership **in a review role** and the fund entitlement, and the preference.

The email says only that "A review item in <workspace> was assigned to you" or "You were mentioned in a discussion on a review item", and links to `/#/review`. It never names the item, the fund, the company, the person who acted or any comment text: comments are free text and stay in Data review, behind normal authorization (and out of audit events too). Assignment and discussion work without email: the assignee shows on the row and in the Overview "Assigned to me" view whatever the recipient's preference or address.

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
- `core/notifications.test.ts` also pins the `data_issue_update` template: status wording only, no figure, name or case detail.
- `db/postgres/tests/data-issue-reports.mjs` — the F5 notice end to end against real Postgres in CI: queued with status-only params, dispatched in words without any fund, company, metric or comment text, suppressed when the person opted out.
- `db/postgres/tests/review-item-discussion.mjs` — the F3 notice end to end against real Postgres in CI: assigned and mention notices queued with event-only params, dispatched in words without any item, fund, person or comment text, not sent to the author, suppressed when the recipient lost review access or opted out.
- `db/postgres/tests/tenant-data-export.sql` and `tenant-data-export.mjs` — the F10d notices end to end against real Postgres in CI: the approval notice goes to every other active human Organization Admin (not the requester, an analyst, a revoked admin or a service account), the outcome notice to the requester only, for approval, rejection, readiness and failure (including a build failed by the lease reclaim), once per step, in words-only parameters; a requester who opted out is suppressed, an admin demoted after the notice was queued is suppressed as `not_eligible`, the sent emails carry no reason, note or name, and an outbox fault never blocks the step.
- `e2e/data-governance.spec.ts` and `e2e/access-pages-accessibility.spec.ts` — the in-app approval notice (shown while a colleague's request waits, links to it, clears once decided, axe in both themes).
- `db/postgres/tests/export-schedules.sql` and `export-schedules.mjs` — the F4b switch, the run events and the refusal email end to end against real Postgres in CI: opt in and out (ready email and failure email), once-per-run events with an ids-and-label payload, dispatch in words without any schedule name, scope, fund or snapshot, an unsubscribed owner category.
- `lib/server/export-schedule-notifications.test.ts`, `delivery-export-completion.test.ts` — the best-effort announcement of a finished or failed scheduled export.
- `db/postgres/tests/service-accounts.sql` and `service-accounts.mjs` — the F6d notices end to end against real Postgres in CI: queued once per active human Organization Admin per window (exact counts), the tighter window queued once, renewal and deactivation never repeat or add notices, revoked, rotating-out, lapsed and distant items and suspended tenants are quiet, the parameters and sent emails are words only, no preference can switch the category off, an admin who lost the role by send time is suppressed as `not_eligible`.
- `lib/server/service-account-expiry-sweep.test.ts` — the sweep's batch bound, count-only logging, and that it is part of the delivery tick.
- `db/postgres/tests/email-notifications.mjs` — end to end against real Postgres in CI: capture, preferences, audience enqueueing, deduplication, send-time eligibility, retries, digests, invitation records.
- `e2e/notification-settings.spec.ts` — dialog reachable from the sidebar, the mobile workspace dialog, the command palette and the email link; axe in light and dark.
