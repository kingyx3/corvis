# Service identity authorization and lifecycle

## Production controls

Corvis production service identities are keyless and least-privilege by default.

- GitHub deploys through OIDC/Workload Identity Federation and impersonates the derived `corvis-deploy@${GCP_PROJECT_ID}.iam.gserviceaccount.com` identity. Do not create or store a JSON service-account key for CI/CD.
- The production GCP project enforces `iam.disableServiceAccountKeyCreation` and `iam.disableServiceAccountKeyUpload` through Terraform.
- Runtime API and worker identities are separate service accounts. Both receive only log-writer access at project scope.
- The API receives `roles/storage.objectCreator` only for objects whose resource name is under the controlled `uploads/` prefix of the source bucket.
- The worker receives source-bucket read access independently; do not reuse the API identity for worker execution.
- Service-account subjects that cross the application authorization boundary require an active `corvis_control.identity_subject` mapping, active membership, and an active `corvis_control.service_identity_grant` whose validity and review windows have not expired.
- `service_identity_grant` has forced RLS and no client mutation policy. Provisioning, renewal, review, and disable operations must use an audited server/service-role path with explicit tenant predicates.
- Session revocation remains an independent deny control. A current lifecycle grant does not override a revoked session.

## Lifecycle operating rule

Each application service identity must have a named purpose, owner/reviewer recorded as `reviewed_by_subject`, a finite `valid_until`, and a finite `next_review_at` no later than expiry. Renewal is an explicit control-plane action; an expired grant or overdue review fails closed on the next authorization lookup.

Disable the `identity_subject` and its `service_identity_grant` when the integration is retired, ownership changes without approved handover, or compromise is suspected. Revoke active sessions separately when immediate cut-off is required.

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
9. Record timestamps, environment/project identifiers, migration version, test actor/subject identifiers, SQL/API commands used, and sanitized outputs in the security acceptance evidence artifact. Never include credentials or raw tokens.

The UAT evidence item remains open until these checks have been executed against the real provider environment and the resulting evidence has been reviewed.
