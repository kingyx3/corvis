# Production-like UAT execution protocol

The repository is allowed to prove **readiness to test** before bootstrap; it is not allowed to manufacture live-provider evidence. `acceptance-plan.json` is the canonical executable checklist for the first production-like UAT campaign.

## Before bootstrap

CI must keep the acceptance-plan contract, customer implementation kit, security-assessment pack, Terraform roots, release workflows, runtime-secret workflow and security acceptance workflow internally consistent. No test may mark a live-provider scenario passed without provider-derived evidence.

The final repository-side pre-bootstrap gate is intentionally narrow: the GCP bootstrap workflow must verify the live WIF provider is scoped to `kingyx3/corvis`, the selected GitHub Environment, and `refs/heads/main`, that `corvis-deploy` impersonation is repository-scoped, that no user-managed deploy keys exist, and that bootstrap cannot publish a runtime or Cloudflare edge. The **only external roots required before `Bootstrap GCP foundation`** are the billed GCP project, `corvis-deploy`, the scoped GitHub WIF trust/impersonation binding, and the GitHub `uat` Environment values `GCP_PROJECT_ID` and `GCP_WIF_PROVIDER`. A Corvis domain, Cloudflare zone/token, IdP and Postgres/Supabase provider are src/runtime/public-edge activation dependencies, not foundation-bootstrap prerequisites. After the foundation checks are green, do not add speculative provider infrastructure before exercising UAT.

## Readiness reconciliation

The late production-readiness findings do not all have the same release effect, so do not collapse them into a single "UAT blocked" state. Repository-side release controls advanced materially on 4 October 2026 in PR #352; live provider/account configuration and operating evidence remain separate gates.

- **Foundation bootstrap:** may proceed only after the strengthened WIF trust check passes, including the `refs/heads/main` provider-condition restriction. The repository-side trust and release-governance controls now require a short-lived, repo-scoped GitHub App installation token rather than a long-lived PAT. #224 remains open because the effective GitHub Environment main-only/reviewer settings and GitHub App credential must still be configured and verified outside code.
- **UAT tenancy/data-right acceptance:** #226 is closed after contractual data-right mutations were restricted to Corvis Operations with explicit target-tenant/contract provenance and resource-ownership validation. UAT must retest those negatives against the deployed provider boundary. Do not accept Postgres RLS isolation while #227 remains unresolved: RLS evidence is not sufficient if the normal application runtime still bypasses the policies through a table-owner/service role.
- **UAT deployment/recovery evidence:** #221 is closed after PR #352 bound migration/Terraform work to the requested release SHA and separated rendered-plan review from exact-plan apply. This removes the repository defect; the deployment/recovery control is not accepted until the exact path is exercised successfully in the live UAT environment and its evidence is retained.
- **Production promotion:** #222 is closed after PR #352 bound promotion to the accepted UAT source SHA and OCI digests, added provenance/SBOM generation and verification, and made production release tags immutable. Those repository controls do not by themselves prove production promotion readiness. The external/account-setting portion of #224, UAT acceptance evidence, independent security assessment and normal launch approvals remain gates.

This section is a reconciliation of current implementation and open findings, not a replacement for the owning issues. If an issue is fixed and closed, remove or revise the corresponding gate rather than preserving stale blocker text.

## First UAT campaign order

Use this order for the first production-like UAT activation. The order is a dependency sequence, not permission to mark later phases complete when earlier evidence is absent.

1. **GCP foundation trust roots** — billed GCP UAT project, `corvis-deploy`, environment- and `main`-ref-scoped GitHub WIF trust/impersonation, and GitHub `uat` Environment values `GCP_PROJECT_ID` + `GCP_WIF_PROVIDER`.
2. **Foundation bootstrap** — run `Bootstrap GCP foundation` with `plan`, review it, then `apply` from `main`; retain the run and Terraform-state references. Runtime images and Cloudflare remain deliberately disabled during this step.
3. **Runtime provider/public-edge activation** — activate the Postgres/Supabase tier, write the TLS-verified DSN directly to `corvis-postgres-dsn-uat`, configure approved OIDC issuer/audience/JWKS behavior, and, once a domain is selected, establish Cloudflare zone/token ownership and set the configurable zone value. Domain/Cloudflare setup may happen in parallel with or after foundation bootstrap, but must be complete before public-edge UAT.
4. **Immutable release and deploy** — build the reviewed `main` commit, retain provenance/digest, run Terraform plan/apply, execute forward migrations and prove Cloudflare -> API Gateway -> IAM-private Cloud Run health plus distinct customer/admin/API/worker/control-loop boundaries.
5. **Identity and tenancy negatives** — seed at least two synthetic tenants; exercise OIDC/session/JML, RLS, resource/data-right, service-identity, unauthorized-admin and cross-tenant negatives before relying on functional success-path evidence. Retest the closed #226 data-right authority/resource-ownership defect against the deployed boundary, and do not mark the RLS portion passed while #227 remains open.
6. **Canonical processing journey** — upload/register -> represent -> extract -> review -> canonicalize -> reconcile -> consolidate -> publish using the real authenticated queue/worker/provider path; retain immutable source and stage lineage.
7. **Admin and rollout controls** — exercise disable/reactivation, effective-dated entitlements/data rights, temporary support access expiry/revocation, access review, privileged audit, Parquet/hybrid-retrieval kill switches and tenant emergency stop.
8. **Delivery/integration paths** — exercise physical export checksum/expiry/authorization, webhook signing/replay/retry/key rotation and any launch-enabled external provider paths.
9. **Failure/recovery campaign** — duplicate delivery, worker crash after side effect, persisted retry, terminal dead letter, authorized recovery, correction replay/republication, scoped dependency degradation and known-good rollback.
10. **Operational quality** — supported browser/accessibility checks, performance/load budgets, provider health/cost signals, backup/restore at the purchased tier, GCS inventory reconciliation and incident/runbook exercise.
11. **Independent security assessment** — reconcile exact deployed targets into the rules of engagement, commission the independent production-equivalent assessment, remediate/retest launch blockers and retain confidential evidence outside the public repo.
12. **Evidence reconciliation / launch review** — attach sanitized references to the owning readiness issues and Confluence control records; unresolved mandatory evidence blocks production and must not advance a readiness claim.

## Immediately after bootstrap

Run the reviewed promotion/deployment path rather than ad-hoc console deployment. Capture sanitized references for the exact commit and OCI digest, Terraform apply, edge/gateway/IAM bindings, database migration revision, IdP configuration identifier and acceptance run IDs. Never commit DSNs, tokens, API keys, tenant secrets or confidential provider exports.

Execute the required scenarios in `acceptance-plan.json` against dedicated synthetic tenants. Failure injection must be bounded and reversible. A scenario passes only when persisted Postgres state and externally observable behavior agree; HTTP success alone is insufficient for replay/idempotency/recovery cases.

## Evidence semantics

Each evidence record should identify environment, release digest, scenario ID, timestamp, actor/service identity, sanitized resource reference, expected result, observed result and the immutable location of confidential supporting evidence. A skipped, incomplete or unexecuted scenario is not a pass. Failed mandatory evidence must not advance the known-good release pointer.

## Backfill launch decision

No separate bulk backfill command is required for initial launch. Governed correction replay/republication is the approved bounded operating path for retained-evidence corrections. If onboarding later requires tenant/document-range historical reprocessing, add a separately authorized bulk-backfill workflow using the same durable journey/idempotency contracts; do not use direct database edits or widen correction replay implicitly.

## Exit from UAT

UAT is complete only after all required acceptance scenarios have passed, launch-blocking security findings are closed and retested, recovery/rollback has been exercised, and sanitized evidence references have been attached to their owning readiness/control issues. SOC 1/SOC 2 Type II readiness still requires real operating-period evidence and independent auditor work; UAT completion is not an attestation.
