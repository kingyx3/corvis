# Tools

Repository tooling. Nothing here ships in an application image.

| Directory | Purpose |
| --- | --- |
| `ci/` | Scripts called from `.github/workflows/` (release governance, Terraform state, trust-anchor and alerting guards, security acceptance). Keep workflow YAML thin and put logic here so it can be tested. |
| `dev/` | Developer and operator utilities run through `npm` scripts or by hand (changed-code coverage gate, demo-bundle check, control-evidence collection, customer implementation preflight). |
| `repo-checks/` | `node --test` suites that assert repository-wide policy: workflow and Terraform contracts, readiness catalogues, import boundaries and the directory layout itself. They run with `npm test`. |
| `convex-conformance/` | Isolated harness that checks database semantics against the upstream Convex backend. It has its own `package.json`. |

Scripts run from the repository root and import application code with relative paths (no `@/` alias).

Two TypeScript projects share one set of compiler options: `tsconfig.json` covers `src/` and is the one `next build` checks; `tsconfig.tools.json` covers `tools/`, `services/`, `e2e/`, `db/` and the root config files. `npm run typecheck` runs both, so tooling cannot break an application build and vice versa.
