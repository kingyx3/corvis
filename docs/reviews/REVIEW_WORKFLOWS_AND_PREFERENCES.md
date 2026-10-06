# Review workflows and personal preferences

This change implements GitHub issues #254, #255, #256, #264 and #270.

## Exception investigation

Review exceptions offer **Explain with Ask Corvis** to users with Research access. The action opens an editable draft containing the fund, reporting period, metric and explicit subject identifier. Nothing is submitted automatically. The governed query binds that subject as SQL parameters and retains the existing tenant, fund and document entitlement filters. Answer citations use the existing Review evidence path.

The resolution dialog shows up to four recent published periods for the same subject and metric, with compatible currency/unit. History comes from published snapshot facts, excludes conflicting alternatives and source documents the viewer cannot currently read, and displays preliminary, restated and derived markers. The chart has an accessible table and honest empty/single-point states. The existing resolution command and audit workflow remain unchanged.

## Original source documents

Review and Research evidence panels hand off to the same Document drawer as Position Financials. The drawer shows known page, sheet and cell locations; PDFs open at the known page in the browser's PDF viewer, and other files can be downloaded.

`GET /api/v1/source-references/{sourceReferenceId}/document` resolves the authenticated workspace, checks `sources:read` and current original-document rights, and reads only a clean, released artifact from the configured bucket's tenant/document prefix. The GCS read pins the stored generation. Reads are audited with the request correlation ID. Responses prohibit caching and MIME sniffing. Unavailable, quarantined or inaccessible originals cannot be retrieved through a saved view or evidence link.

## Saved views

Review, Position Financials and Documents offer named views capturing filters, sorting and visible columns. Users can set a default for each screen, rename/delete their views, and share a view read-only within the workspace. Shared views contain presentation configuration, never data or entitlement grants. Each viewer's normal data APIs reauthorize the selection. Missing positions, portfolios, periods or snapshots produce an explanatory empty scope rather than broadening a saved filter.

The server derives ownership from tenant, workspace, authentication method and subject. Shared-view mutation remains owner-only. Updates lock the owner's preference row; defaults are returned only while their referenced view remains readable. Each owner may store at most 100 views.

## Display preferences

Display preferences offer an IANA time zone, day-first/month-first/ISO dates, and US/German/French number separators. The initial browser zone is used when the user has no saved preference. Settings persist per user within the tenant and follow the user across workspaces; transactional updates serialize concurrent workspace writes. Dates, charts, evidence values, financial tables and metadata use common presentation helpers. Notification and invitation templates use the known recipient's preferences; a new recipient without a profile uses the documented default (UTC, day-first, US separators).

Calendar-only financial/as-of dates stay on their original date in every zone. True instants convert to the selected zone. Stored values, authored answer prose, query inputs, identifiers and machine exports keep their original representation. Numeric source tokens retain decimal precision rather than passing through binary floating-point conversion.

## Assigning and discussing review items

Story F3 (#259). In Data review every observation row and every reconciliation exception shows who holds it ("Assigned to you", "Assigned to <person>" or "Unassigned") and an **Assign or discuss** button, for roles with review access only. The dialog assigns, reassigns or clears the assignee (only workspace members with review access to the item's fund are offered) and shows the comment thread with a composer. A teammate is mentioned by choosing them from **Mention a teammate**, which inserts `@<name>`; mentions that are still in the text when it is posted notify that person. A toolbar **Assignment** filter (All assignees, Assigned to me, Unassigned) applies to both tables and is remembered with the other review filters for the session. On the Overview, the **Needs your attention** list has an **Assigned to me** view of the caller's open assigned items, blocking exceptions first, each opening Data review on the item.

Discussion is deliberately inert: it never changes a value, never records an approval, rejection, correction or resolution, and never counts toward dual control. Comments cannot be edited or deleted, are audited, and are never emailed. Known limits of this first slice: mentions are chosen from a list rather than typed with a live suggestion box; the assignment filter is not part of saved views; the thread has no assignment history list beyond the audit trail; and "Assigned to me" on the Overview lists individual items rather than narrowing the per-snapshot counts above it. Demo mode has two fixed review teammates and no seeded threads.

## Rollout and validation

The baseline migration is applied with the existing migration runner before the application is deployed. The schema extends the existing forced-RLS preference table without changing grants or resource policy. No provider credentials or email-delivery flags are enabled by this change.

Validation includes unit coverage for formatting, subject-bound SQL, original-object authorization and generation pinning; database acceptance for owner/shared-view isolation, cross-workspace preferences and historical source/fund revocation; and browser scenarios for the editable Research draft, source handoff, history resolution, all three saved-view screens and both themes. The new browser scenarios participate in the Chromium, mobile Chromium and WebKit CI matrix. The existing production CSP and non-demo smoke checks remain required.
