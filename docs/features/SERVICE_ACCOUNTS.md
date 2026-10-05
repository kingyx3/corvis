# Service accounts (F6, #262)

Organization Admins create service accounts and issue, rotate and revoke their API credentials from **Access administration** (`/access-self-service`, "Service accounts"), so their own systems can call Corvis without borrowing a person's login. This page records what ships, the design, every assumption made, and the one decision that is still open: **how a presented credential is accepted at the API edge**. Contract: `API_CONVENTIONS.md`, "Service accounts (F6)". Schema: migration `088_service_accounts.sql`.

## What ships, and what does not

| Capability | State |
| --- | --- |
| Create a service account with a role, a workspace, a purpose and a finite lifetime | Shipped (Postgres and demo mode) |
| Credential record lifecycle: issue, rotate with an overlap, revoke immediately; secret shown once, only a SHA-256 stored | Shipped |
| List with role, workspace, creator, last used, expiry, and a flag on a credential (or account) nearing expiry | Shipped |
| Deactivate an account everywhere (identity, lifecycle grant, memberships, entitlements, credentials) | Shipped |
| Every action audited, visible in the tenant access audit and its CSV, and in a full data export's access-audit file | Shipped |
| The account appears in the operator access review (`GET /api/v1/admin/access-review`) | Shipped (no change needed: it already lists every `identity_subject`, membership and `service_identity_grant`) |
| `axe-core` coverage of the screens | Shipped (`e2e/quality/access-pages-accessibility.spec.ts`, light and dark) |
| Record-side credential check (`verifyServiceAccountCredential`: constant-time compare, immediate revocation, rotation overlap, expiry, last-used) | Shipped and tested, **not called by any request path** |
| **Accepting a credential on an API request** | **Not shipped. Decision needed (below).** |
| Extend an account's expiry (audited; advances the 009 `next_review_at` with it, within the 365-day maximum) | Shipped (F6b, migration 092) |
| An owner on every account, transfer to another active Organization Admin, and a rule for an owner who is deactivated | Shipped (F6b) |
| Notify Organization Admins before an account or its credential expires: one mandatory email per admin per window (14 days, then 3), never repeated, never after renewal or deactivation | Shipped (F6d, #341, migration 096) |
| Customer entitlement self-service: an Organization Admin grants and revokes read access to funds and documents for an account, within the organization's data rights, audited, shown on the account | Shipped (F6c, #342, migration 096) |
| A "last used from" source, and recent use without a write per request | Not shipped (needs the credential verification path; blocked on the decision below) |

Until the decision is made and implemented, a credential issued here is stored and managed but **does not authenticate any request**. The screen says so in a visible note, so no one is led to believe it works. Nothing is half-wired in the other direction either: no request path can accept a credential by accident, because none reads these tables.

## Design

### One identity model, no parallel API-scope plane (#11)

A service account is **not** a new kind of principal with its own scopes. Creating one (`corvis_control.create_service_account`, one statement) writes exactly the rows the existing authorization lookup (`src/modules/identity-access/server/authorization.ts`) already resolves for an `auth_method = 'service_account'` subject:

- `identity_subject` (`subject = 'service-account:<id>'`, a fresh `user_id`),
- one `membership` in the chosen workspace with one of `reviewer`, `analyst`, `viewer`, ending when the account does,
- one `service_identity_grant` (migration 009: purpose, finite validity, review window; `reviewed_by_subject` is the creating admin; `next_review_at = valid_until`),

plus `service_account` (the managed record: name, purpose, creator, expiry) and `service_account_credential`. The lookup therefore enforces, for a service account, exactly what it enforces for a person: active identity, active membership and workspace, the lifecycle grant (a missing, expired, overdue-for-review or disabled grant denies), session revocation, resource entitlements and contractual data rights. `db/postgres/tests/service-accounts.mjs` proves this through the real `PostgresMembershipAuthorizationRepository`, including that creating an account grants no fund or document access.

**Roles.** A service account holds only `reviewer` (Review Analyst), `analyst` or `viewer`. It can never hold `tenant_admin` or `accountadmin`: the SQL function and the table's own `CHECK` refuse any other role, so a machine is never an administrator and can never reach `/api/v1/access/**` (which also refuses `authMethod = 'service_account'` explicitly). Whether to allow `accountadmin` is a product decision, defaulted closed.

**Data access.** Creating an account grants no fund or document entitlement and changes no data right: until something is granted the account sees nothing. An Organization Admin grants and revokes it on the account itself (F6c, below) within the funds and documents the organization is licensed to see, through the same `resource_entitlement` rows the authorization lookup reads for a person. Corvis operations no longer need to be involved; the operator path (`POST /api/v1/admin/access-policy`) still works unchanged, and an account's identity reference (its `user_id`) is still what it takes there. Entitlement self-service for **people** is deliberately out of scope here (see F6c).

**Lifetime.** An account's expiry is at most 365 days away (009's rule: finite, never open-ended), at creation and again at every extension (below). A credential defaults to 90 days, is clamped to its account's expiry when issued, and is flagged "Needs attention / Expiring soon" within 14 days of expiring (the account itself is flagged the same way).

### Renewal: extend expiry (F6b, #341)

An Organization Admin extends an account with `{ action: "extend", expiresInDays }` (1 to 365, default 365, counted from the moment of the extension). `corvis_control.extend_service_account` requires the new expiry to be at least a day later than the current one (an account about a year out cannot be "extended" by minutes; the screen shows the minimum and refuses less before sending), later than now, and at most 366 days from now (365 plus the day of grace creation allows), and moves, in one statement: the account's `expires_at`, its membership's `valid_until`, and its 009 lifecycle grant (`valid_until`, `next_review_at` and a fresh `reviewed_at`/`reviewed_by_subject`: an extension is a review). So the authorization lookup keeps resolving the account exactly as long as the account says it does. A **credential keeps its own expiry** (it was clamped to the account's at issue time): an extended account issues or rotates a credential as usual. An account that already expired can be extended (then given a credential again); a deactivated one cannot (`409 service_account_not_active`), and nothing but this function can change an expiry (a guard trigger refuses any other update, and any shortening). The audit event is `service_account.extended` with `previousExpiresAt`, `expiresAt` and `nextReviewAt`.

### Ownership (F6b, #341)

Every account has an **owner**, an active Organization Admin who answers for it (`owner_subject`, `owner_user_id`, `owner_assigned_at`). The creating admin is the first owner (existing accounts were backfilled with their creator); `created_by_*` stays as history. `{ action: "transfer", ownerSubject }` hands the account to **another active Organization Admin** (`corvis_control.transfer_service_account_owner`; the people on offer are the `owners` in the list response, computed by the same SQL test `service_account_owner_active`: an active human `oidc`/`saml` identity with an active `tenant_admin` membership). Any Organization Admin can transfer, including to themselves; the owner must differ from the current one (`409 service_account_owner_unchanged`), must be eligible (`422 service_account_owner_invalid`), and a deactivated account cannot change hands. Audit event `service_account.owner_transferred` with `previousOwner` and `ownerSubject`.

**When the owner is deactivated or loses the Organization Admin role**, the account is **not silently orphaned and not disabled**: its credentials keep working, `ownerActive` turns false and `needsOwner` true, the list shows "Needs attention" and "Needs a new owner" with the former owner named, and **it is not extended until an active admin takes it over** (`409 service_account_needs_owner`; the UI hides Extend and makes "Assign a new owner" the primary action). Rotating, issuing, revoking and deactivating stay available, so an ownerless account can always be made safe. Assumption to confirm: ownerless accounts are blocked from *renewal* only, not from credential rotation, so a security response never waits on finding an owner.

### Data access self-service (F6c, #342)

An Organization Admin scopes what a machine can read on the account's own card ("Data access": **Grant data access**, **Remove**), without a Corvis operator.

- **Within the organization's rights, enforced in SQL, fail closed.** `corvis_control.grant_service_account_entitlement` (migration 096) grants one fund or document only when **both** hold: the resource belongs to the tenant (`access_policy_resource_belongs_to_tenant`, migration 078: tenant-private identity evidence, a position or tenant-owned facts for a fund, a tenant document) **and** the tenant holds an effective, client-visible contractual data right for it (`service_account_data_right_effective`: at least one effective `data_rights` row and every effective row `client_visible`, the same test the authorization lookup applies to a person's entitlement). Every other case (another tenant's fund or document, a resource with no right, a hidden, lapsed or conflicting right, an id that does not exist) raises the **one** message `service account resource outside organization data rights` and maps to one `422 entitlement_outside_data_rights`, so the answer never says whether another tenant holds a resource. The application never sends a user, a workspace or a permission: the target is the account, the workspace is the account's own, and the permission is `read` (the only permission the lookup consumes for fund and document visibility; review, publish and admin are never granted to a machine from here).
- **One plane.** It writes `corvis_control.resource_entitlement` rows (valid from now, open-ended: the account's own expiry and membership bound them, and deactivating the account ends them, migration 088). Nothing new reads them, so `src/modules/identity-access/server/authorization.ts` resolves a grant exactly as it resolves a person's, including the data-rights join: if the organization's right later lapses the entitlement stays on record, the lookup ignores it, and the screen flags it ("Not covered by your organization's data rights, so the account cannot see it"). `db/postgres/tests/service-accounts.mjs` proves this through the real lookup.
- **Who and when.** Only an active human Organization Admin of the tenant (the same SQL guard as every other function); the account must be active (not deactivated, not expired) to be granted anything; at most 200 effective entitlements per account (`SERVICE_ACCOUNT_ENTITLEMENT_LIMIT`, enforced in SQL from a parameter); granting what is already held is `409 service_account_entitlement_exists`.
- **Revocation** (`revoke_service_account_entitlement`) ends every entitlement the account holds on that resource at once (including an operator-granted `review` or higher), keeps the row for review, and is **never** refused for a data-right or ownership reason: access can always be removed, including from an expired account and after the right or the resource is gone. Nothing to remove is `404 service_account_entitlement_not_found`.
- **Audited** in the same transaction as the command: `service_account.entitlement_granted` (`resourceType`, `resourceId`, `permission: "read"`, `reason`) and `service_account.entitlement_revoked` (`resourceType`, `resourceId`, `endedEntitlements`, `reason`), visible in the tenant access audit and its CSV like every `service_account.*` action. A stated reason (3 to 1,000 characters) is required for both. The audit names the resource by identifier, never its figures.
- **What the admin may pick.** `GET /api/v1/access/service-accounts` returns `grantable`: the organization's own funds and documents that hold an effective client-visible data right (the grant function's two tests, at most 500, named). `serviceAccount.entitlements` lists what each account can read now, with `withinDataRights`, and `entitlementAccess` says whether grant and remove are available.
- **People are out of scope.** The functions take a service account id, never a user, so they cannot grant a person anything; a people entitlement editor would reuse the same two SQL tests and the 078 helper but needs its own UX, review of who may widen a colleague's access, and audit shape. Not built here.
- **Assumption to confirm: no redistribution right is required.** A grant needs the client-visible right only, exactly as a person's access does. Data that leaves through an export is separately gated by the redistribution right at export time. If a machine reading through the API should also need `redistribution_allowed`, it is one more predicate in `service_account_data_right_effective`.

### Expiry notices (F6d, #341)

`service_account_expiry` is a **mandatory** F2 category for Organization Admins (the rule for a notice that makes a lifecycle control work: finite lifetime and review is the 009 control, and an admin who could opt out of hearing that a credential is about to stop would defeat it). It is queued by `corvis_control.queue_service_account_expiry_notices` (migration 096), called by the `serviceAccountExpirySweep` task of the private delivery tick (`src/modules/identity-access/server/service-accounts/service-account-expiry-sweep.ts`; the ordinary outbox dispatcher sends it on a following tick). For every **active** account of an **active** tenant it queues one notice per active human Organization Admin and per window when

- the **account** is within 14 days of its expiry (`warning`), then within 3 days (`final`), and
- the **credential in use** (the current one: not rotating out, not revoked) is within the same windows, unless it ends with its account (its expiry is clamped to the account's, so the account's notice covers it).

Only the tightest window that applies is queued, so an item first seen late gets one notice. Deduplication is the outbox `dedupe_key` (`service_account_expiry:<account|credential>:<id>:<window>:<expiry epoch>:<admin>`), so the sweep may run every minute: each notice is queued once; a renewal (a new expiry) starts its own windows and the old ones are never repeated (an account extended out of the window is no longer a candidate; its credential, which keeps its own expiry, is announced instead: rotate it); a deactivated or expired account, a revoked or rotated-out credential and a suspended tenant are never announced; a recipient who lost the Organization Admin role by send time is suppressed as `not_eligible`. At most 500 notices per tick; the rest follow. The email carries **words only** (`template_params = {subject: account|credential, window: warning|final}`): "A service account in your organization expires within the next 14 days" or "...3 days", with a link to Access administration. It names no account, workspace, person or credential, so a notice about a few accounts does not say which; the page behind the link flags them ("Needs attention", "Expiring soon"). Assumption to confirm: recipients are **every** active Organization Admin, not only the account's owner, so an owner who is away does not hide an expiry; a notice per admin per item is the cost.

### Credentials

- Format `corvis_sa_<credential id, 32 hex>_<256 random bits, base64url>`. The embedded id only selects the stored record; the random part is the credential. Only the lower-case hex SHA-256 of the whole secret is stored (`secret_sha256`, unique, `CHECK` for shape). With 256 bits of entropy a fast hash resists guessing as well as a slow one, and it is what invitation and export-link tokens already use. There is no column that could hold a secret.
- **Shown once.** The secret is returned only in the response to `create`, `issue` or `rotate` (`Cache-Control: no-store`), kept only in the page's component state, and cleared when the admin confirms they have stored it. It is never logged, never in an audit event, never returned by a list or get, and not in any SQL parameter (`service-account-routes.test.ts` asserts the last two; the real-Postgres test asserts it appears in no stored row).
- **One current credential.** `rotate` issues a new credential and leaves the old one valid for an overlap of 0 to 1,440 minutes (default 60), then not at all; a second rotation ends any earlier overlap immediately, so at most two credentials are ever valid together. `issue` is only for an account with no credential in use. A current credential past its own expiry makes way for a new one.
- **Immediate revocation.** `revoke` ends every credential in use now (`status = 'revoked'`, `ends_at = now()`), including one that is rotating out. Validity is evaluated against the database clock at the point of use, so there is no cache to age out.
- **Guards in SQL.** Triggers make a credential's hash and lifetime immutable, keep a revoked credential revoked, and allow an end date only to be brought forward, so no later statement can lengthen an overlap or resurrect a credential. An account's identity fields are immutable and a disabled account stays disabled.
- **Verification (record side).** `src/modules/identity-access/server/service-accounts/service-account-credential.ts` `verifyServiceAccountCredential(secret, db)` looks the record up by the embedded id, compares the SHA-256 digests with `timingSafeEqual` (a missing record is compared against a dummy digest so a miss costs the same as a mismatch), requires the credential to be in use and its account active and unexpired, records `last_used_at` (at most once a minute), and returns the subject to resolve. Every refusal is the same `null`. It authenticates a *subject only*: roles, entitlements, data rights, the lifecycle grant and session revocation are still re-resolved by the normal authorization path.

### Who may act

Only a **person** who is an Organization Admin (`isTenantAdmin === true` and `authMethod !== 'service_account'`). It is checked at the route (`resolveServiceAccountAdmin`: `admin:manage` plus the role), in the service, and again in SQL: every function requires an active human (`oidc`/`saml`) identity holding an active `tenant_admin` membership in that tenant, so a demoted or disabled admin, an analyst, a service account and another tenant's admin are all refused (`service-accounts.sql`). `accountadmin` is refused with `403 tenant_admin_required`.

### Deactivate everywhere (C14)

`disable_service_account` is the service-account counterpart of the member **Deactivate everywhere** flow, in one transaction: the identity subject and the lifecycle grant are disabled, every membership is revoked (`valid_until = now()`), every entitlement is ended, and every credential is revoked. The account row stays as the audit record and a new account is created if one is needed again (it frees its name). The human member list and the human deactivation flow deliberately exclude service accounts (they select `oidc`/`saml` subjects only), so the two flows cannot be confused. Deactivating a *person* who created or owns an account does not touch the account: it is surfaced as needing a new owner (see "Ownership").

### Audit (C9)

Every state change writes an `audit_event` in the same transaction (target type `service_account`, target id the account id): `service_account.created`, `.credential_issued`, `.credential_rotated`, `.credential_revoked`, `.disabled`, `.extended`, `.owner_transferred`, with identifiers, role, workspace, expiry, overlap and the stated reason, never a secret. `TENANT_ACCESS_AUDIT_FILTER` includes them, so they appear in `GET /api/v1/access/audit` (and its CSV) and in the access-audit file of a full tenant export. Refused commands write nothing.

### Demo mode

`src/modules/identity-access/adapters/service-account-store.ts` enforces the same rules in memory, seeded per demo tenant with an account whose credential expires soon, one in regular use, one owned by an administrator who was deactivated (so it needs a new owner) and one deactivated. Secrets are minted and hashed exactly as in production. It is not production evidence.

## Decision needed: how a credential is accepted at the API edge

The issue says to confirm the mechanism (IdP client credentials versus a Corvis-issued token) against the Confluence page "Data Sharing, APIs & Permissioning", which was not reachable while this was built. What the repository already does for non-human identities:

1. **Production end-user path is OIDC only.** `directOidcIdentity` (`src/platform/http/identity/request-context.ts`) verifies the bearer token against the one configured IdP (`CORVIS_AUTH_ISSUER`/`_AUDIENCE`) and always sets `authMethod: "oidc"`. A service account cannot authenticate through it today.
2. **A signed identity assertion already accepts `service_account`.** `x-corvis-identity-assertion` (HMAC, at most five minutes, `verifyGatewayIdentityAssertion`) accepts `authMethod: "service_account"`; the docs describe it as the boundary for "SAML or a future identity broker", and `resolveAuthorizedRequestIdentity` re-resolves everything from Postgres afterwards. Nothing in the repository mints such an assertion for a customer's service account.
3. **The processing worker is the one existing machine caller**, and it uses a Google-issued OIDC ID token, verified for issuer, audience and exact service-account email, with the immutable Google `sub` provisioned as the `service_account` subject (`SERVICE_IDENTITY_HARDENING.md`). That is infrastructure identity, not customer identity.

The options, none of which this slice picks:

| Option | What it means | Fit with this slice |
| --- | --- | --- |
| **A. Customer IdP client credentials** | The customer's IdP issues the credential and the token; Corvis maps the token `sub` (the client id) to the account's identity subject and verifies it like an OIDC token. | Requires accepting per-customer issuers/audiences in the production path. Issue, rotate and revoke would happen in the IdP, so the credential records here would be unnecessary and only the account and its lifecycle would remain. |
| **B. Corvis-issued credential exchanged for a short-lived token** (closest to the issue wording: "issue, rotate and revoke its API credential", "last used"; not a recommendation until the decision is made) | The caller presents the credential to a Corvis exchange endpoint; `verifyServiceAccountCredential` decides, and the endpoint returns a short-lived signed assertion that the existing assertion path (point 2) accepts. | The record side is built and tested here. Missing: the exchange route, the signing-key custody and rotation for assertions, rate limiting and abuse controls on the unauthenticated exchange, and `Authorization` handling at the gateway. |
| **C. Gateway-validated API keys** | API Gateway validates the key and forwards an identity. | Needs a design for key custody and mapping; duplicates what B does in Corvis. |

**Decision (shipped in #350, #340): option B.** `POST /api/v1/auth/service-account/token` exchanges a Corvis-issued credential for a five-minute signed identity assertion (`authMethod: "service_account"`), accepted by the existing assertion path; "last used" is recorded on a successful exchange. Options A and C were not taken, so migration 088's credential table and the credential half of the screen stand.

## Assumptions to confirm

1. A service account is scoped to **one workspace and one role** (the list shows "workspace" singular, and the 009 grant is per subject). Several workspaces would be several memberships; deferred.
2. `reviewer`, `analyst` and `viewer` are the allowed roles. `accountadmin` and `tenant_admin` are excluded; the `api_client` application role exists in `src/shared/domain/enterprise.ts` but no membership role maps to it, and adding one would be the parallel scope plane #11 rules out.
3. 365 days maximum account lifetime, 90 days default credential lifetime, 14-day expiry warning, 24-hour maximum overlap (default 60 minutes), 100 active accounts per organization, a second ("final") expiry notice at 3 days and at most 200 entitlements per account. All are constants in `src/modules/identity-access/domain/service-account.ts` and the SQL function; they are product defaults, not contract terms.
4. The creating admin counts as the 009 "control reviewer", and `next_review_at = valid_until` (review and expiry coincide; there is no separate periodic review yet).
5. The credential hash is a plain SHA-256 (256-bit random secret), not a password hash.
6. `last_used_at` is recorded by `verifyServiceAccountCredential` at most once a minute per credential; the use is not itself audited (it would be a write per request). Auth failures are not recorded either.
7. Fund and document entitlements for an account are granted by an Organization Admin within the organization's data rights (F6c); the operator path remains for Corvis operations. They are read-only (`read`), in the account's one workspace, and open-ended (bounded by the account's own expiry and deactivation). People are not covered.
8. A disabled account is final and its name is reusable; there is no "re-enable".

## Verification

- `db/postgres/tests/service-accounts.sql` (CI): who may act, validation and the refused administrator roles, the rows created, hashing, quota and names, issue/rotate/revoke, expiry, the guard triggers, deactivation everywhere, tenancy, RLS enabled and forced with no client policy.
- `db/postgres/tests/service-accounts.mjs` (CI): the same through the application backend with the real authorization lookup, credential verification (overlap, revocation, expiry, constant-shape refusals), no secret in any stored row, access review, human member list exclusion and the tenant access audit.
- `src/modules/identity-access/server/service-account*.test.ts`, `src/modules/identity-access/domain/service-account.test.ts`, `src/platform/http/security/route-authorization.test.ts`, `src/platform/database/sql-application-errors.test.ts`: behaviour at 100% line/branch/function coverage.
- `db/postgres/tests/service-accounts.sql` and `.mjs` also cover F6c and F6d: the data-right and ownership tests, the one refusal message, the 200 bound, revocation after a right lapses, resolution through the real authorization lookup, once-per-window notices with exact counts, renewal, deactivation, suspended tenants, mandatory-ness, words-only sent emails and send-time suppression.
- `src/modules/identity-access/server/service-accounts/service-account-expiry-sweep.test.ts`, `src/modules/notifications/domain/notifications.test.ts`: the sweep's bound and silence, and the template (no names, mandatory footer).
- `e2e/admin/service-accounts.spec.ts`, `e2e/quality/access-pages-accessibility.spec.ts`: the screens end to end in demo mode (create, shown once, rotate, revoke, deactivate, expiry flag) and axe in both colour schemes.

## Remaining work (proposed follow-up issues)

1. ~~Credential verification path~~ Shipped (#340, #350: option B, see "Decision" above). Still open: usage visibility beyond "last used" (count, last source) and an e2e through the real gateway for a rotated-out credential at the end of its overlap (covered today at the SQL/application level in `service-accounts.mjs` and `service-account-exchange.test.ts`).
2. ~~Account renewal and ownership~~ Shipped (F6b, #341; see above). Still open: a periodic review separate from expiry.
3. ~~Expiry notifications~~ Shipped (F6d, #341; see above). Still open: **usage visibility**, recent use (count and last source) without writing per request, which needs the credential verification path.
4. ~~Customer entitlement self-service for service accounts~~ Shipped (F6c, #342; see above). Still open: the same for **people**.
5. **Multi-workspace accounts and the `accountadmin` role decision**.
