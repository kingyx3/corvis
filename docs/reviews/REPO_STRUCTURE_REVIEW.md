# Corvis repository structure review

Scope: directory layout, module boundaries, test/doc/ops placement. Read-only review; no code was moved.
Baseline: `02a319e` (1,142 tracked files). `node_modules` was not installed, so the Next.js 16 bundled docs (`node_modules/next/dist/docs/`) could not be consulted; framework-specific points below are marked **(verify)** and should be checked against those docs before acting.

## Implementation status

The recommendations below were implemented in one restructuring change. This review is kept as the record of the starting point and the reasoning; the current layout is in [`../architecture/ARCHITECTURE.md`](../architecture/ARCHITECTURE.md). Paths in sections 1 to 6 describe the repository before that change.

| Recommendation | Outcome |
| --- | --- |
| Step 0: test discovery globs | Done: `**/*.test.ts` replaces the hand-listed directories. |
| Step 1: move governance and misplaced tests | Done: 26 policy tests now live in `tools/repo-checks/`; adapter tests sit with their adapters; test helpers moved to `src/test-support/`. |
| Step 2: docs by kind | Done: `architecture/ features/ operations/ security/ engineering/ reviews/`; `tenant-self-service.md` became `TENANT_SELF_SERVICE.md`. |
| Step 3: deployables to `services/` | Done for `control-loop/`, `extractor/` and `litellm-gateway/` with their Dockerfiles. The Cloudflare Worker sources stay beside the Terraform that deploys them (`infra/terraform/modules/cloudflare-*`), because Terraform reads them with `file()` and that wiring cannot be validated without provider credentials. |
| Step 4: one home for scripts | Done: `tools/ci/` (was `.github/scripts/`) and `tools/dev/` (was `scripts/`). |
| Step 5/6: split `lib/server/` and fold `core/`, `features/`, `adapters/` into modules | Done: 12 modules under `src/modules/<module>/{domain,server,adapters,ui}`, plus `src/platform/` (grouped into `config/ data/ database/ gcp/ http/ observability/ runtime/ demo/`), `src/shared/` and `src/composition/`. `application/` became `modules/sources/application/`. |
| Step 7: `src/` | Done. Route groups were not introduced: URLs and layouts are unchanged and the admin and customer surfaces already share one root layout. |
| Step 8: enforced boundaries | Done at pull-request time: `tools/repo-checks/architecture/module-boundaries.test.ts` runs the `architecture-drift` scanner (`CL-ARCH-001/002`) over the whole tree, and `tools/repo-checks/architecture/repository-layout.test.ts` pins the directory layout, the module layers and the docs index. An ESLint import rule set is not added: server code uses relative imports, which lint patterns cannot express per layer. |
| Step 9: Convex harness | Moved to `tools/convex-conformance/`; kept, since its conformance workflow still runs. |
| `db/postgres/migrations` flattening, `contracts/openapi/` | Not done, deliberately: `db/postgres/` and `openapi/` are already clear, and moving them would churn every workflow and test that names them for no gain. |

Two things to know about the move itself. SQL migrations are immutable (the runner refuses checksum drift), so none were edited even where a comment mentions an old path. The changed-code coverage gate now treats a pure move as unchanged (see `docs/engineering/TESTING.md`); the coverage denominator was verified to be the same 224 files before and after.

### Second pass

A follow-up change took the layout to what is usual for a repository of this size:

| Area | Outcome |
| --- | --- |
| Directories over about 35 files | The server layers of `processing`, `sources`, `identity-access`, `delivery` and `governance`, and `src/platform/http`, are grouped into feature folders (for example `processing/server/{orchestration,stages,materialization,transport,recovery}`). Tests stay beside the code. |
| `e2e/` and `tools/repo-checks/` | Grouped by area (`journeys admin quality smoke`; `workflows infrastructure assurance architecture`). Playwright still lists the same 500 tests in 28 files. |
| Contributor-facing files | `.editorconfig`, `.gitattributes`, `CONTRIBUTING.md`, a pull request template and issue forms. |
| TypeScript projects | `tsconfig.json` covers `src/` (what `next build` checks); `tsconfig.tools.json` covers tooling, services, e2e and db. Together they cover the same 817 files as before. |
| Enforcement | The layout check now also fails when one directory under `src`, `tools`, `services` or `e2e` holds more than 35 files. |
| Left open on purpose | `CODEOWNERS` (needs named owners and changes merge rules), `LICENSE` (a legal decision for a repository that is public "for now"), and the Node version spread (`.nvmrc` and CI use 24, the images use 26, `engines` allows 22.18 and up). |

## 1. What the repo looks like today

| Dir | Files | Role |
| --- | ---: | --- |
| `lib/` | 432 | **386 files flat in `lib/server/`** + 42 client/shared helpers in `lib/` |
| `db/` | 156 | 100 SQL migrations, 48 DB acceptance tests, a Convex harness |
| `app/` | 137 | pages (14) + ~120 `route.ts` under `api/v1` |
| `core/` | 76 | 28 domain modules + 48 tests |
| `infra/` | 61 | Terraform modules/environments |
| `docs/` | 46 | flat, one level |
| `features/`, `components/`, `adapters/`, `control-loop/`, `e2e/`, `ops/`, `runtime/`, `application/`, `scripts/`, `openapi/` | 1–38 each | |

Root holds 20 directories, 3 Dockerfiles + 1 dockerignore variant, and 5 config/entry files (`proxy.ts`, `instrumentation-client.ts`, `next.config.ts`, `playwright.config.ts`, `eslint.config.mjs`).

## 2. What is already good (keep)

- **Documented, machine-enforced layering.** `docs/ARCHITECTURE.md` + `docs/MODULARITY.md` define dependency direction, and `control-loop/scanners/architecture-drift.ts` enforces `core/` and `features/` boundaries. I found **no** `core/` imports of adapters/runtime/lib/server, and `features/` only mentions `lib/server` in one comment (`features/admin/governance-forms.tsx:131`). The rules hold today.
- Thin `app/` pages delegating to `features/*-view.tsx`; route handlers live where Next expects them.
- Ports/adapters split (`core/` contracts, `adapters/`, `runtime/` wiring) with demo adapters isolated.
- Strong ops hygiene: sequentially numbered migrations, Terraform split into `modules/` + `environments/`, one OpenAPI source of truth, `.dockerignore`/gitignore secret patterns, `@/` alias used consistently (1,095 alias vs 368 relative imports).
- Docs authority model (Confluence = business truth, GitHub = technical truth) is explicit.

## 3. Problems, ranked by payoff

### P1: `lib/server/` is a 386-file flat directory
Filename prefixes show the domains hiding inside it: `processing-*` (18 files), `source-*` (14), `tenant-*` (11), `export-*` (8), `data-*` (7), `service-account-*` (6), `upload*` (5), `orchestration-*` (4), `postgres*` (4), `performance-scorecard*` (4), plus `review-*`, `research-*`, `webhook*`, `session-*`, etc. Prefix-as-namespace is the classic sign that directories are missing. Consequences: poor discoverability, no ownership boundaries, no way to enforce intra-server module rules, huge diffs/merge conflicts, and the "bounded modules" in `docs/MODULARITY.md` have no physical home. 234 of the files are colocated `.test.ts` files, so the real source count is ~150.

### P2: Domain code is split three ways with no shared module key
One capability (say service accounts) lives in `core/service-account.ts`, `lib/server/service-account-*.ts` (6 files), `features/access/service-accounts-*.tsx`, `app/api/v1/access/service-accounts/**`, `adapters/demo/service-account-store.ts`, `db/postgres/migrations/*`, and `docs/SERVICE_ACCOUNTS.md`. This is a *layer-first* layout that has grown past the point where layers pay off. `features/` already shows the better pattern (feature-first), but only for UI.

### P3: `core/` is not only domain contracts
~15 of its 48 tests are repo/CI/infra governance checks, not domain tests: `github-actions-bootstrap`, `github-actions-supply-chain`, `release-deploy-guards`, `build-once-promotion-contract`, `promotion-orchestration`, `verify-gcp-trust-anchor`, `assert-no-runtime-destroy`, `edge-worker-cache-headers`, `soc1-readiness`, `pre-uat-readiness`, `assurance-readiness-contract`, `application-slo-telemetry`, `health-route`, `*-runtime-boundary`, `browser-storage-boundary`. They make `core/` look like a grab bag and obscure the "pure domain" claim in `ARCHITECTURE.md`.

### P4: Misplaced tests and test infrastructure
- `lib/http-delivery.test.ts` and `lib/http-workspace.test.ts` test `adapters/*` code.
- Test helpers live in `lib/server/test-support/` but are used repo-wide (alias loader, OpenAPI support, zip reader).
- Zero tests for `features/`, `components/`, `app/` outside Playwright (e2e is the only UI safety net; may be a deliberate choice, but it is undocumented).
- `package.json` `test` and `test:unit` hand-maintain five glob lists (`core/*.test.ts lib/*.test.ts lib/server/*.test.ts ...`) and the coverage include list. Any new directory with tests is silently not run unless someone edits a 1,000-character script. Moving to subfolders would break these globs unnoticed.
- `db/postgres/tests/` mixes `.sql` and `.mjs` acceptance tests (48 files) with no naming link to the migrations they cover.

### P5: Root clutter and unclear ownership
- Three Dockerfiles at root (`Dockerfile`, `Dockerfile.control-loop`, `Dockerfile.extractor`) plus `Dockerfile.control-loop.dockerignore`. `ops/litellm/Dockerfile` already lives under `ops/`, so the convention is inconsistent.
- `ops/extractor/server.mjs` and `ops/litellm/entrypoint.py` are *deployable services*, not operations docs. `ops/` mixes runbooks, SOC control JSON, UAT plans, and runnable code.
- `infra/terraform/modules/cloudflare-*/…-proxy.mjs` embed Worker source in Terraform modules (fine, but untested/unlinted from the TS toolchain; **verify** they are covered).
- `.github/scripts/` (9 scripts, mixed `.sh`/`.mjs`) vs top-level `scripts/` (4 scripts): two script homes with no stated rule.
- `db/convex-conformance/` is a second-database harness with its own `package.json`, excluded from tsconfig and eslint, sitting inside `db/` next to the real Postgres tree. It's special-cased in three config files.
- `application/` contains a single file (`upload-document.ts`) next to a 386-file `lib/server/`; use cases are actually in `lib/server/*-service.ts`. The `application/` layer exists on paper only.
- `runtime/` (wiring) vs `lib/server/runtime-surface.ts`, `platform.ts`, `platform-repositories.ts` is ambiguous about where composition lives.

### P6: Docs sprawl
46 flat files in `docs/`, mixed casing (`tenant-self-service.md` vs `SERVICE_ACCOUNTS.md`), a dated point-in-time review (`REVIEW_2026_09_30.md`) sitting beside living reference docs, and `docs/README.md` index mixes ordered sections and an appended unsorted tail. Contributors can't tell architecture vs runbook vs readiness vs decision record.

### P7: README target-state is fictional
`README.md` shows a `apps/ services/ packages/` target tree that "does not exist yet". It's honest about that, but it's now the *only* statement of intent, and it conflicts with how the code is actually evolving (a single Next app plus workers). The recommendation below replaces it with an achievable target.

### P8: Framework conventions to verify against the Next 16 docs
- **(verify)** No `src/` directory; app code and config share the root with ops/infra. Next supports `src/` to separate them. Not required, but it is the main lever for root decluttering.
- **(verify)** No route groups (`app/(workspace)`, `app/(admin)`) or private folders (`_components`) in use. Admin pages and customer pages are siblings.
- `proxy.ts` (renamed from `middleware.ts` in this Next generation) is correctly at root/`src` level.
- ~120 `route.ts` files each hold a thin adapter; good. Several have deep parameterized nesting (`app/api/v1/review-items/[subjectKind]/[subjectId]/comments/route.ts`), which is fine, but there is no shared route-composition helper directory documented.

## 4. Best practices applied to Corvis

1. **Group by domain first, layer second** (feature-sliced / modular monolith). The repo already declares bounded modules; mirror them in directories.
2. **One directory = one reason to change.** Prefix families become folders.
3. **Colocate tests with code; keep cross-cutting test infra in one `testing/` home.**
4. **Make boundaries lintable.** Today only two rules exist, enforced by a custom scanner. Add `eslint-plugin-boundaries` / `no-restricted-imports` zones (or `dependency-cruiser`) per module so folders aren't merely cosmetic.
5. **Barrel files only at module public APIs** (`index.ts` exposing ports), never inside Next route trees (hurts tree-shaking and server/client separation).
6. **Separate deployables from docs.** `services/` (code that runs) vs `ops/` (how humans operate it).
7. **Docs by type** (architecture / runbooks / decisions / compliance), lower-case or consistent naming, dated reviews under `reviews/`.
8. **Test globs discover; they are not enumerated.** `node --test "**/*.test.ts"` with an ignore list.
9. **Keep `server-only` explicit** (`import "server-only"` or a `server/` boundary) so client bundles can't pull Postgres code. **(verify)** against Next docs.

## 5. Recommended target structure

Keeps the single deployable Next app (no premature `apps/`+`packages/` split, which the README promised but nothing needs), while giving every domain a home.

```text
corvis/
├─ src/                                 # all application code (Next supports src/) (verify)
│  ├─ app/                              # routing only: thin pages + route.ts
│  │  ├─ (customer)/…                   # route groups: customer workspace vs admin
│  │  ├─ (admin)/admin/…
│  │  └─ api/{v1,internal}/…
│  ├─ proxy.ts, instrumentation-client.ts
│  ├─ modules/                          # ← the bounded modules from MODULARITY.md
│  │  ├─ source-acquisition/            #   uploads, connectors, oauth
│  │  │  ├─ domain/                     #   ← today's core/source-*.ts
│  │  │  ├─ application/                #   ← use cases (today's *-service.ts, application/)
│  │  │  ├─ infrastructure/             #   ← postgres repos + adapters/* for this module
│  │  │  ├─ ui/                         #   ← features/documents
│  │  │  ├─ http/                       #   ← *-http.ts helpers used by route.ts
│  │  │  └─ index.ts                    #   public surface only
│  │  ├─ processing/                    #   18 processing-* files, orchestration-*
│  │  ├─ review/  canonical-data/  publication/  research/
│  │  ├─ delivery/                      #   exports, schedules, webhooks
│  │  ├─ identity-access/               #   tenant-*, service-account-*, session-*, scim, oidc
│  │  ├─ governance/                    #   data-issues, retention, deletion, control-evidence
│  │  └─ admin/                         #   feature-flags, readiness, support access
│  ├─ platform/                         # cross-cutting server infra only
│  │  ├─ config/  database/  http/  telemetry/  rate-limit/  idempotency/  gcp/
│  ├─ composition/                      # ← runtime/ (the one place that wires ports→adapters)
│  ├─ shared/                           # ← lib/*.ts client-safe helpers + components/ui
│  │  ├─ ui/  format/  csv/  storage/
│  └─ testing/                          # ← lib/server/test-support (alias loader, fixtures)
├─ db/
│  ├─ migrations/                       # ← postgres/migrations
│  ├─ tests/                            # ← postgres/tests
│  └─ migrate.ts
├─ contracts/openapi/                   # ← openapi/ (+ baseline/classification JSON)
├─ services/                            # code that RUNS outside the Next app
│  ├─ extractor/   (Dockerfile, server.mjs)          ← ops/extractor + Dockerfile.extractor
│  ├─ litellm-gateway/                                ← ops/litellm
│  ├─ control-loop/ (Dockerfile, *.ts)                ← control-loop/ + Dockerfile.control-loop
│  └─ edge-workers/  (api, admin, customer proxies)   ← infra/terraform/modules/cloudflare-*/*.mjs
├─ infra/terraform/{modules,environments,shared}/    # unchanged, minus embedded JS
├─ ops/                                 # humans only: runbooks, SLOs, SOC control JSON, UAT plans
├─ tools/                               # ← scripts/ + .github/scripts/ (workflows call tools/ci/…)
│  ├─ ci/  repo-checks/                 #   incl. the ~15 governance tests now in core/
│  └─ dev/
├─ e2e/                                 # unchanged, add per-module subfolders over time
├─ docs/
│  ├─ architecture/  decisions/  runbooks/  compliance/  reviews/  guides/
│  └─ README.md                         # generated or checked index
├─ Dockerfile                           # keep the main app image at root (build-context convention)
└─ README.md, SECURITY.md, AGENTS.md, CLAUDE.md, package.json, tsconfig.json, next.config.ts, …
```

Notes on the choices:

- **Inside a module, `domain/ application/ infrastructure/ ui/ http/` are optional.** Start flat (`modules/processing/*.ts`) and add subfolders only when a module passes ~15 files. Do not create empty ceremony folders.
- `adapters/demo/*` move *into* the module whose port they implement (`modules/identity-access/infrastructure/demo-service-account-store.ts`), so demo-only code stays greppable per module, and `check-bundle-demo-free` keeps working off a single `*/demo-*` convention.
- `core/` disappears as a top-level concept: pure domain types move to `modules/*/domain`, and genuinely shared kernel types (workspace, contracts, notifications) go in `modules/_kernel/` or `shared/domain/`.
- Keep the app Dockerfile at root (default build context); move the other two with their service.

### Boundary rules to enforce after the move
1. `modules/*/domain` imports nothing outside itself or `shared/domain`.
2. `modules/*/ui` may not import `platform/`, `*/infrastructure`, `pg`, or `lib/server`-style code.
3. A module may import another module only via its `index.ts`.
4. `app/**` imports `modules/*` public APIs and `composition/` only.
5. Only `composition/` imports `infrastructure` across module boundaries.

## 6. Low-risk migration plan

Why staged: moving files changes ~1,450 import specifiers, 23 non-TS references to `lib/server/` (workflows, docs, Dockerfiles, scanner rules), 69 test files containing path strings, the `@/` loader, the hand-written coverage globs and the control-loop `MODULE_BOUNDARIES` prefixes. Do it mechanically, one slice per PR, with `npm run verify` green at each step.

| Step | Change | Risk | Payoff |
| --- | --- | --- | --- |
| 0 | Replace enumerated test globs in `package.json` with a discovery glob (`**/*.test.ts`, minus `node_modules`, `.next`, `e2e`); same for coverage includes. Add this *before* moving anything. | Low | Prevents silent test loss during every later step |
| 1 | Move 15 governance tests from `core/` → `tools/repo-checks/` (or `ops/checks/`); move `lib/http-*.test.ts` → `adapters/`; move `lib/server/test-support` → `testing/`. | Low | Cleans `core/`, fixes misplaced tests |
| 2 | Docs: create `docs/{architecture,decisions,runbooks,compliance,reviews}`, rename `tenant-self-service.md`, move `REVIEW_2026_09_30.md`, regenerate index; leave redirect stubs or update links (control-loop `internal-links` scanner will tell you what broke). | Low | Fast, visible win |
| 3 | Move deployables: `ops/extractor`+Dockerfile, `ops/litellm`, edge-worker `.mjs` → `services/`; update workflow `paths:` and Dockerfile `COPY`. | Medium (CI paths) | Clear "code vs ops" split |
| 4 | Consolidate scripts: `.github/scripts` + `scripts` → `tools/`; workflows reference new paths. | Low-Medium | One home for tooling |
| 5 | **Split `lib/server/` by prefix into `modules/<domain>/`** using an automated codemod (`git mv` + rewrite `@/lib/server/x` specifiers; `ts-morph` or `jscodeshift`). Do one domain per PR, `processing` first (largest, most cohesive). Update `MODULE_BOUNDARIES` as each lands. | Medium | The main structural prize |
| 6 | Fold `core/*` and `features/*` and matching `adapters/*` into the same modules; retire `application/`. | Medium | Full domain-first layout |
| 7 | Introduce `src/` and route groups. **(verify)** against Next 16 docs for `proxy.ts`, `instrumentation-client.ts` and `tsconfig` `paths` placement. | Medium | Root declutter |
| 8 | Add lint-enforced boundaries (`eslint-plugin-boundaries` or `dependency-cruiser`); keep `architecture-drift` scanner as a backstop or retire it. | Low | Makes the layout durable |
| 9 | Decide Convex harness fate: move to `tools/convex-conformance/` or delete if `docs/CONVEX_CONFORMANCE.md` no longer reflects a live requirement (a conformance workflow still exists, so confirm with owners first). | Low | Removes tsconfig/eslint special cases |
| 10 | Rewrite the README "Repository ownership" block to describe the actual target above instead of `apps/ services/ packages/`. | Low | Removes a misleading doc |

If only three things get done, do **Step 0, Step 5 for `processing/` and `source/`, and Step 1**: they remove the biggest pain (flat 386-file dir, misplaced tests, fragile globs) with the smallest blast radius.

## 7. Things I did not verify

- Next.js 16 conventions (needs `npm ci` to read `node_modules/next/dist/docs/`), as flagged above.
- Whether workflows use `paths:` filters tied to current directories (affects Steps 3–4); `ci.yml` showed none, others unchecked.
- Runtime behavior: nothing was built or tested; this is a static layout review.
- Import-cycle analysis between `lib/server` files; a `dependency-cruiser` run would size Step 5 more accurately before starting.
