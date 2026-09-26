# Corvis design system

This is the implementation contract for customer-workspace UI. It complements the UX architecture in Confluence and prevents new surfaces from inventing one-off styling patterns.

## Live catalog

Run `npm run dev` and open `/design-system`. The route renders the real typed primitives and is intentionally unavailable in production (`notFound()` when `NODE_ENV=production`). The live catalog covers headings, actions, status vocabulary, metric cards, sidebar navigation, sortable/density-aware tables, and chart/table fallbacks.

## Tokens

Tokens live in `app/globals.css`; dark-theme overrides live in `app/design-system.css`. Feature code must consume tokens instead of hard-coded presentation colors.

| Group | Tokens | Use |
| --- | --- | --- |
| Surfaces | `--bg`, `--surface`, `--surface-raised`, `--surface-sunken`, `--surface-hover` | Page, card, nested and hover backgrounds |
| Borders | `--border`, `--border-strong`, `--border-subtle` | Standard, emphasized and quiet separators |
| Text | `--text`, `--text-strong`, `--text-body`, `--text-muted`, `--text-subtle` | Default, heading, body and secondary copy |
| Brand | `--brand`, `--brand-hover`, `--brand-ink`, `--accent` | Primary controls and Corvis accent |
| Sidebar | `--sidebar`, `--sidebar-hover`, `--sidebar-border`, `--sidebar-text`, `--sidebar-muted` | Workspace chrome only |
| Semantic | `--success*`, `--warning*`, `--danger*`, `--info*`, `--focus` | Status, validation and focus; never encode meaning by color alone |
| Shape | `--radius-sm`, `--radius`, `--radius-lg`, `--shadow-sm`, `--shadow-lg` | Consistent geometry/elevation |
| Type | `--serif`, `--sans`, `--mono` | Display, UI/body and data/code |
| Layout | `--sidebar-width`, `--topbar-height` | Shell dimensions |
| Charts | `--chart-series-1` … `--chart-series-8`, `--chart-series-other`, `--chart-series-unassigned`, `--chart-grid`, `--chart-axis` | Stable categorical order, muted gaps and axes |

Dark mode is automatic through `prefers-color-scheme: dark`; the token names do not change between themes. New code must not branch on theme in React.

## Typed primitives

| Primitive | File | Use |
| --- | --- | --- |
| `PageHeading` | `components/ui/page-heading.tsx` | Every customer surface H1, eyebrow, lede and heading actions |
| `MetricCard` | `components/ui/metric-card.tsx` | Dashboard/analytics KPI; renders a native button only when actionable and accepts a trend node |
| `SidebarNavItem` | `components/ui/sidebar-nav-item.tsx` | Workspace primary navigation with active/current state and optional badge |
| `StatusPill` | `components/ui/status-pill.tsx` | Governed state labels; use the exported vocabulary when a status is known. Unknown strings render neutral, never a fabricated semantic color |
| `SortableDataTable` | `components/ui/sortable-data-table.tsx` | Dense tabular data. Sorting is a native header button and `aria-sort` is announced on the column header |
| `TableDensityToggle` | `components/ui/table-density-toggle.tsx` | Compact/comfortable density control for dense financial tables |
| `Modal` | `components/ui/modal.tsx` | Dialogs; includes focus trapping/restoration |
| `Icon` | `components/ui/icon.tsx` | Shared icon vocabulary |
| `TimeSeriesChart` | `components/ui/charts/time-series-chart.tsx` | Time trends with explicit status semantics and table fallback |
| `CompositionChart` | `components/ui/charts/composition-chart.tsx` | Allocation/composition views with fixed palette and table fallback |
| `Sparkline` | `components/ui/charts/sparkline.tsx` | Inline KPI trend; includes textual delta and full value disclosure |
| `ChartFigure` | `components/ui/charts/chart-figure.tsx` | Required chart wrapper with caption and native table-view disclosure |

## Reusable global classes

These are the supported global styling hooks in `app/globals.css` and `app/design-system.css`. Feature-specific classes must be prefixed with the feature name (for example `position-financials-*`) and are not general-purpose primitives.

- Shell/navigation: `.app-shell`, `.sidebar`, `.sidebar-section`, `.sidebar-bottom`, `.main-area`, `.topbar`, `.breadcrumb`, `.top-actions`, `.global-search`, `.content`, `.skip-link`, `.visually-hidden`.
- Headings/layout: `.hero-row`, `.page-heading`, `.eyebrow`, `.lede`, `.heading-actions`, `.two-column`.
- Actions: `.primary-button`, `.secondary-button`, `.danger-button`, `.text-button`, `.icon-button`.
- Cards/panels: `.panel`, `.panel-heading`, `.metric-grid`, `.metric-card`, `.metric-head`, `.metric-icon`, `.metric-card-trend`.
- Forms: `.form-field`, `.form-row`, `.segmented-control` (when present on a surface); labels remain explicit and native controls remain keyboard operable.
- Status/feedback: `.status-pill`, `.status-dot`, `.status-stack`, `.lineage-note`, `.tone-warning`, `.empty-row`.
- Lists/data: `.snapshot-list`, `.snapshot-row`, `.snapshot-main`, `.activity-list`, `.activity-row`, `.muted-time`, `.data-table-wrap`, `.data-table`, `.sortable-header-button`, `.table-density-toggle`.
- Search/command palette: `.search-palette-input`, `.search-palette-results`, `.search-palette-empty`, `.search-result`, `.search-kind`, `.search-palette-footer`.
- Charts: `.chart-figure`, `.chart-plot`, `.chart-description`, `.chart-empty`, `.chart-legend`, `.chart-legend-swatch`, `.chart-tooltip`, `.chart-data-toggle`, `.chart-data-table-wrap`, `.chart-data-table`, `.sparkline`, `.sparkline-plot`, `.sparkline-delta`, `.sparkline-caption`.

If a reusable pattern is missing, promote it to a typed primitive first and document it here; do not add an unscoped one-off class to a feature.

## Status vocabulary

`STATUS_PILL_VOCABULARY` is the source of truth. Known states map to `success`, `warning`, `danger`, `info`, or `neutral`. `StatusPill` intentionally accepts future server-provided strings, but an unknown value uses the neutral fallback and keeps its original label. This prevents a new backend state from accidentally inheriting a misleading color through class-name construction.

## Dense-table rules

1. Use `SortableDataTable` instead of hand-rolled sortable headers.
2. Give every sortable column a `sortValue`; header buttons are keyboard-native and the owning `<th>` supplies `aria-sort`.
3. Keep a real `<caption>` (it may be visually hidden).
4. Use `TableDensityToggle` where badges/metadata make rows visually dense; compact mode changes spacing/typography only, not data.
5. Preserve source order as the initial order for financial statements; sorting is an explicit user action.

## Accessibility and theming

The Playwright accessibility matrix runs customer surfaces under both light and dark OS color schemes. Semantic state always has text/icon support; focus uses `--focus`; chart identity is never color-only; charts retain a keyboard-reachable table representation.
