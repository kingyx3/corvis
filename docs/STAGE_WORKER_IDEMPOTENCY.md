# Processing stage worker idempotency contract

Corvis document-stage workers consume durable deliveries through the Postgres stage boundary. A worker must not execute business side effects directly from a transport callback without first acquiring the authoritative stage claim.

For each claimed job/stage/document tuple, the worker derives one deterministic effect key. The same key is reused for every redelivery of that logical stage operation. Stage handlers must pass that key to any downstream write/provider that supports idempotency and must use it as the natural dedupe key for Corvis-owned persistence.

The Postgres `processing_stage_effect` journal records whether the logical effect is only started or already complete. If a delivery is redelivered after the effect was recorded complete, the handler is skipped and the worker only completes the authoritative stage transition. If a process crashes after a downstream write but before the effect journal is marked complete, the handler may be invoked again, but it receives the identical idempotency key and therefore must not create a second logical side effect.

The worker requires an authoritative `service_account` identity whose tenant matches the delivery and whose document entitlement includes the target document. Transport authentication (for example Pub/Sub push or Cloud Tasks OIDC) must resolve to that service identity before invoking the worker runner.

Stage success/failure remains authoritative in Postgres. The worker delegates completion, retry scheduling and dead-letter transitions to the atomic stage repository; application code must not independently recompute retry timing or emit duplicate downstream stage events.
