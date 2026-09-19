# Quality budgets: accessibility, browser matrix and performance

Implementation tracker: GitHub issue #12. This document describes the
executable quality gates in `e2e/` and what they do and do not prove.

## Accessibility

`e2e/accessibility.spec.ts` runs [axe-core](https://github.com/dequelabs/axe-core)
against every critical customer surface (Overview, Documents, Data review,
Data delivery, Ask Corvis) plus the upload dialog, tagged against WCAG 2.1
A/AA (`e2e/quality-budgets.ts` → `accessibilityBudget.tags`). A `serious` or
`critical` finding fails the run; `moderate`/`minor` findings do not, since
the contractual bar is WCAG 2.1 AA, not a zero-finding ideal.

It also asserts, independent of axe: the workspace shell exposes the
expected semantic landmarks (`banner`, `navigation` named "Workspace
sections", `main`, `complementary` named "Workspace navigation") and exactly
one top-level heading; primary navigation is fully keyboard-operable in
visual order; every focusable control in the shell has an accessible name;
and the upload dialog traps focus, cycles it with Tab/Shift+Tab, and closes
on Escape.

**Fixed while building this gate** (all verified against the real
application, not asserted from source reading):
- 28 distinct muted-gray/status text colors across the app fell below the
  4.5:1 WCAG AA contrast ratio for normal text. Each was replaced with a
  version of the same hue darkened (or, on the dark sidebar, lightened)
  just enough to clear the ratio with a safety margin, computed against
  every background it actually appears on.
- The topbar "more options" button and the Ask Corvis send button were
  icon-only with no accessible name.
- `<nav>` and the sidebar `<aside>` carried no landmark label, and the
  in-app `<header>` had no explicit `role="banner"` (it is nested inside
  `<main>`, so it does not get that role implicitly).
- Active-nav-item state was expressed only via a CSS class, not
  `aria-current`.
- At the mobile breakpoint the sidebar's nav-item text becomes
  `display:none`, which removed the button's only accessible name; each nav
  button now also carries an explicit `aria-label`.
- The upload dialog had `role="dialog" aria-modal="true"` but no actual
  focus trap, initial-focus, or Escape handling — `components/ui/use-focus-trap.ts`
  is a small reusable hook that now provides all three plus focus
  restoration on close.
- On narrow viewports, `.table-card` becomes a horizontally-scrollable
  region with no keyboard access (`overflow-x: auto` with no
  `tabindex`); the three table containers (documents, data-review
  observations, reconciliation exceptions) are now `tabIndex={0} role="region"`
  with a descriptive label.

**Known, not fixed here:** the design tokens for status colors (warning
amber, danger red) were only checked for the two specific text usages axe
flagged; a full design-system contrast audit of every color combination is
out of scope for this pass.

## Browser / responsive matrix

`playwright.config.ts` runs three projects:
- `chromium` (Desktop Chrome viewport) — the full test suite.
- `mobile-chromium` (Pixel 5 viewport) — only `@matrix`-tagged tests, to
  keep CI affordable while still catching viewport-specific regressions
  (this is exactly how the mobile-breakpoint nav-label and scrollable-table
  bugs above were caught).
- `webkit` (Desktop Safari viewport) — only `@matrix`-tagged tests. Skipped
  locally when the WebKit engine is not installed (checked via
  `webkit.executablePath()`), but always required in CI, where the
  workflow installs every engine explicitly — a missing engine there is a
  failure, not a silent skip.

Currently `@matrix` covers the five accessibility surface checks. Extending
it to the canonical E2E journey in `e2e/workspace.spec.ts` is a natural next
step, deferred to keep the initial matrix small and fast.

## Performance budgets

`e2e/quality-budgets.ts` defines version-controlled ceilings, separately for
`development` (the demo-mode Next dev server CI/local runs against) and
`production` (`CORVIS_E2E_TARGET=production`, a built-and-started app).
Every number is deliberately generous — it exists to catch a hang or an
order-of-magnitude regression, not to police day-to-day runner jitter:

| Budget | development | production |
| --- | --- | --- |
| Initial navigation | 30 s | 10 s |
| Surface switch | 6 s | 3 s |
| Workspace API response | 6 s | 3 s |
| Document DOM node count | 2,500 | 2,500 |
| Script request count | 120 | 40 |
| Script transfer bytes | 48 MiB | 3 MiB |
| Horizontal overflow | 1 px | 1 px |

`e2e/performance.spec.ts` asserts each of these against the real running
app: navigation and per-surface switch wall-clock time, DOM node count,
script request count/bytes, and that the shell never introduces horizontal
page scroll at desktop width. The workspace-API-timing assertion is a no-op
under the default demo composition (`CORVIS_DEMO_MODE=true` serves the
workspace port entirely client-side, with no `/api/v1/*` traffic) and is
only meaningfully exercised against `CORVIS_E2E_TARGET=production`.

**Not yet covered:** representative large-dataset/large-document/quarter-end
load scenarios, and production-equivalent network conditions (throttled
connection, cold cache). Those need a production-like environment and
belong with #13's UAT activation evidence, not the demo-mode CI gate.

## What this does not prove

This is CI/local demo-mode evidence. It is not a substitute for the
production-like UAT run against a real IdP, Postgres/RLS, GCS and
export/webhook bindings that #12's remaining gap calls for — see
`docs/MODULARITY.md` and `docs/PRODUCTION_ACTIVATION.md` for that contract.
