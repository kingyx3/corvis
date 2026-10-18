# SOC 1 readiness — technical implementation contract

This document is the repository-side companion to the canonical Confluence SOC 1 readiness and audit plan. Confluence owns governance, scope, control objectives, policy, operating evidence and assurance claims. GitHub owns technical implementation and executable evidence paths.

## Assurance boundary

Corvis must not be represented as SOC 1 certified, compliant, attested or independently audited unless and until an independent qualified CPA firm completes the agreed SOC 1 examination and issues its report. Repository controls, tests and readiness mapping are not an attestation.

SOC 1 is relevant only to controls at Corvis that are likely to matter to user entities' internal control over financial reporting. The auditor-agreed system description and control objectives are therefore the authoritative scope; general security controls belong here only where they support those financially relevant objectives.

## Machine-readable readiness map

[`../../ops/soc1-controls.json`](../../ops/soc1-controls.json) maps the intended SOC 1 control objectives to owners, technical evidence and readiness state. [`../../tools/repo-checks/assurance/soc1-readiness.test.ts`](../../tools/repo-checks/assurance/soc1-readiness.test.ts) prevents accidental removal of required control objectives and prevents readiness language from being converted into an issued-report claim.

## Existing technical foundation

Corvis already implements substantial controls that can support a SOC 1 examination when operated in the auditor-agreed production scope:

- authorized source ingestion and customer/source-rights boundaries;
- durable, idempotent processing stages with retry/dead-letter behavior;
- source lineage and reproducibility for historical snapshots;
- review and reconciliation exception workflows;
- publication gates and versioned outputs rather than silent overwrite;
- tenant-scoped authorization, Postgres RLS and privileged-operation attribution;
- controlled database migrations, CI/CD, Terraform and release promotion;
- audit events, control-evidence lifecycle and operational monitoring;
- data-quality correction and replay paths;
- retention/deletion and recovery controls.

These are design and implementation foundations. A SOC 1 Type II conclusion requires evidence that in-scope controls operated consistently over the agreed period.

## Financially relevant data path and decision rights (draft, verified against code on 17 October 2026)

This is the repository-side draft for audit gate 3 (map every financially relevant data path). It records what the code does today, so the auditor-agreed system description can be written against facts. It is **not** the frozen system description: scope, relevance, subservice treatment and complementary user-entity controls are still decided with the auditor (gates 1 and 2). `soc1-readiness.test.ts` fails if a repository path named in this section stops existing.

"Audit row" means a row in `corvis_control.audit_event`, which is append-only. Roles come from `ROLE_PERMISSIONS` in `src/shared/domain/enterprise.ts`: only `admin` holds `documents:write`, `snapshots:publish` and `admin:manage`; `reviewer` holds `observations:review`, `sources:read` and `exports:create`. "None found" means a search of the code found no audit row; the stage's evidence is then its state tables.

| Stage | Code | State record | Audit row | Permission | Integrity and idempotency |
|---|---|---|---|---|---|
| 1a. Customer upload | `src/app/api/v1/uploads/initiate/route.ts`, `src/app/api/v1/uploads/[uploadId]/complete/route.ts`, `src/modules/sources/server/uploads/uploads.ts` | GCS upload session; registry rows (stage 2) | none found (telemetry only) | `documents:write`; only the uploader may continue a session (`upload-access.ts`) | Idempotency key bound to subject and workspace; reuse for a different file is rejected; session writes use GCS generation preconditions |
| 1b. Connector sync | `src/modules/sources/server/connectors/source-connector-sync.ts`, `src/modules/sources/server/connections/source-sync-scheduler.ts`, `src/app/api/internal/delivery/route.ts` | `corvis_source.source_connection`, `source_connection_run`, `acquired_document` | Connection changes only: `source_connection.create`, `pause`, `resume`, `revoke`, `reauthorize`, `test`, `token_refresh`; sync runs: none found | Connection routes need `admin:manage`; sync runs as `system:source-sync` behind a verified worker identity | Acquisition key = sha256 of remote id, version and content hash; already-accepted keys are skipped; scheduling lease by compare-and-set; configured scope is re-checked |
| 2. Registration | `src/modules/sources/server/uploads/upload-integrity.ts`, `src/modules/sources/server/uploads/upload-release.ts`, SQL `corvis_source.release_clean_artifact` (`db/postgres/migrations/006_release_clean_artifact_document_guard.sql`) | `corvis_source.document`, `document_artifact_version` (sha256, storage generation, scan and quarantine status); processing job `registered:<document>` | none found for registration; `source_document.read` and `source_reference.read` audit reads of evidence | Release is automatic after a clean scan verdict; reading source needs `sources:read` and document access | sha256 computed from stored bytes pinned to the GCS generation; mismatch means `integrity_failed` and quarantine; purged or mismatched artifacts refused. The source bucket has versioning and CMEK; **no retention lock or WORM is configured**, so immutability rests on generation pinning, hashes and the release function |
| 3. Representation | `src/modules/processing/server/stages/processing-represented-stage.ts` | `corvis_source.document_representation` | none found (telemetry) | Stage worker service identity; Google OIDC ingress (`processing-worker-ingress.ts`) | Deterministic representation id; lineage re-checked against the registered stage; GCS generation and content hashes verified; effect journal `corvis_control.processing_stage_effect` |
| 4. Extraction | `src/modules/processing/server/stages/processing-extracted-stage.ts`, `services/extractor/server.mjs`, `services/litellm-gateway/entrypoint.py` | `corvis_source.extraction_run` (model, skill and manifest hashes, candidate-set hash), `extraction_candidate`, `extraction_candidate_source_reference` | none found | As stage 3 | Deterministic run id from contract, schema, skill and orchestration versions; candidate-set sha256; effect journal |
| 5. Human review | `src/app/api/v1/extraction-review/route.ts`, `src/modules/processing/server/stages/processing-reviewed-stage.ts`; legacy observations: `src/app/api/v1/review/route.ts` | `corvis_review.candidate_review_requirement` (risk tier, required approvals), `candidate_review_event` (append-only), `extraction_review_gate`; legacy `corvis_facts.review_event` | `extraction_candidate.approve`, `reject`, `correct`, `resolve_exception`, written atomically with the decision; legacy `observation.approve`, `reject`, `correct` | `observations:review` (`admin` or `reviewer`); mandatory `Idempotency-Key` | Deterministic review event id with reuse detection; a trigger closes review once the reviewed stage runs; decision-set hash stored on the gate |
| 6. Canonicalization | `src/modules/processing/server/stages/processing-canonicalized-stage.ts`, SQL `corvis_facts.canonicalize_reviewed_extraction_v4` | `corvis_facts.canonicalization_run`, `observation`, `source_reference` | none found | Stage worker identity only; no human actor | Requires a ready review gate whose candidate and decision-set hashes match, a committed reviewed effect, and complete source-reference lineage |
| 7. Reconciliation and exceptions | `src/modules/processing/server/stages/processing-reconciled-stage.ts`, `src/app/api/v1/reconciliation-exceptions/resolve/route.ts`, SQL `corvis_consolidated.resolve_reconciliation_exception` | `corvis_consolidated.reconciliation_run`, `reconciliation`, `reconciliation_exception` (versioned), `reconciliation_resolution_event` | `reconciliation.select_source`, `mark_immaterial`, `accept_reconciliation` (manual resolution); the automated run: none found | `observations:review`, plus `sources:read` to select a source | Optimistic `expectedVersion` on exceptions; client idempotency key; resolution event keeps before and after state and the actor |
| 8. Consolidation and serving | `src/modules/processing/server/stages/processing-consolidated-stage.ts`, `src/platform/data/public-serving-resources.ts` | `corvis_consolidated.consolidation_run`, `consolidated_fact`, `fund_period_snapshot` (draft) | none found | Read routes need `observations:read` | Deterministic run id; serving returns consolidated facts only through a snapshot whose status is `published` |
| 9. Publication gate | Manual: `src/app/api/v1/snapshots/publish/route.ts`, `src/modules/review/domain/publication-policy.ts`, SQL `append_snapshot_transition`; automated: `src/modules/processing/server/stages/processing-published-stage.ts` | `fund_period_snapshot` (new immutable version rows), `snapshot_publication_event`, `publication_run`, outbox `SnapshotPublicationChanged` | Manual: `snapshot.publish`, `withdraw`, `supersede`; automated: no audit row (the publication event records actor `processing:published`) | Manual: `snapshots:publish` (`admin` only); automated: stage worker identity | Publishable only with a draft snapshot, no open exceptions, no active correction incident, complete lineage, critical facts reviewed with at least two required approvals, and resolved conflicts; optimistic version; idempotent publication run |
| 10. Delivery | Exports: `src/app/api/v1/exports/route.ts`, `src/app/api/v1/exports/[exportId]/download/route.ts`, `src/modules/delivery/server/exports/physical-exports.ts`; webhooks: `src/modules/delivery/server/webhooks/webhooks.ts`, `src/modules/delivery/server/webhooks/webhook-subscriptions.ts` | `corvis_serving.export_job` (checksum, manifest), `export_download_grant`; `corvis_control.webhook_subscription`, `webhook_signing_key`, `webhook_delivery`, `outbox_event` | Webhook subscription `webhook_subscription.create`, `rotate_signing_key`, scheduled exports `export_schedule.*`; export create and download, and individual webhook deliveries: none found (`export_job.requested_by` and delivery rows are the evidence) | `exports:create` plus the data-rights redistribution check; webhook administration needs the tenant admin role and `admin:manage` | Export manifest hash and pinned snapshot versions re-checked at download; export and outbox event commit together; single-use download grant stored as a hash; HMAC-signed webhooks with a unique key per attempt |
| 11. Data correction | `src/app/api/v1/admin/data-corrections/route.ts`, `src/modules/governance/server/lifecycle/data-correction.ts`, SQL `open_data_correction_incident`, `request_data_correction_replay`, `resolve_data_correction_incident` | `corvis_control.data_correction_incident` | `data_correction.open`, `replay`, `resolve`, in the same transaction as the change | Tenant admin role plus `admin:manage` | Idempotency key and request hash on open; replay limited to one retained clean released artifact; an open incident blocks publication for that fund and period; resolve needs an already-published replacement in the same fund and period |

### Decision rights and segregation: current state and open decisions

Separation of duties is **not** yet demonstrated end to end. The code enforces the following today; everything else is single-actor attribution or open for an auditor-agreed policy.

- **Dual control exists** for critical metrics in review (stage 5): two distinct approvers are needed, counted after the latest correction, in both the extraction review path and the legacy observation path. Publication re-checks that the requirement was two and the gate is ready, but does not recount distinct approvers. Deletion requests and tenant export approval also have separate four-eyes controls, outside this data path.
- **Single approver:** every non-critical candidate needs one approval. The code labels an "independent review" requirement but nothing found bars the uploader or the extractor's operator from approving.
- **Correction then approval:** for critical facts, the same person can submit a correction and then be one of the two approvers.
- **Exception resolution, publication and correction** (stages 7, 9, 11) are each single-actor. One `admin` can resolve exceptions and publish; one tenant administrator can open and resolve a data-correction incident (`resolved_by` is not compared with `opened_by`).
- **Automated publication** publishes with no human sign-off when review and reconciliation are clean, and writes no audit row; its evidence is `snapshot_publication_event`, `publication_run` and the outbox event.
- **Audit coverage:** stages with no audit row are connector sync runs, upload and registration, representation through consolidation, automated reconciliation, export creation and download, and individual webhook deliveries. `reconciliation_resolution_event` and `snapshot_publication_event` have no append-only trigger; the runtime role is limited to insert and select.
- **Not verified here:** how the tenant administrator flag is derived, how the worker identity allowlist is configured, and whether replay re-review needs a human beyond the normal review gate.

Which of these need dual control, an audit row or an append-only guard is a policy decision with the auditor, not a code default; this section exists so that decision is made against the real behaviour.

## Intended financially relevant control objectives

1. **System governance and description** — the services, people, procedures, data flows, infrastructure, subservice organizations, boundaries and control owners are accurately described and changes are governed.
2. **Authorized and complete input** — only authorized customer/source data enters financially relevant processing and expected source inputs are complete or exceptions are detected.
3. **Accurate and complete processing** — extraction, normalization, transformation and canonicalization preserve required values, provenance and reporting-period context.
4. **Reconciliation and exception resolution** — conflicts, missing values, source-authority questions and materiality decisions are surfaced, resolved by authorized actors and retained as evidence.
5. **Review, approval and segregation** — financially relevant overrides, exception closures and publication decisions require appropriate authorization and are attributable.
6. **Complete, accurate and timely output** — exports/publications are generated from an approved version, include the intended scope, are reproducible and cannot be silently altered after release.
7. **Change management** — application, schema, infrastructure, model/prompt/configuration and migration changes that can affect financially relevant processing are authorized, tested, traceable and recoverable.
8. **Logical access supporting ICFR** — access to financially relevant data, privileged functions and service identities is least-privilege, tenant-scoped, reviewed and logged.
9. **Master/configuration data integrity** — mappings, reporting-period identifiers, materiality/configuration rules and other financially relevant reference data are versioned and change controlled.
10. **Error correction and incident handling** — material data errors are contained, corrected through versioned/replayable paths, communicated where required and do not create silent historical restatement.
11. **Subservice organizations and complementary controls** — dependencies and customer responsibilities that affect the control objectives are explicitly identified, bounded and included using the auditor-agreed carve-out or inclusive method.

## Evidence expectations

Technical evidence should be generated by normal operation wherever practical. Public GitHub may contain control definitions, tests, workflow references, hashes and sanitized status. Customer data, private audit samples, vendor SOC reports, personnel records and other confidential evidence must remain in the controlled evidence repository.

For each in-scope control, the operating record should identify the owner, population, frequency, evidence source, result, exception and remediation. Evidence that does not establish the relevant period, actor, system/version and outcome should not be treated as sufficient.

## Remaining audit-readiness gates

The product is not SOC 1 examination-ready until at least the following are complete:

1. confirm with customers/auditor which Corvis services are relevant to user-entity financial reporting;
2. freeze the SOC 1 system description, boundaries, control objectives, subservice treatment and complementary user-entity controls;
3. map every financially relevant data path from authorized input through extraction, review, reconciliation, canonicalization, publication/export and correction;
4. activate production-like UAT/provider infrastructure and collect current evidence from the actual control paths;
5. prove expected-input completeness or documented exception handling for each in-scope source/acquisition path;
6. prove review/reconciliation/publication authorization, attribution and appropriate segregation for material decisions;
7. prove output completeness, version integrity and reproducibility for representative reporting periods;
8. operate access reviews, change controls, incident/error-correction controls and relevant vendor/subservice reviews on schedule;
9. perform a readiness assessment with a qualified SOC 1 service auditor and resolve control/design gaps;
10. operate the agreed controls for the full Type II observation period, recording exceptions rather than reconstructing evidence retroactively;
11. obtain the independent SOC 1 report before making any attestation claim.

## Release and assurance rule

A passing build or a production-ready system is not itself a SOC 1 conclusion. Product releases should fail closed where mandatory financially relevant controls or evidence are missing, but the independent service auditor remains responsible for the SOC 1 examination and opinion. Customer-facing assurance language must match the issued report type, system scope, control objectives and period exactly.
