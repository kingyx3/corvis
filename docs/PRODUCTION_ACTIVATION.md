# Corvis production activation

The repository contains production-oriented runtime and infrastructure foundations. A deployment is **not enterprise-ready merely because code is merged**. Production readiness requires live provider bindings plus evidence that controls actually operate.

This document owns the technical activation checks. Confluence owns the business/control decision to approve production readiness.

## Configuration source

Human-entered technical deployment inputs are configured in GitHub Environments (`dev`, `uat`, `prod`) and propagated by reviewed GitHub Actions wherever possible. Runtime secrets live in GCP Secret Manager; provider management credentials remain deployment-only GitHub secrets.

See [`GITHUB_ENVIRONMENTS.md`](GITHUB_ENVIRONMENTS.md) and [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Required production bindings

Production must reject demo mode and require working bindings for:

1. **Identity** — approved IdP / Identity Platform issuer/audience, cryptographically trusted identity path, joiner/mover/leaver process and Postgres-backed authorization/entitlement resolution. The current trusted-header compatibility path is not the desired final boundary.
2. **Supabase Postgres** — production Singapore project, approved schema/migrations/RLS/roles, tenant isolation tests and backup/recovery capability. Postgres is the structured application write authority.
3. **Google Cloud Storage** — private production source bucket, uniform access/public-access prevention, versioning/retention as required, exact-origin resumable upload behavior and workload identity.
4. **Cloudflare edge/origin** — authoritative DNS/proxy/TLS/WAF/rate controls, tenant-safe caching rules and direct-origin bypass protection.
5. **Malware gate** — approved scanner records clean/threat disposition; quarantined artifacts cannot enter canonical processing.
6. **Durable processing** — Pub/Sub/Cloud Tasks/worker consumers, retry/dead-letter/idempotency and replay paths are operating.
7. **Retrieval** — permissioned search path enforces tenant/workspace/document/fund authorization before returning source content.
8. **AI service** — approved model/service path obeys the fixed Corvis contract and treats source documents as untrusted data.
9. **Observability** — logs/metrics/traces, SLO alerts and owned operational dashboards are working.
10. **Data lifecycle** — retention/deletion execution reaches every in-scope authoritative/derived system and returns completion evidence.
11. **Export/webhook delivery** — governed asynchronous export delivery and signed webhook behavior are working where enabled.

Snowflake is **not** a production activation requirement unless the business architecture has separately approved and activated it as downstream analytics/sharing.

## Current readiness-endpoint limitation

`GET /api/v1/admin/readiness` is useful as a repository/runtime diagnostic but is **not yet the final production gate**. The current implementation still lives in the legacy Snowflake-oriented production platform and reports Snowflake health. Issue #28 must migrate readiness to the Postgres-primary platform and issue #13 must add production environment/provider checks before `productionReady`-style output can be treated as deployment evidence.

Do not enable external production traffic merely because the current endpoint returns configured states.

## Provider-side / UAT acceptance checks

The `uat` environment should exercise the production topology using synthetic or explicitly sanitized data before production promotion.

Required checks include:

- authentication for admin, reviewer, analyst and service identities;
- horizontal and vertical authorization tests across at least two isolated test tenants;
- Postgres RLS negative tests and service-role privilege tests;
- GCS resumable upload at representative/max configured size, interruption/resume, expired-session recovery and exact-origin behavior;
- duplicate initiate/complete tests proving idempotency does not duplicate document artifacts;
- benign and test-malware uploads proving quarantine blocks processing until clean disposition;
- GCS object generation/size/checksum lineage retained against the registered artifact;
- Pub/Sub/Tasks duplicate delivery, retry/dead-letter and replay tests;
- Cloudflare WAF/rate-limit/cache-isolation/TLS tests and direct-origin-bypass negative test;
- Postgres backup/restore exercise with recorded actual recovery evidence;
- search negative tests proving unauthorized document existence/snippets are not exposed;
- Ask Corvis evaluation covering deterministic numerical correctness, citations, prompt injection and insufficient-evidence behavior;
- webhook signature/replay/idempotency tests where webhooks are enabled;
- export renderer/checksum/manifest/expiry tests;
- deletion/retention execution test with legal/contractual hold behavior;
- rollback test using the previous known-good application image and compatible database state.

If Snowflake is activated, add initial-snapshot reconciliation, rights-filtered share tests, CDC lag/failure behavior and proof that Snowflake failure does not block Postgres/application writes.

## Release gate

A production release requires, at minimum:

- `npm ci`;
- ESLint;
- TypeScript;
- unit tests;
- production Next.js build;
- critical-path Playwright E2E;
- dependency vulnerability gate;
- CodeQL;
- Terraform formatting/validation for implemented roots;
- reviewed Postgres migrations;
- `uat` environment acceptance checks for the changed surfaces;
- reviewed production Terraform/database/application plan and exact image digest.

## Operating evidence

Evidence should come from normal operation and be retained against the Confluence enterprise control/evidence model. Repository/runtime foundations may generate technical evidence, but they do not replace provider/human/business evidence.

Minimum recurring evidence includes:

- access review;
- tenant-isolation/RLS test result;
- CI/security scan per release;
- successful backup/restore and DR exercise;
- SLO/incident records;
- vulnerability remediation evidence;
- extraction regression/gold-set result;
- lineage completeness sample;
- retention/deletion execution evidence;
- critical-vendor/subprocessor review;
- data-rights enforcement tests.

## What cannot be completed from source control alone

Some trust/account/operating facts require authorized external ownership or human execution:

- domain/provider account ownership and billing;
- one-time GCP GitHub-OIDC Workload Identity bootstrap;
- provider management-token creation;
- IdP tenant/policy ownership;
- penetration testing;
- backup/restore and incident exercises;
- customer contract/data-right records;
- recurring access/control review;
- final production-readiness approval.

These are deliberate external evidence/ownership gates. Everything else that providers safely expose through API/IaC should be driven from GitHub rather than maintained manually in multiple consoles.
