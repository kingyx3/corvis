# Testing and escaped-defect prevention

GitHub is the technical source of truth for Corvis test execution, coverage gates, regression contracts and CI behavior. Confluence defines the business-level reliability/change-management requirement; this document defines how the repository enforces it.

## Required CI model

A pull request is not merge-ready until the repository's required quality, build, browser, database/security, infrastructure and container checks pass. `npm test` is part of the required `quality` job.

The unit-test coverage scope is the executable TypeScript under:

- `core/`
- `lib/`
- `services/control-loop/`
- `adapters/upload/`

Test files and `test-support` infrastructure are excluded from numerical production coverage. Production exclusions must not be added merely to make a percentage pass.

## Coverage contract

Coverage has two complementary gates:

1. **100% changed-code coverage.** Every changed executable production `.ts` file in the unit scope must have 100% line, branch and function coverage. `tools/dev/check-changed-coverage.mjs` reads Node's LCOV output and compares it with the pull-request base. A changed production file that is absent from LCOV fails the gate, so new code cannot disappear from the coverage denominator simply because no test loaded it.
2. **Whole-repository ratchet.** The existing unit-testable codebase had legacy coverage debt when this policy was introduced. The measured floor is 92.82% lines, 82.03% branches and 89.35% functions. `npm test` fails below those thresholds, so coverage cannot regress while subsequent changes drive the floor upward toward 100%.

The target is 100% whole-repository coverage. Until that legacy target is reached, Corvis must not describe the repository as globally 100% covered. A changed file can still merge only at 100/100/100.

## Coverage-denominator integrity

Node's native runtime coverage can omit production modules that no executed test loads. Corvis therefore treats denominator integrity as a forward-enforced contract: every changed production file in the numerical unit scope must appear in the LCOV report and satisfy 100% line, branch and function coverage. This prevents newly introduced or modified code from becoming invisible to coverage.

Legacy modules that pre-date this contract are part of the whole-repository coverage debt and must be brought under execution as that ratchet moves toward 100%. Do not add blanket source exclusions, coverage-ignore directives or synthetic no-op imports to conceal those gaps; add meaningful tests at the appropriate unit, integration or browser layer.

## Escaped-defect rule

Treat an escaped defect as a defect in the testing/control system as well as in the implementation. A fix should include, where applicable:

1. a regression test at the lowest useful layer;
2. an integration or browser test for the real user-visible failure mode;
3. an executable architectural invariant when the root cause was a boundary/policy violation; and
4. a CI gate that makes recurrence fail before merge.

Do not rely on a single percentage to prove correctness. Coverage proves execution, not semantic correctness, browser compatibility, security, accessibility or tenant isolation.

## Browser storage invariant

Web Storage is best-effort browser state and may throw when site data is blocked, storage is unavailable or privacy/quota controls intervene. Production code must access `localStorage` and `sessionStorage` only through `lib/safe-storage.ts`.

`core/browser-storage-boundary.test.ts` scans production browser code and fails on a direct Web Storage bypass. Workspace-context tests cover server rendering, malformed/incomplete state, blocked storage and per-page context pinning. Playwright retains end-to-end coverage for blocked browser storage on real customer/admin surfaces.

This combination would have surfaced the failure class fixed in PR #301 before merge.

## Browser and system behavior

Numerical unit coverage does not replace behavioral gates. The existing CI matrix remains authoritative for production build/CSP, Chromium, WebKit, mobile Chromium, accessibility, non-demo behavior, Postgres/RLS/security acceptance, Terraform validation, container runtime checks and vulnerability scanning.

## Raising the whole-repository floor

When tests raise the measured global line, branch or function percentage, update the corresponding `npm test` threshold in `package.json` in the same pull request. Thresholds may move upward only. A reduction requires an explicit documented engineering exception and must not be used to compensate for missing regression coverage.
