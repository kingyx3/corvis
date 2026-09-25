# Position financial statements and client analytics

## Purpose

Corvis must be able to reconstruct the income statement disclosed for each company-targeted fund position across reporting cycles without forcing every source row into a fixed chart of accounts. The governed metric model remains the semantic analytics layer; the financial-statement model is the presentation-preserving layer that makes complete statements, period comparison and downstream interchange possible.

This distinction is intentional:

- `metric_observation` answers **what economic fact does this represent?**
- `position_financial_statement_*` answers **what exactly did the source statement show, in what order and hierarchy?**
- a statement row may have `metric_code = null` and still be valid, reviewable and deliverable;
- mapped rows retain their governed metric code so they can participate in reconciliation, research and cross-company analytics.

## Canonical shape

Migration `052_position_financial_statements.sql` adds three normalized tables.

### `corvis_facts.position_financial_statement`

One source statement instance within one reviewed extraction run. It binds the statement to tenant, source document, fund, holding, company, statement type and report period. `statement_key` is stable within the extraction run and groups all rows/cells that belong to the same displayed statement.

### `corvis_facts.position_financial_statement_line`

One presentation row. Required presentation metadata is:

- `line_key` — stable within one statement;
- `semantic_line_key` — stable across reporting periods when the same economic/presentation row recurs;
- exact `source_label`;
- optional governed `metric_code`;
- `line_role` (`line_item`, `subtotal`, `total`, `header`, `memorandum`, `other`);
- `parent_line_key`, `display_order` and `depth` to preserve hierarchy and ordering;
- complete source-reference lineage.

The semantic key must not depend on a reporting date. When a governed metric mapping exists, the metric code is normally the best semantic anchor. When none exists, extraction must use a stable source/hierarchy-derived key rather than dropping the row.

### `corvis_facts.position_financial_statement_value`

One disclosed cell/value for a statement line and economic period. It preserves raw and normalized values, unit/currency/scale/precision, value nature, exact period start/end, fiscal year/quarter, source-document period, scenario/actuality, preliminary/final state, restatement/re-reporting flags, derivation metadata and source references.

This long-form shape can represent a single-period P&L, side-by-side quarter/YTD/annual columns, prior-year comparatives, restatements and GP-specific line items without schema changes.

## Extraction contract

A reviewed extraction candidate may now use `candidate_type=financial_statement_line`. Use it for structural or statement-only rows that should be preserved even when there is no active governed metric mapping. Numeric rows with a valid governed metric should normally remain `metric_observation` candidates and carry the same statement fields so they materialize into both the semantic fact model and the statement model.

When `statement_type` is present, the candidate must also carry:

- `statement_key`
- `statement_line_key`
- `statement_line_label`
- `semantic_line_key` when it can be established more reliably than the fallback
- `statement_line_role`
- `parent_line_key` when applicable
- `display_order`
- `depth`
- resolved `fund_id`, `holding_id`, `company_id`
- `report_period`
- economic period fields (`period_type`, `period_start`, `period_end`, fiscal year/quarter where known)
- `source_document_period_end`
- normal value/unit/currency/scenario/source-version fields and exact source references.

A structural header can omit a value. A disclosed dash/NM/N/A is not a structural absence: preserve it in `value_raw`/`value_string` with the applicable value qualifier.

## Periodicity rules

The client API accepts `periodicity=reported|quarterly|annual`.

`reported` returns all published source columns and preserves their exact economic cadence. `quarterly` returns only explicit `period_type=quarter` values plus statement structure. It does **not** manufacture a quarter from YTD or LTM data.

`annual` first uses an explicit source-reported `annual` or `annual_embedded_in_quarterly` value. Only when no reported annual exists may Corvis derive an annual value, and only when all four fiscal quarters are present for the same semantic line and the values are compatible `flow` observations with the same fund/holding/company, metric/semantic key, fiscal year, currency, unit, scale, actuality and scenario. Stock, cumulative, YTD, LTM, run-rate and incomplete quarter sets are never summed. Derived rows are explicitly marked and retain all contributing source-reference IDs.

These rules make the quarterly/annual toggle deterministic and auditable rather than a presentation-layer arithmetic shortcut.

## Serving and authorization

`GET /api/v1/position-financials` requires `observations:read`. Filters include `fundId`, `holdingId`, `companyId`, `statementType`, `periodicity` and `limit`.

The serving repository fails closed unless:

1. the fund is in the caller's authoritative fund entitlement set;
2. the source document is in the caller's entitled document set;
3. the statement belongs to a currently published fund-period snapshot (a later withdrawn/superseded version does not count as current publication).

The response is deliberately long-form. Each row contains statement identity, position identity, presentation structure, optional metric mapping, value/period semantics, source-version/restatement flags and source-reference IDs. This is the stable interchange contract for client applications; consumers can pivot it into their own chart of accounts without Corvis hard-coding their schema.

## Client analytics UI

The client workspace exposes **Portfolio analytics → Position financials** when the user has `observations:read`.

The view provides:

- fund-position selector;
- quarterly, annual and as-reported lenses;
- sticky source-statement row labels and period columns;
- preserved subtotal/total/header hierarchy and source ordering;
- optional governed metric code alongside the exact source label;
- derived/restated/preliminary markers;
- an explicit annual-aggregation guardrail.

The next analytical surfaces should build on the same long-form contract rather than create new denormalized persistence models: period-over-period variance/waterfall, margin and growth trends, cross-company KPI normalization, covenant/debt analytics, valuation bridge, source-vs-normalized toggle, data-quality badges and drill-through to source evidence.

## Client-system delivery

The same long-form model is appropriate for API, Parquet and warehouse delivery because it is additive: a new source line, period, scenario or metric does not require a new physical column. Recommended external keys are:

`fund_id + holding_id + company_id + statement_type + semantic_line_key + economic period + scenario/actuality`

Consumers that require a wide financial statement should pivot at delivery time using `semantic_line_key` (or their own mapped account code) while retaining `source_label` and `line_key` for traceability. Never make a client's destination chart of accounts the Corvis canonical schema.

For change-data pipelines, treat source statement/value records as immutable disclosures. Restatements, re-reported prior periods and preliminary-to-final transitions are additional versioned records; downstream selection policy decides which is current while historical variants remain queryable.

## Production invariants

- Every disclosed material income-statement row survives extraction, even without a metric mapping.
- Presentation structure never changes the semantic metric definition.
- Metric mapping never erases source labels or source ordering.
- Economic period and source-document/report period remain separate.
- Annual derivation is restricted to complete compatible quarterly flows.
- Published client analytics never depend on another tenant's evidence.
- Source references remain sufficient to drill any displayed value back to its page/sheet/cell evidence.
- The model is statement-type extensible; balance sheet, cash-flow statement and statement of equity use the same structure without altering the income-statement contract.
