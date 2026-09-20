# Processing stage worker idempotency contract

Corvis document-stage workers consume durable deliveries through the Postgres stage boundary. A worker must not execute business side effects directly from a transport callback without first acquiring the authoritative stage claim.

For each claimed job/stage/document tuple, the worker derives one deterministic effect key. The same key is reused for every redelivery of that logical stage operation. Stage handlers must pass that key to any downstream write/provider that supports idempotency and must use it as the natural dedupe key for Corvis-owned persistence.

The Postgres `processing_stage_effect` journal records whether the logical effect is only started or already complete. If a delivery is redelivered after the effect was recorded complete, the handler is skipped and the worker only completes the authoritative stage transition. If a process crashes after a downstream write but before the effect journal is marked complete, the handler may be invoked again, but it receives the identical idempotency key and therefore must not create a second logical side effect.

The worker requires an authoritative `service_account` identity whose tenant matches the delivery and whose document entitlement includes the target document. Transport authentication (for example Pub/Sub push or Cloud Tasks OIDC) must resolve to that service identity before invoking the worker runner.

Stage success/failure remains authoritative in Postgres. The worker delegates completion, retry scheduling and dead-letter transitions to the atomic stage repository; application code must not independently recompute retry timing or emit duplicate downstream stage events.

## Authenticated production ingress

`POST /api/internal/processing-stage` is the application ingress for approved Pub/Sub push and Cloud Tasks HTTP delivery. Both transports use the same `ProcessingStageDelivery` contract: Cloud Tasks posts it directly, while Pub/Sub wraps the same JSON in the standard base64 `message.data` envelope.

The ingress verifies the Google-issued RS256 OIDC token against Google's signing keys, requires the exact configured worker URL as audience, and requires the exact configured worker service-account email. The Google OIDC `sub` claim is the immutable service-account subject that must be provisioned in `corvis_control.identity_subject`; transport claims never supply application roles, workspace membership or document entitlements.

After token verification, Corvis enumerates the subject's active workspace mappings and re-resolves each candidate through the existing Postgres membership/data-right/service-identity authorization repository. The target document must resolve to exactly one authorized workspace. Missing, expired, overdue-review, revoked, cross-tenant, unentitled or ambiguous identities fail closed before the durable stage claim.

The direct and Pub/Sub forms are body-size bounded and validate the complete delivery shape plus the deterministic payload SHA-256 before worker execution. A busy durable inbox/job claim returns a retryable HTTP response so Pub/Sub or Cloud Tasks does not acknowledge away the only remaining delivery while another lease is still in flight. Completed, duplicate, retryable-stage and terminal dead-letter outcomes are acknowledged because their authoritative next action is already persisted in Postgres/outbox state.

## Production effect routing

`BoundedProcessingStageEffectRouter` is the provider-neutral composition boundary for production stage effects. Each processing stage receives its own injected handler rather than a shared provider-specific switch or platform service. Missing handlers fail closed. Each handler receives the worker-generated deterministic idempotency key unchanged plus an `AbortSignal` with a hard execution timeout; provider adapters must propagate that signal where supported and must define their own narrower timeout when appropriate.

A timeout/failure in one stage is returned through the existing Postgres retry/dead-letter transition. It does not invoke another stage and must not widen authorization, skip lineage/review/publication gates, or mark the effect complete. This keeps extraction, canonicalization, reconciliation and publication independently replaceable and fault-testable while real provider-specific handlers are added incrementally under issue #79.

Every `ProcessingStageReady` event also carries the committed `predecessorResult` from the prior stage's effect journal. The event contains stable lineage identifiers and hashes, not source bytes or confidential object URIs. The receiving handler must re-resolve provider locations through its own tenant/document-scoped repository and compare them to that predecessor result before doing work.

## Registered source production gate

The `registered` source gate is always configured in the production router. For a `DocumentRegistered` delivery, the handler re-resolves `artifactVersionId` and `ingestionId` through the tenant/document-scoped Postgres source registry. It advances only when the exact artifact is still recorded as malware-clean and quarantine-released, uses an authoritative `gs://` GCS object URI, and has both an immutable storage generation and SHA-256 lineage fingerprint. It returns only stable lineage metadata; it does not copy source bytes, object URIs or confidential payload content into the effect journal.

The registered handler is intentionally read-only and deterministic. Redelivery therefore cannot create a second source-side effect, while the worker effect journal still suppresses re-execution once the logical effect is recorded complete.

## Represented document production gate

The `represented` handler is composed only when `CORVIS_REPRESENTATION_ENDPOINT` is bound for the environment. With no approved representation endpoint the stage is absent from the router and therefore fails closed; merging the handler does not constitute provider activation or UAT evidence.

The handler accepts only the exact source artifact identified by the prior `registered` effect result. It re-resolves that artifact through Postgres and requires the current ingestion ID, immutable GCS generation, SHA-256 and size to still match before invoking document interpretation. The provider contract receives the worker's deterministic idempotency key, source GCS identity and a deterministic target representation URI. It is called through keyless GCP service identity with a provider timeout shorter than the stage router timeout; the durable worker owns retries rather than an adapter-local retry loop.

A representation is identified deterministically from tenant + document + immutable artifact version + representation contract version. The producer must create/reuse that exact target GCS object without overwriting it on redelivery and return its immutable generation, content SHA-256, producer/version and interpretation method (`native`, `ocr`, `vision` or `hybrid`). Before Postgres metadata is accepted, the stage independently reads GCS object metadata and verifies generation, size, content hash, representation identity/type and source artifact generation/hash.

`corvis_source.document_representation` is the structured authority for representation metadata; the representation body remains replayable GCS evidence. The table is forced-RLS and server/worker managed. Inserts are conflict-idempotent and an existing row must match every immutable field exactly. A crash after the GCS representation is created but before effect completion therefore causes redelivery to reuse/verify the same logical object and row rather than producing duplicate representation truth.

Only representation metadata needed by the next stage is returned to the effect journal. The object URI stays in the Postgres source module and is re-resolved by downstream handlers.

## Extracted candidate production gate

The `extracted` handler is composed only when `CORVIS_EXTRACTION_ENDPOINT` is bound. Without that approved internal endpoint the stage remains absent/fail-closed. The adapter is intentionally non-authoritative: a model/extraction service never receives database write authority and never writes canonical observations.

The handler consumes only the exact committed `represented` result. It re-resolves the representation by tenant + document + representation ID and requires artifact ID, representation type, immutable GCS generation/hash/size, producer/version and interpretation method to match the predecessor result before any extraction provider call.

Extraction run identity is deterministic over tenant + document + representation plus the reviewed technical extraction contract and the Confluence-governed schema/skill versions. The provider receives that run ID, the exact representation GCS identity, the deterministic target JSONL URI and the worker idempotency key through a keyless GCP OIDC call. It must create/reuse that exact GCS bundle; the durable worker owns retry/redelivery.

Before Postgres accepts candidates, Corvis independently verifies the returned bundle's GCS generation, size, SHA-256, extraction-run ID, predecessor representation generation/hash and governed skill/schema metadata, then downloads the exact immutable generation and recomputes the body SHA-256. Each JSONL candidate must have a stable key, supported candidate type, object payload, bounded dimension-level confidence, provenance, exception codes and at least one exact page or sheet source reference with an approved extraction method.

`corvis_source.extraction_run`, `corvis_source.extraction_candidate` and `corvis_source.extraction_candidate_source_reference` are forced-RLS, server/worker-managed candidate state. Candidate and source-reference IDs are derived deterministically from the run and provider stable keys. Inserts use conflict-idempotent natural identity and every pre-existing immutable record is compared before continuing. A crash after some candidate rows are written leaves the run in `writing`; redelivery safely fills/revalidates the same rows and the run becomes `ready` only after the persisted candidate count matches and a deterministic candidate-set SHA-256 is recorded.

The effect result contains only stable extraction run/representation/artifact IDs, candidate count/hash and governed schema/skill versions. Candidate payloads, source text and GCS object URIs do not enter the processing event bus. Review/quality and all later canonical/publication stages remain separate governed boundaries and must consume only finalized `ready` candidate runs.
