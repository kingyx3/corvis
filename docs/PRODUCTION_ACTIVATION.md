# Corvis production activation

The repository contains production runtime contracts and partial production adapters. A deployment is **not enterprise-ready merely because code is merged**. Production readiness requires live provider bindings plus evidence that the controls operate.

## Fail-closed activation gate

Production startup requires all of the following and rejects demo mode:

1. **Identity gateway** — OIDC/SAML issuer/audience, MFA policy upstream, trusted auth-proxy secret, header stripping/injection rules, joiner/mover/leaver process. Direct Identity Platform verification/control-plane authorization remains required before final launch.
2. **Snowflake** — AWS Singapore account, OAuth SQL API access, database/warehouse/role, approved migrations applied, tenant policies populated and isolation tests passed. Hybrid Table control-plane state must be benchmarked/activated where required by the architecture.
3. **Google Cloud Storage** — private GCS bucket in the approved GCP environment, uniform access/public-access prevention, versioning/retention as required, exact-origin CORS for browser resumable uploads, Cloud Run workload identity and GCS→Snowflake integration.
4. **Malware gate** — approved scanner writes the configured clean/threat custom object metadata. Uploaded artifacts remain quarantined until the clean disposition is observed.
5. **Retrieval** — permissioned search endpoint enforces tenant/workspace/document/fund filters before returning chunks/source references.
6. **AI answer service** — trusted-data endpoint accepts only the fixed Corvis contract; documents are data, not tool instructions.
7. **Observability** — structured telemetry collector is configured, alerts and SLO dashboards are owned.
8. **Data lifecycle adapter** — retention/deletion executor can purge or tombstone the target systems in scope and returns completion evidence.
9. **Export delivery adapter** — asynchronous export renderer/delivery service produces the requested format, checksum, governed object URI and expiry.
10. **Worker authentication / webhooks** — internal delivery worker secret and outbound webhook signing secret are managed and rotated.

`GET /api/v1/admin/readiness` actively checks Snowflake and GCS plus configuration state. It must report `productionReady: true` in the deployed environment before external production traffic is enabled.

## Required provider-side checks

- SSO/MFA authentication test for admin, reviewer, analyst and API/service-account identities.
- Horizontal and vertical authorization tests across at least two isolated test tenants.
- GCS resumable upload at the configured maximum, interruption/resume/status-query test, expired-session recovery and exact-origin CORS validation.
- Duplicate initiate/complete validation proving idempotency does not create duplicate document artifacts.
- Benign and test-malware upload validation proving quarantine blocks the processing event until scan disposition.
- GCS object generation, size and checksum metadata are retained against the registered source artifact.
- Snowflake tenant row-policy negative tests using customer-serving roles.
- Restore test with recorded RPO/RTO evidence.
- Search negative tests proving unauthorized document existence/snippets are not revealed.
- AI evaluation covering numerical correctness, citations, prompt injection and unsupported-question refusal.
- Webhook signature/replay/idempotency test.
- Customer export renderer/checksum/manifest/expiry validation.
- Data-lifecycle execution test proving a deletion request yields retained completion evidence without bypassing legal/contractual holds.

## Release gate

A production release requires:

- `npm ci`
- ESLint with zero warnings
- TypeScript
- unit tests
- production Next.js build
- Playwright critical-path E2E tests
- high/critical dependency audit
- CodeQL
- Terraform formatting/validation for every implemented Terraform root
- reviewed database migrations

## Operating evidence

Evidence should be generated from normal operation and retained against the Confluence Enterprise Control Register. The admin control-evidence API snapshots runtime state into `PM_CONTROL.CONTROL_EVIDENCE`; this complements, rather than replaces, human/provider evidence. Minimum evidence includes:

- quarterly access review;
- tenant-isolation test result;
- CI/security scan result per release;
- successful backup/restore and DR exercise;
- SLO/incident records;
- vulnerability remediation report;
- extraction regression/gold-set result;
- lineage completeness sample;
- data-retention/deletion execution evidence;
- vendor/subprocessor review;
- data-rights enforcement tests.

## What cannot be completed from source control alone

Provider account creation, DNS, production secrets, identity-provider policy, GCS bucket/CORS policy, Snowflake grants, malware-scanner activation, backup/restore exercises, penetration tests, customer contract/data-right records and recurring access/control reviews require authorized production accounts and human ownership. The application therefore reports these as activation/evidence gates rather than pretending code presence is proof of operation.
