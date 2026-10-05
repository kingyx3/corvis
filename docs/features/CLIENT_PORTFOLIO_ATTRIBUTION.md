# Client portfolio attribution

## Purpose

A Corvis tenant/client may maintain multiple investment portfolios. Each portfolio can contain one or more invested fund positions, and the same economic fund may appear in more than one portfolio. The portfolio layer sits **above** the canonical fund-down graph:

```text
Tenant / client
  |
  +-- Workspace
        |
        +-- Client portfolio
              |
              +-- Portfolio fund position
                    |
                    +-- Fund
                          |
                          +-- Holding -> Company
                          |
                          +-- Holding -> Underlying fund -> Holding -> ...
```

The portfolio layer is an attribution/grouping layer. It does not replace or clone canonical funds, holdings, companies, instruments, observations or fund-period snapshots.

## Core invariants

1. **Fund-down truth remains canonical.** `Fund -> Holding -> Company | Underlying Fund` continues to own investment facts.
2. **Portfolio membership does not grant access.** Every portfolio-serving read intersects the exact workspace with authoritative fund entitlements.
3. **Common holdings remain separate holding paths.** If Fund A and Fund B both hold Company X, a portfolio containing both funds exposes both paths and preserves each fund's holding-level ownership/position-size facts.
4. **Do not ownership-weight company operating data.** Revenue, EBITDA, headcount and other company operating facts remain 100% source-reported values. They are not multiplied by fund ownership percentages, LP interests, portfolio weights or position sizes.
5. **Attribution is path-preserving.** Feeder/FoF/master structures are traversed recursively without duplicating canonical holdings onto the client portfolio or feeder fund.
6. **No double-counting by default.** Analytical totals must not sum repeated company operating facts simply because the same company is reachable through multiple fund/holding paths. Path-level exposure and company-level operating performance are distinct analytical concepts.

## Persistence

Migration `053_client_portfolio_attribution.sql` adds:

- `corvis_facts.client_portfolio` — tenant/workspace-scoped portfolio identity;
- `corvis_facts.client_portfolio_fund_position` — a portfolio-to-fund attribution edge. `position_key` allows multiple client positions in the same economic fund without duplicating the fund identity;
- `corvis_serving.client_portfolios` — current active portfolios;
- `corvis_serving.client_portfolio_fund_positions` — current active portfolio/fund edges;
- `corvis_serving.client_portfolio_holding_attribution` — recursive path-preserving attribution from a portfolio's invested funds through approved fund-targeted holdings to all reachable approved holdings.

Portfolio setup is server/import managed. No broad direct client write policy is created.

## Why the edge is separate from `holding`

`corvis_facts.holding` answers: **what does this fund own?**

`client_portfolio_fund_position` answers: **which invested fund belongs to this client portfolio?**

Those are different relationships and must not be collapsed. A client portfolio can include Fund A and Fund B even when both hold the same company. Fund A's and Fund B's company holdings can legitimately have different ownership percentages, invested capital, fair values, security structures or reporting histories.

## Attribution versus economic scaling

A portfolio may use holdings for concentration/exposure analysis, but the path does not alter company financial statements.

Example:

```text
Portfolio Alpha
  -> Fund A -> Holding A/X -> Company X (Fund A ownership 20%)
  -> Fund B -> Holding B/X -> Company X (Fund B ownership 8%)
```

Company X revenue of 1,000 remains 1,000 on both source-grounded company-financial views. Corvis does **not** display 200 or 80 as company revenue. If a future analytical product needs ownership-attributed exposure or value, it must be a separately named derived measure with explicit inputs/formula/lineage; it must never overwrite `company_operating` facts.

## Serving

Workspace product routes:

- `GET /api/v1/portfolios`
- `GET /api/v1/portfolio-holdings`

The routes require `observations:read` and fail closed to the caller's exact workspace and fund-entitlement intersection. A fund-targeted look-through path is visible only when the relevant funds remain entitled.

`GET /api/v1/position-financials` also accepts optional `portfolioId`. This filter changes which canonical fund/holding statements are in scope; it never changes the statement values.

These portfolio routes are currently classified as workspace-product surfaces rather than the stable external integration API. Promote them into the external OpenAPI contract only when client portfolio creation/import/update semantics and compatibility requirements are finalized.

## Analytics guidance

Portfolio analytics should separate three concepts:

- **Company operating performance:** full source-reported company values, deduplicated/grouped by company when appropriate.
- **Holding exposure:** fund-specific holding facts such as ownership, cost, fair value, debt/security position and status.
- **Portfolio attribution:** the path showing why a fund/holding is in a given client portfolio.

Useful portfolio views include common-holding detection, exposure by fund/company/strategy/geography, fund-path drill-through, concentration, overlap matrices and portfolio-specific position financial filtering. Any aggregation across common holdings must define whether it is counting distinct companies, holding paths, invested funds or a separately governed exposure measure.
