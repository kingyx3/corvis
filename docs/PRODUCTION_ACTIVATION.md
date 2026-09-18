# Corvis production activation

The repository contains the production runtime contracts and reference adapters. A deployment is **not enterprise-ready merely because this code is merged**. Production readiness requires live provider bindings plus evidence that the controls operate.

## Fail-closed activation gate

Production startup requires all of the following and rejects demo mode:

1. **Identity gateway** — OIDC/SAML issuer/audience, MFA policy upstream, trusted auth-proxy secret, header stripping/injection rules, joiner/mover/leaver process.
2. **Snowflake** — OAuth SQL API access, database/warehouse/role, migrations 001–003 applied, tenant-role grants populated, row-policy isolation tests passed.
3. **Object store** — private versioned S3/S3-compatible bucket, KMS encryption, CORS restricted to exact app origins, workload credentials, incomplete multipart cleanup.
4. **Malware gate** — approved scanner writes the configured clean/threat tag. Uploaded artifacts remain quarantined until the clean tag is observed.
5. **Retrieval** — permissioned search endpoint enforces tenant/workspace/document/fund filters before returning chunks/source references.
6. **AI answer service** — trusted-data endpoint accepts only the fixed Corvis contract; documents are data, not tool instructions.
7. **Observability** — structured telemetry collector is configured, alerts and service dashboards are owned.
8. **Webhooks** — signing secret is managed and rotated if outbound subscriptions are enabled.

`GET /api/v1/admin/readiness` actively checks Snowflake and S3 plus configuration state. It must report `productionReady: true` in the deployed environment before external production traffic is enabled.

## Required provider-side checks

- SSO/MFA authentication test for admin, reviewer, analyst and API/service-account identities.
- Horizontal and vertical authorization tests across at least two isolated test tenants.
- S3 multipart upload >5 GB test plan (or configured maximum), interruption/resume test and ETag CORS verification.
- Benign and test-malware upload validation proving quarantine blocks the processing event until scan disposition.
- Snowflake tenant row-policy negative tests using customer-serving roles.
- Restore test with recorded RPO/RTO evidence.
- Search negative tests proving unauthorized document existence/snippets are not revealed.
- AI evaluation covering numerical correctness, citations, prompt injection and unsupported-question refusal.
- Webhook signature/replay/idempotency test if enabled.
- Customer export checksum/manifest validation.

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
- Terraform formatting/validation for the reference infrastructure
- reviewed database migrations

## Operating evidence

Evidence should be generated from normal operation and retained against the Confluence Enterprise Control Register. Minimum evidence includes:

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

Provider account creation, DNS, production secrets, identity-provider policy, Snowflake grants, malware-scanner activation, backup/restore exercises, penetration tests, customer contract/data-right records and recurring access/control reviews require authorized production accounts and human ownership. The application therefore reports these as activation/evidence gates rather than pretending code presence is proof of operation.
