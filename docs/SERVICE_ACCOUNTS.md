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
| `axe-core` coverage of the screens | Shipped (`e2e/access-pages-accessibility.spec.ts`, light and dark) |
| Record-side credential check (`verifyServiceAccountCredential`: constant-time compare, immediate revocation, rotation overlap, expiry, last-used) | Shipped and tested, **not called by any request path** |
| **Accepting a credential on an API request** | **Not shipped. Decision needed (below).** |
| Extend an account's expiry (audited; advances the 009 `next_review_at` with it, within the 365-day maximum) | Shipped (F6b, migration 092) |
| An owner on every account, transfer to another active Organization Admin, and a rule for an owner who is deactivated | Shipped (F6b) |
| Expiry notifications, a "last used from" source | Not shipped (follow-ups) |

Until the decision is made and implemented, a credential issued here is stored and managed but **does not authenticate any request**. The screen says so in a visible note, so no one is led to believe it works. Nothing is half-wired in the other direction either: no request path can accept a credential by accident, because none reads these tables.

## Design

### One identity model, no parallel API-scope plane (#11)

A service account is **not** a new kind of principal with its own scopes. Creating one (`corvis_control.create_service_account`, one statement) writes exactly the rows the existing authorization lookup (`lib/server/authorization.ts`) already resolves for an `auth_method = 'service_account'` subject:

- `identity_subject` (`subject = 'service-account:<id>'`, a fresh `user_id`),
- one `membership` in the chosen workspace with one of `reviewer`, `analyst`, `viewer`, ending when the account does,
- one `service_identity_grant` (migration 009: purpose, finite validity, review window; `reviewed_by_subject` is the creating admin; `next_review_at = valid_until`),

plus `service_account` (the managed record: name, purpose, creator, expiry) and `service_account_credential`. The lookup therefore enforces, for a service account, exactly what it enforces for a person: active identity, active membership and workspace, the lifecycle grant (a missing, expired, overdue-for-review or disabled grant denies), session revocation, resource entitlements and contractual data rights. `db/postgres/tests/service-accounts.mjs` proves this through the real `PostgresMembershipAuthorizationRepository`, including that creating an account grants no fund or document access.

**Roles.** A service account holds only `reviewer` (Review Analyst), `analyst` or `viewer`. It can never hold `tenant_admin` or `accountadmin`: the SQL function and the table's own `CHECK` refuse any other role, so a machine is never an administrator and can never reach `/api/v1/access/**` (which also refuses `authMethod = 'service_account'` explicitly). Whether to allow `accountadmin` is a product decision, defaulted closed.

**Data access.** Creating an account grants no fund or document entitlement and changes no data right. As for people, fund and document entitlements are granted by Corvis operations through the existing operator path (`POST /api/v1/admin/access-policy`, which is limited to the operations tenant), addressed to the account's *identity reference* (its `user_id`, shown on each account). Until then the account sees nothing. A customer-self-service entitlement editor does not exist for people either, and is out of scope here.

**Lifetime.** An account's expiry is at most 365 days away (009's rule: finite, never open-ended), at creation and again at every extension (below). A credential defaults to 90 days, is clamped to its account's expiry when issued, and is flagged "Needs attention / Expiring soon" within 14 days of expiring (the account itself is flagged the same way).

### Renewal: extend expiry (F6b, #341)

An Organization Admin extends an account with `{ action: "extend", expiresInDays }` (1 to 365, default 365, counted from the moment of the extension). `corvis_control.extend_service_account` requires the new expiry to be at least a day later than the current one (an account about a year out cannot be "extended" by minutes; the screen shows the minimum and refuses less before sending), later than now, and at most 366 days from now (365 plus the day of grace creation allows), and moves, in one statement: the account's `expires_at`, its membership's `valid_until`, and its 009 lifecycle grant (`valid_until`, `next_review_at` and a fresh `reviewed_at`/`reviewed_by_subject`: an extension is a review). So the authorization lookup keeps resolving the account exactly as long as the account says it does. A **credential keeps its own expiry** (it was clamped to the account's at issue time): an extended account issues or rotates a credential as usual. An account that already expired can be extended (then given a credential again); a deactivated one cannot (`409 service_account_not_active`), and nothing but this function can change an expiry (a guard trigger refuses any other update, and any shortening). The audit event is `service_account.extended` with `previousExpiresAt`, `expiresAt` and `nextReviewAt`.

### Ownership (F6b, #341)

Every account has an **owner**, an active Organization Admin who answers for it (`owner_subject`, `owner_user_id`, `owner_assigned_at`). The creating admin is the first owner (existing accounts were backfilled with their creator); `created_by_*` stays as history. `{ action: "transfer", ownerSubject }` hands the account to **another active Organization Admin** (`corvis_control.transfer_service_account_owner`; the people on offer are the `owners` in the list response, computed by the same SQL test `service_account_owner_active`: an active human `oidc`/`saml` identity with an active `tenant_admin` membership). Any Organization Admin can transfer, including to themselves; the owner must differ from the current one (`409 service_account_owner_unchanged`), must be eligible (`422 service_account_owner_invalid`), and a deactivated account cannot change hands. Audit event `service_account.owner_transferred` with `previousOwner` and `ownerSubject`.

**When the owner is deactivated or loses the Organization Admin role**, the account is **not silently orphaned and not disabled**: its credentials keep working, `ownerActive` turns false and `needsOwner` true, the list shows "Needs attention" and "Needs a new owner" with the former owner named, and **it is not extended until an active admin takes it over** (`409 service_account_needs_owner`; the UI hides Extend and makes "Assign a new owner" the primary action). Rotating, issuing, revoking and deactivating stay available, so an ownerless account can always be made safe. Assumption to confirm: ownerless accounts are blocked from *renewal* only, not from credential rotation, so a security response never waits on finding an owner.

### Credentials

- Format `corvis_sa_<credential id, 32 hex>_<256 random bits, base64url>`. The embedded id only selects the stored record; the random part is the credential. Only the lower-case hex SHA-256 of the whole secret is stored (`secret_sha256`, unique, `CHECK` for shape). With 256 bits of entropy a fast hash resists guessing as well as a slow one, and it is what invitation and export-link tokens already use. There is no column that could hold a secret.
- **Shown once.** The secret is returned only in the response to `create`, `issue` or `rotate` (`Cache-Control: no-store`), kept only in the page's component state, and cleared when the admin confirms they have stored it. It is never logged, never in an audit event, never returned by a list or get, and not in any SQL parameter (`service-account-routes.test.ts` asserts the last two; the real-Postgres test asserts it appears in no stored row).
- **One current credential.** `rotate` issues a new credential and leaves the old one valid for an overlap of 0 to 1,440 minutes (default 60), then not at all; a second rotation ends any earlier overlap immediately, so at most two credentials are ever valid together. `issue` is only for an account with no credential in use. A current credential past its own expiry makes way for a new one.
- **Immediate revocation.** `revoke` ends every credential in use now (`status = 'revoked'`, `ends_at = now()`), including one that is rotating out. Validity is evaluated against the database clock at the point of use, so there is no cache to age out.
- **Guards in SQL.** Triggers make a credential's hash and lifetime immutable, keep a revoked credential revoked, and allow an end date only to be brought forward, so no later statement can lengthen an overlap or resurrect a credential. An account's identity fields are immutable and a disabled account stays disabled.
- **Verification (record side).** `lib/server/service-account-credential.ts` `verifyServiceAccountCredential(secret, db)` looks the record up by the embedded id, compares the SHA-256 digests with `timingSafeEqual` (a missing record is compared against a dummy digest so a miss costs the same as a mismatch), requires the credential to be in use and its account active and unexpired, records `last_used_at` (at most once a minute), and returns the subject to resolve. Every refusal is the same `null`. It authenticates a *subject only*: roles, entitlements, data rights, the lifecycle grant and session revocation are still re-resolved by the normal authorization path.

### Who may act

Only a **person** who is an Organization Admin (`isTenantAdmin === true` and `authMethod !== 'service_account'`). It is checked at the route (`resolveServiceAccountAdmin`: `admin:manage` plus the role), in the service, and again in SQL: every function requires an active human (`oidc`/`saml`) identity holding an active `tenant_admin` membership in that tenant, so a demoted or disabled admin, an analyst, a service account and another tenant's admin are all refused (`service-accounts.sql`). `accountadmin` is refused with `403 tenant_admin_required`.

### Deactivate everywhere (C14)

`disable_service_account` is the service-account counterpart of the member **Deactivate everywhere** flow, in one transaction: the identity subject and the lifecycle grant are disabled, every membership is revoked (`valid_until = now()`), every entitlement is ended, and every credential is revoked. The account row stays as the audit record and a new account is created if one is needed again (it frees its name). The human member list and the human deactivation flow deliberately exclude service accounts (they select `oidc`/`saml` subjects only), so the two flows cannot be confused. Deactivating a *person* who created or owns an account does not touch the account: it is surfaced as needing a new owner (see "Ownership").

### Audit (C9)

Every state change writes an `audit_event` in the same transaction (target type `service_account`, target id the account id): `service_account.created`, `.credential_issued`, `.credential_rotated`, `.credential_revoked`, `.disabled`, `.extended`, `.owner_transferred`, with identifiers, role, workspace, expiry, overlap and the stated reason, never a secret. `TENANT_ACCESS_AUDIT_FILTER` includes them, so they appear in `GET /api/v1/access/audit` (and its CSV) and in the access-audit file of a full tenant export. Refused commands write nothing.

### Demo mode

`adapters/demo/service-account-store.ts` enforces the same rules in memory, seeded per demo tenant with an account whose credential expires soon, one in regular use, one owned by an administrator who was deactivated (so it needs a new owner) and one deactivated. Secrets are minted and hashed exactly as in production. It is not production evidence.

## Decision needed: how a credential is accepted at the API edge

The issue says to confirm the mechanism (IdP client credentials versus a Corvis-issued token) against the Confluence page "Data Sharing, APIs & Permissioning", which was not reachable while this was built. What the repository already does for non-human identities:

1. **Production end-user path is OIDC only.** `directOidcIdentity` (`lib/server/request-context.ts`) verifies the bearer token against the one configured IdP (`CORVIS_AUTH_ISSUER`/`_AUDIENCE`) and always sets `authMethod: "oidc"`. A service account cannot authenticate through it today.
2. **A signed identity assertion already accepts `service_account`.** `x-corvis-identity-assertion` (HMAC, at most five minutes, `verifyGatewayIdentityAssertion`) accepts `authMethod: "service_account"`; the docs describe it as the boundary for "SAML or a future identity broker", and `resolveAuthorizedRequestIdentity` re-resolves everything from Postgres afterwards. Nothing in the repository mints such an assertion for a customer's service account.
3. **The processing worker is the one existing machine caller**, and it uses a Google-issued OIDC ID token, verified for issuer, audience and exact service-account email, with the immutable Google `sub` provisioned as the `service_account` subject (`SERVICE_IDENTITY_HARDENING.md`). That is infrastructure identity, not customer identity.

The options, none of which this slice picks:

| Option | What it means | Fit with this slice |
| --- | --- | --- |
| **A. Customer IdP client credentials** | The customer's IdP issues the credential and the token; Corvis maps the token `sub` (the client id) to the account's identity subject and verifies it like an OIDC token. | Requires accepting per-customer issuers/audiences in the production path. Issue, rotate and revoke would happen in the IdP, so the credential records here would be unnecessary and only the account and its lifecycle would remain. |
| **B. Corvis-issued credential exchanged for a short-lived token** (closest to the issue wording: "issue, rotate and revoke its API credential", "last used"; not a recommendation until the decision is made) | The caller presents the credential to a Corvis exchange endpoint; `verifyServiceAccountCredential` decides, and the endpoint returns a short-lived signed assertion that the existing assertion path (point 2) accepts. | The record side is built and tested here. Missing: the exchange route, the signing-key custody and rotation for assertions, rate limiting and abuse controls on the unauthenticated exchange, and `Authorization` handling at the gateway. |
| **C. Gateway-validated API keys** | API Gateway validates the key and forwards an identity. | Needs a design for key custody and mapping; duplicates what B does in Corvis. |

Either way, "last used" stays `Never` and no credential works until the chosen path is built. If the decision is A, migration 088's credential table and the credential half of the screen should be removed before release (the account half stands).

## Assumptions to confirm

1. A service account is scoped to **one workspace and one role** (the list shows "workspace" singular, and the 009 grant is per subject). Several workspaces would be several memberships; deferred.
2. `reviewer`, `analyst` and `viewer` are the allowed roles. `accountadmin` and `tenant_admin` are excluded; the `api_client` application role exists in `core/enterprise.ts` but no membership role maps to it, and adding one would be the parallel scope plane #11 rules out.
3. 365 days maximum account lifetime, 90 days default credential lifetime, 14-day expiry warning, 24-hour maximum overlap (default 60 minutes), 100 active accounts per organization. All are constants in `core/service-account.ts` and the SQL function; they are product defaults, not contract terms.
4. The creating admin counts as the 009 "control reviewer", and `next_review_at = valid_until` (review and expiry coincide; there is no separate periodic review yet).
5. The credential hash is a plain SHA-256 (256-bit random secret), not a password hash.
6. `last_used_at` is recorded by `verifyServiceAccountCredential` at most once a minute per credential; the use is not itself audited (it would be a write per request). Auth failures are not recorded either.
7. Fund and document entitlements for an account remain an operator action, as for people.
8. A disabled account is final and its name is reusable; there is no "re-enable".

## Verification

- `db/postgres/tests/service-accounts.sql` (CI): who may act, validation and the refused administrator roles, the rows created, hashing, quota and names, issue/rotate/revoke, expiry, the guard triggers, deactivation everywhere, tenancy, RLS enabled and forced with no client policy.
- `db/postgres/tests/service-accounts.mjs` (CI): the same through the application backend with the real authorization lookup, credential verification (overlap, revocation, expiry, constant-shape refusals), no secret in any stored row, access review, human member list exclusion and the tenant access audit.
- `lib/server/service-account*.test.ts`, `core/service-account.test.ts`, `lib/server/route-authorization.test.ts`, `lib/server/sql-application-errors.test.ts`: behaviour at 100% line/branch/function coverage.
- `e2e/service-accounts.spec.ts`, `e2e/access-pages-accessibility.spec.ts`: the screens end to end in demo mode (create, shown once, rotate, revoke, deactivate, expiry flag) and axe in both colour schemes.

## Remaining work (proposed follow-up issues)

1. **Credential verification path** (blocked on the decision above): the exchange endpoint (option B) or IdP mapping (option A), assertion-signing key custody, rate limiting and abuse controls, calling `verifyServiceAccountCredential`, an e2e that a rotated-out credential stops working at the end of its overlap, and removing the "not yet accepted" notice.
2. ~~Account renewal and ownership~~ Shipped (F6b, #341; see above). Still open: a periodic review separate from expiry.
3. **Expiry notifications and usage visibility**: notify Organization Admins before a credential or account expires, and show recent use (count and last source) without writing per request.
4. **Customer entitlement self-service for service accounts**: let an Organization Admin grant fund/document entitlements to an account (and people) within their data rights.
5. **Multi-workspace accounts and the `accountadmin` role decision**.
