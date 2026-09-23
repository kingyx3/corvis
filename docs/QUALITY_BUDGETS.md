# Quality budgets: accessibility, browser matrix and performance

Implementation tracker: GitHub issue #12. This document describes the
executable quality gates in `e2e/` and what they do and do not prove.

## Accessibility

`e2e/accessibility.spec.ts` runs [axe-core](https://github.com/dequelabs/axe-core)
against every critical customer surface (Overview, Documents, Data review,
Data delivery, Ask Corvis), the upload dialog, and the production admin console,
tagged against WCAG 2.1 A/AA (`e2e/quality-budgets.ts` →
`accessibilityBudget.tags`). A `serious` or `critical` finding fails the run;
`moderate`/`minor` findings do not, since the contractual bar is WCAG 2.1 AA,
not a zero-finding ideal.

The customer shell additionally asserts semantic landmarks, exactly one
primary heading, keyboard-operable primary navigation, accessible names for
focusable controls, and focus containment/restoration for modal workflows.
The shared `components/ui/modal.tsx` uses the same focus-trap primitive as the
upload dialog, so global search, reviewer correction/reconciliation dialogs,
and privileged admin confirmations all close on Escape, contain Tab focus and
restore focus on close. The document-details drawer is also an accessible,
focus-trapped modal surface.

The admin console is scanned independently for serious/critical axe findings
and unnamed visible focusable controls. Privileged mutations use typed labelled
controls plus a separate confirmation dialog rather than raw JSON textareas.
Raw API payloads remain available only inside advanced diagnostic disclosures.

**Fixed while building these gates** (verified against the running application):
- muted/status text contrast was raised to the WCAG AA threshold where axe
  identified failures;
- icon-only customer controls received accessible names;
- navigation/sidebar/banner landmarks and active-page semantics were added;
- mobile navigation retains accessible names when visible text is hidden;
- upload and subsequent shared modal workflows gained focus trapping, initial
  focus, Escape handling and focus restoration;
- horizontally scrollable document/review/reconciliation/export tables are
  keyboard-reachable labelled regions;
- document-row drill-through moved from a mouse-only clickable table row to an
  explicit keyboard-accessible named button;
- fake/dead-looking controls were either implemented (search, filters, source
  citations, export history/download) or removed from the production surface.

A full design-token contrast audit beyond rendered production surfaces remains
separate design-system work; rendered serious/critical WCAG findings remain a
CI failure.

## Browser / responsive matrix

`playwright.config.ts` runs three projects:
- `chromium` (Desktop Chrome viewport) — the full test suite.
- `mobile-chromium` (Pixel 5 viewport) — `@matrix`-tagged tests.
- `webkit` (Desktop Safari viewport) — `@matrix`-tagged tests. CI installs the
  engine explicitly, so a missing CI engine is a failure rather than a skip.

The matrix now includes the five customer accessibility surfaces and the admin
console. The canonical customer workflow still runs fully on Chromium; its
provider-backed multi-browser execution remains part of production-like UAT.

## Presentation workflow regressions

`e2e/workspace.spec.ts` covers the production presentation seams in demo-mode CI,
including:
- navigation across every entitled customer module;
- actionable global workspace search;
- functional document period/status filtering;
- upload lifecycle and accessible modal behavior;
- upload → review → publish → structured delivery;
- persisted/recent export-history presentation;
- structured reviewer correction instead of browser prompts;
- bounded degraded-module behavior; and
- Ask Corvis through the research adapter rather than hard-coded UI evidence.

Authorization remains server-authoritative. The customer UI consumes the
read-only current-user capability summary only to hide or disable unavailable
features; it never treats browser state as authorization. Capability lookup
failure fails closed for mutating actions.

## Performance budgets

`e2e/quality-budgets.ts` defines version-controlled ceilings separately for
`development` (demo-mode Next dev server) and `production`
(`CORVIS_E2E_TARGET=production`, a built-and-started app). The budgets catch
hangs/order-of-magnitude regressions rather than normal runner jitter:

| Budget | development | production |
| --- | --- | --- |
| Initial navigation | 30 s | 10 s |
| Surface switch | 6 s | 3 s |
| Workspace API response | 6 s | 3 s |
| Document DOM node count | 2,500 | 2,500 |
| Script request count | 120 | 40 |
| Script transfer bytes | 48 MiB | 3 MiB |
| Horizontal overflow | 1 px | 1 px |

`e2e/performance.spec.ts` asserts these against the running app. Workspace API
timing is meaningful only against the production HTTP composition; default
demo composition serves the workspace adapter client-side.

Representative large-dataset/large-document/quarter-end load, production-like
network conditions, real IdP/Postgres/RLS/GCS behavior and asynchronous provider
bindings still require the production-like environment defined by #12/#13.

## What this does not prove

These gates prove repository/demo and built-application presentation behavior.
They are not a substitute for production-like UAT against real IdP,
Postgres/RLS, GCS, durable processing, export/webhook providers and deployed
customer/admin runtime boundaries. Provider-backed accessibility, browser,
responsive and load evidence remains an explicit launch gate rather than being
inferred from CI.
