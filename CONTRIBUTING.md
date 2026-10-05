# Contributing to Corvis

Thanks for helping. This repository is public: treat every committed byte and every Git-history version as permanently public. Never commit customer data, credentials, private keys, real secrets or confidential evidence. To report a vulnerability, follow [SECURITY.md](SECURITY.md), not a public issue.

## Set up

```bash
nvm use                      # Node version from .nvmrc
npm ci
cp .env.example .env.local   # enables demo mode; without it the app has no way to authenticate
npm run dev                  # http://localhost:3000
```

## Before you open a pull request

```bash
npm run verify               # lint, typecheck, unit tests with coverage gates, production build
npm run test:e2e             # Playwright journeys, accessibility and performance (starts the dev server itself; run `npx playwright install` once)
```

CI runs the same checks plus Terraform, container, database-acceptance and security jobs. A pull request is mergeable when they are green.

Two gates are stricter than most projects and worth knowing:

- **Changed-code coverage.** Every production `.ts` file you change in the unit-test scope needs 100% line, branch and function coverage. Pure moves and consistent single-identifier renames are exempt. See [docs/engineering/TESTING.md](docs/engineering/TESTING.md).
- **Repository layout.** `tools/repo-checks/architecture/` fails if a top-level directory, module layer or document is added without updating the documented layout, or if a domain or UI file imports across a layer boundary.

## Where code goes

The layout, the module layers (`domain/`, `server/`, `adapters/`, `ui/`) and the dependency rules are in [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) and [docs/architecture/MODULARITY.md](docs/architecture/MODULARITY.md). In short:

- A new capability belongs in the module that owns its data and rules. Group a layer into feature folders as it grows; the layout check fails above 35 files in one directory (tests included).
- Cross-cutting server code goes in `src/platform/`; client-safe shared code in `src/shared/`.
- Route handlers in `src/app/api/` stay thin: authenticate, validate, call a module's `server/` code, shape the response.
- Tests sit next to the code as `*.test.ts`. Tests that assert repository-wide policy go in `tools/repo-checks/`.

## Rules that are easy to break

- **Database migrations are immutable once merged.** The runner refuses checksum drift. Add a new numbered migration in `db/postgres/migrations/` instead of editing an old one.
- **Identity comes from a signed assertion or an OIDC bearer token, never from request headers.** Tests authenticate through `src/test-support/identity-assertion.ts`.
- **`CORVIS_DATABASE_DSN` is the only database binding.** Production requires a native `postgres://` or `postgresql://` DSN.
- **Pin third-party GitHub Actions to a full commit SHA** and keep the readable version in a comment.
- **Business definitions live in Confluence; technical implementation lives here.** See [docs/README.md](docs/README.md) for the authority rule, and link the governing Confluence page when a technical change affects a business requirement.

## Commits and pull requests

Write the subject in the imperative and explain why in the body. Keep a pull request to one concern, fill in the template, and say what you could not verify locally (for example container or Terraform jobs).
