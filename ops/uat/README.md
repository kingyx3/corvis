# Production-like UAT execution protocol

The repository is allowed to prove **readiness to test** before bootstrap; it is not allowed to manufacture live-provider evidence. `acceptance-plan.json` is the canonical executable checklist for the first production-like UAT campaign.

## Before bootstrap

CI must keep the acceptance-plan contract, customer implementation kit, security-assessment pack, Terraform roots, release workflows, runtime-secret workflow and security acceptance workflow internally consistent. No test may mark a live-provider scenario passed without provider-derived evidence.

## Immediately after bootstrap

Run the reviewed promotion/deployment path rather than ad-hoc console deployment. Capture sanitized references for the exact commit and OCI digest, Terraform apply, edge/gateway/IAM bindings, database migration revision, IdP configuration identifier and acceptance run IDs. Never commit DSNs, tokens, API keys, tenant secrets or confidential provider exports.

Execute the required scenarios in `acceptance-plan.json` against dedicated synthetic tenants. Failure injection must be bounded and reversible. A scenario passes only when persisted Postgres state and externally observable behavior agree; HTTP success alone is insufficient for replay/idempotency/recovery cases.

## Evidence semantics

Each evidence record should identify environment, release digest, scenario ID, timestamp, actor/service identity, sanitized resource reference, expected result, observed result and the immutable location of confidential supporting evidence. A skipped, incomplete or unexecuted scenario is not a pass. Failed mandatory evidence must not advance the known-good release pointer.

## Backfill launch decision

No separate bulk backfill command is required for initial launch. Governed correction replay/republication is the approved bounded operating path for retained-evidence corrections. If onboarding later requires tenant/document-range historical reprocessing, add a separately authorized bulk-backfill workflow using the same durable journey/idempotency contracts; do not use direct database edits or widen correction replay implicitly.

## Exit from UAT

UAT is complete only after all required acceptance scenarios have passed, launch-blocking security findings are closed and retested, recovery/rollback has been exercised, and sanitized evidence references have been attached to their owning readiness/control issues. SOC 1/SOC 2 Type II readiness still requires real operating-period evidence and independent auditor work; UAT completion is not an attestation.
