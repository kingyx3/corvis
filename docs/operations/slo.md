# Service Level Objectives

These are engineering objectives, not contractual SLA commitments. Customer contracts may set different targets and must not be represented as met until production telemetry exists.

| Signal | Baseline objective | Measurement |
| --- | --- | --- |
| Workspace/API availability | 99.9% monthly | successful non-user-error requests / eligible requests |
| P95 read API latency | < 1.5 s excluding AI research | server request telemetry |
| Upload control-plane availability | 99.9% monthly | initiate/part-sign/complete control requests |
| Document pipeline completion | 99% of accepted standard jobs within configured reporting-cycle window | durable job lifecycle timestamps |
| Publication freshness | 95% approved snapshots served within 15 minutes | review approval → serving timestamp |
| Ask Corvis evidence safety | 100% citations resolve to entitled evidence in regression suite | retrieval/entitlement evaluation |
| Cross-tenant access | 0 tolerated | automated authorization tests + incident monitoring |
| Restore | RPO/RTO within documented tier target | quarterly restore exercise |

## Required telemetry
Every API request carries `x-request-id`; downstream jobs preserve correlation identifiers. Logs must be structured and tenant-safe. Do not log source document text, access tokens, signed URLs or model prompts containing customer source excerpts by default.

Metrics should cover request throughput/latency/errors, upload state, job queue depth/age/attempts, scanner failures, review backlog, publication lag, Snowflake query failures, retrieval latency/results, model usage/cost, export delivery and customer-data deletion workflow status.

## Alerts
- SEV1 candidate: cross-tenant authorization test or runtime guard failure, source read without entitlement, or integrity alert on immutable artifact.
- SEV2 candidate: sustained API error budget burn, oldest critical job beyond processing objective, publication pipeline blocked broadly, restore/backup control failure.
- SEV3: elevated latency/error rate with workaround or isolated processing backlog.

Alert definitions must be deployed in the chosen observability platform and test-fired before production readiness evidence is complete.

## Error budgets
Product releases that materially consume an SLO error budget should prioritize reliability work. Security/tenant-isolation failures do not receive an error budget; they are control failures.
