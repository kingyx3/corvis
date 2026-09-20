# Service identity authorization and lifecycle

## Production controls

Corvis production service identities are keyless and least-privilege by default.

- GitHub deploys through OIDC/Workload Identity Federation and impersonates the derived `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` identity. Do not create or store a JSON service-account key for CI/CD.
- The production GCP project enforces `iam.disableServiceAccountKeyCreation` and `iam.disableServiceAccountKeyUpload` through Terraform.
- Runtime API and worker identities are separate service accounts. Both receive only log-writer access at project scope.
- The API receives `roles/storage.objectCreator` only for objects whose resource name is under the controlled `uploads/` prefix of the source bucket.
- The worker receives source-bucket read access independently; do not reuse the API identity for worker execution.
- The public API gateway uses a separate keyless `corvis-gateway-${environment}` service account. That identity, and not `allUsers`, receives `roles/run.invoker` on the API Cloud Run service.
- The Google API Gateway service agent receives token-creation authority only for the dedicated gateway identity; the deploy identity receives `iam.serviceAccounts.actAs` only as required to attach that identity to gateway configurations.
- Service-account subjects that cross the application authorization boundary require an active `corvis_control.identity_subject` mapping, active membership, and an active `corvis_control.service_identity_grant` whose validity and review windows have not expired.
- `service_identity_grant` has forced RLS and no client mutation policy. Provisioning, renewal, review, and disable operations must use an audited server/service-role path with explicit tenant predicates.
- Session revocation remains an independent deny control. A current lifecycle grant does not override a revoked session.

### Public API Gateway identity boundary

The API Gateway service account is infrastructure identity, not an application customer/user identity. Its purpose is limited to proving that Google API Gateway may invoke the Cloud Run API backend.

The required boundary is:

```text
Cloudflare Worker
   |
   | restricted edge API key
   v
Google API Gateway
   |
   | OIDC token signed as corvis-gateway-${environment}
   v
Cloud Run API
   |
   | application identity assertion + tenant authorization
   v
Postgres / RLS
```

Security acceptance must fail unless Cloud Run `roles/run.invoker` contains exactly the dedicated gateway service account for the normal public path. A direct unauthenticated `run.app` request must fail IAM authorization. Do not treat the Cloudflare edge API key or gateway workload identity as a substitute for application identity, membership, entitlement or RLS.

### Processing-worker OIDC binding

Approved Pub/Sub push and Cloud Tasks delivery to `/api/internal/processing-stage` uses the dedicated worker service account and a Google-issued OIDC ID token. The application independently verifies the RS256 signature against Google's published keys, the Google issuer, token lifetime, the exact configured worker URL audience and the exact configured worker service-account email.

For this boundary, provision the Google token's immutable numeric `sub` value as the `corvis_control.identity_subject.subject` for `auth_method='service_account'`. Do not use transport-provided tenant, workspace or role claims to construct authorization. After token verification, Corvis resolves active workspace mappings and re-runs the normal Postgres membership, data-right, lifecycle-grant and session-revocation checks for the durable delivery's tenant/document.

Worker session revocation uses a stable application session identifier derived from the immutable Google subject (`processing-worker:<sha256-prefix>`). Operators must use the corresponding subject/session pair when an immediate application-layer cut-off is required in addition to disabling the GCP service account or Cloud Run invocation grant.

## Lifecycle operating rule

Each application service identity must have a named purpose, owner/reviewer recorded as `reviewed_by_subject`, a finite `valid_until`, and a finite `next_review_at` no later than expiry. Renewal is an explicit control-plane action; an expired grant or overdue review fails closed on the next authorization lookup.

Disable the `identity_subject` and its `service_identity_grant` when the integration is retired, ownership changes without approved handover, or compromise is suspected. Revoke active sessions separately when immediate cut-off is required.

Infrastructure-only service identities such as the API Gateway invoker are governed by Terraform/IAM rather than the tenant-facing `service_identity_grant` table unless they are later permitted to act as application principals. They still require keyless operation, least privilege, reviewed IaC changes and acceptance evidence.

## UAT IdP + Supabase/RLS evidence gate

Do not substitute mocks or local assertions for provider evidence. Once the real UAT IdP and Supabase project are available, capture evidence for all of the following before promoting the authorization path:

1. Successful OIDC/SAML sign-in through the configured UAT IdP with the expected immutable subject and tenant/workspace mapping.
2. Negative IdP cases: invalid audience/issuer, expired token/assertion, disabled identity, wrong tenant/workspace, and replay/expired Corvis identity assertion.
3. Supabase `auth.uid()` is populated for the real user session and resolves only the expected active tenant/workspace membership.
4. RLS denies cross-tenant reads and all unauthorized client writes to privileged control tables.
5. RLS permits the expected same-tenant reads for tenant, workspace, membership, entitlement, feature-flag, and audit evidence surfaces.
6. Service-role/server access still applies explicit tenant predicates and does not depend on RLS for isolation.
7. A service-account subject without a lifecycle grant, with an expired grant, with an overdue review, or with a disabled grant is denied.
8. A current service-account grant is still denied when its session has been revoked.
9. Processing ingress evidence proves wrong issuer/audience/email, expired tokens, disabled/expired/revoked service identity, wrong tenant/document and ambiguous workspace authorization all fail before the stage claim.
10. Public API ingress evidence proves missing/invalid direct gateway edge keys fail, direct unauthenticated Cloud Run invocation fails, and the gateway service account is the only normal public-path Cloud Run invoker.
11. Record timestamps, environment/project identifiers, migration version, test actor/subject identifiers, SQL/API commands used, and sanitized outputs in the security acceptance evidence artifact. Never include credentials or raw tokens.

The UAT evidence item remains open until these checks have been executed against the real provider environment and the resulting evidence has been reviewed.
