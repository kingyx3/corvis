# Modules

One directory per bounded module (see `docs/architecture/MODULARITY.md`). Each module is made of up to five layers and nothing else; `tools/repo-checks/architecture/repository-layout.test.ts` enforces that.

| Layer | Holds | May import |
| --- | --- | --- |
| `domain/` | Pure types, ports and rules. No I/O, no React. | Other `domain/` files and `src/shared/domain/`. |
| `server/` | Use cases, repositories, HTTP helpers, workers and sweeps. Server only. | `domain/`, `adapters/`, `src/platform/`, `src/shared/`. |
| `adapters/` | Provider-specific or demo implementations of the module's ports. | `domain/`, `src/platform/`, `src/shared/`. |
| `ui/` | React views and client state. | `domain/`, `src/shared/`, `src/composition/`; never `server/`, `adapters/` or `src/platform/`. |
| `application/` | Client-side use cases, where a module has one. | `domain/`. |

The `domain/` and `ui/` rules are checked on every pull request by `tools/repo-checks/architecture/module-boundaries.test.ts` and on a schedule by the control loop (`CL-ARCH-001`, `CL-ARCH-002`).

Server and domain code use relative imports so `node --test` can run it without the `@/` alias loader; `src/app/` and `ui/` code may use `@/`.

| Module | Owns |
| --- | --- |
| `admin` | Feature flags and the administrator console forms. |
| `analytics` | Performance scorecard, position financials, client portfolio attribution, current snapshots and chart data. |
| `delivery` | Exports, export schedules, tenant data exports and webhooks. |
| `governance` | Data issues, retention, deletion requests, corrections, audit queries and control evidence. |
| `identity-access` | Tenants and invitations, service accounts, session policy, SCIM, OIDC and authorization. |
| `notifications` | Email notifications, categories and preferences. |
| `processing` | The staged document-processing pipeline, orchestration, retries and recovery. |
| `research` | Permissioned retrieval and answers with citations, and pins. |
| `review` | Review decisions, discussion threads, publication policy and reconciliation resolution. |
| `sources` | Uploads, source connections, connectors and OAuth. |
| `support` | In-app help and support requests. |
| `workspace` | Workspace summary and dashboard, display preferences, saved views and sector classification. |

Code that more than one module needs and that belongs to no capability goes in `src/platform/` (server) or `src/shared/` (client-safe), not in a module.
