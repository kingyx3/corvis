# Production Deployment & Change Control

## Environments
Corvis uses isolated `development`, `staging` and `production` environments. Production customer data must never be copied into lower environments. Staging exercises the same authentication, tenant-role, upload, scanner, Snowflake serving and retrieval contracts using synthetic/non-production data.

## Required production configuration
`CORVIS_ENV=production` and `CORVIS_DEMO_MODE=false` are mandatory. Production configuration fails closed when OIDC, Snowflake, object-store, scanner, worker or SCIM credentials are missing. `NEXT_PUBLIC_CORVIS_MOCK_API=true` is rejected by the browser composition root in production.

## Release gate
A release candidate must pass:
1. deterministic dependency install from `package-lock.json`;
2. policy lint and TypeScript typecheck;
3. unit/enterprise-invariant tests;
4. secret scan;
5. enterprise-readiness assertions;
6. production build;
7. Playwright critical-flow and accessibility tests;
8. CodeQL / dependency scanning;
9. infrastructure format/validate for changed IaC;
10. migration review for Snowflake changes.

Production deployment requires an immutable commit SHA and records environment, commit, build/run IDs and migration version. Risky features must have a tenant-aware kill switch or a rollback path before activation.

## Snowflake migration order
Apply files in `snowflake/migrations/` in lexical order with the platform service role. Create tenant roles from `snowflake/onboard_tenant_template.sql` before granting customer access. Do not grant customer/application roles broad access to unrestricted base facts; normal customer reads use `PM_SERVING` and row-access policies.

## Rollback
- Frontend/API: redeploy the previous verified image/commit.
- Schema: prefer forward-fix migrations. Do not destructive-roll back data without an explicit recovery plan.
- Model/search: disable via feature flag and revert semantic/search configuration; indexes are rebuildable.
- Upload/processing: stop new leases, preserve durable jobs, then resume/replay after correction.

## Feature flags
Flags are tenant-scoped and default-deny for risky capabilities. A global emergency disable takes precedence. Flag changes are administrative actions and must be audited. Do not use frontend-only flags for security authorization.

## Secrets
Secrets are injected from the deployment platform/secret manager. Never store production secrets in GitHub variables visible to pull-request code. Rotate credentials after suspected exposure, administrator departure, or per organization policy.

## Release evidence
Retain CI checks, CodeQL status, deployment record, migration output, configuration version/hash and any release-specific risk acceptance. A green build is necessary but not sufficient evidence that live SLO, backup or authorization controls are operating.
