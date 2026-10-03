# Source acquisition connectors

This document is the technical source of truth for automated acquisition of authorized customer documents from GP portals, data rooms and similar external repositories. Confluence owns the business/source-right requirements; GitHub owns connector implementation, credential handling, runtime isolation and operational behavior.

## Implementation status

**Landed:** `db/postgres/migrations/018_source_connectors.sql` defines the
tenant-scoped connection/run/acquisition schema (RLS on every table;
`source_connection` is server-only with no client SELECT policy at all,
and its `secret_reference` column is constrained to a format that binds
the tenant id directly into the Secret Manager resource name). `lib/server/source-connectors.ts`
implements the connection lifecycle (create with mandatory scope
confirmation, list with the secret reference always redacted, test,
pause/resume, revoke, reauthorize) behind a `SecretStore` port so credential
material is written through the port before Postgres ever sees anything but
a reference, and reauthorization revokes the prior secret. `lib/server/source-connector-sync.ts`
implements one discovery-and-acquisition cycle behind a `ConnectorDriver`
port: it fails closed before ever calling the driver for anything but an
`active` connection, computes the idempotent `acquisitionKey` from remote
id + remote version + content hash (so a genuine remote content
replacement is retained as a new acquisition rather than either being
skipped or overwriting the prior one), and classifies every driver error
into one of the contracted classes. A fail-closed class
(`auth`/`reauthorization`/`permission`/`provider_change`/`validation`) —
whether raised at discovery or while downloading a single document —
aborts the whole run and moves the connection to `reauthorization_required`
or `suspended` rather than retrying it forever or looking like one rejected
file; any other per-document download failure is instead recorded as a
rejection and the run continues. All of this is covered by `lib/server/source-connectors.test.ts`,
`lib/server/source-connector-sync.test.ts` and
`lib/server/source-connectors-contract.test.ts` (cross-tenant isolation,
secret redaction, idempotent duplicate/replacement discovery, error-class
routing, and the migration's own RLS/constraint contract).

**Implemented since this module landed:** `GcpSecretManagerSecretStore`
(`lib/server/source-connector-runtime.ts`) is the production `SecretStore`, and
the customer/admin routes under `app/api/v1/source-connections/**` (list,
create, test, pause/resume/revoke via `PATCH`, reauthorize, activity) call the module above.
The Documents view now has a **Source connections** section for administrators
(stories B5 #252 and B8 #253); see "Customer connection list and controls" below.
The **Connect source** wizard (story B1 #251) creates and tests a connection from
that section; see "Connect source wizard" below.

**Not yet implemented — the next integration step, in order:**
1. At least one real `ConnectorDriver` for an approved representative
   provider. `sourceConnectorDrivers()` is currently an empty registry, so a
   connection test or sync resolves to `unregistered_provider`. An
   `IngestSink` implementation must feed an accepted download into the
   existing upload/document-registration pipeline (`lib/server/uploads.ts`)
   instead of a parallel path.
2. Scheduling (Cloud Scheduler/Cloud Tasks or equivalent) that calls
   `runConnectionSync` for each due `active` connection using
   `source_connection.next_scheduled_at`. `runConnectionSync` has no caller
   outside tests today.
3. ~~A customer-facing `Connect source` flow and a connection-test button~~ —
   done as the provider-neutral wizard below, exercised with labelled demo
   providers. What remains is everything specific to the first real provider
   (its `ConnectorDriver`, its `SourceOAuthClient` if it uses OAuth, its
   disclosure copy and its certification as an approved provider) and OAuth
   *re*authorization; see "Connect source wizard → Remaining".
4. Provider-specific UAT fixtures per the "Testing" section below, run
   against synthetic/test portal accounts.

Building 1–4 unlocks the customer-facing `Connect source` flow this
document otherwise describes; until then this is a tested, reusable
foundation, not a working connector.

## Customer connection list and controls

`features/documents/source-connections-section.tsx` renders one card per connection in the Documents view. It is shown only to administrators of the workspace: the page gates on `admin:manage`, and an HTTP 403 from `GET /api/v1/source-connections` renders nothing, exactly like the run-history section. All wording comes from `core/source-connection-health.ts`, which is pure and unit-tested.

- **Status and the one next action.** Every `ConnectorErrorClass` has plain-language copy and exactly one required action (`CONNECTOR_ERROR_COPY`); a compile-time and run-time contract test (`lib/server/source-connection-health-contract.test.ts`) fails when a class is added to the server without copy. `reauthorization_required` ("Needs reauthorization") and `suspended` ("Suspended") are separate from transient failures ("Retrying", told to wait) in label, icon and border style. No stored enum, provider key or secret reference is rendered.
- **Stale.** An `active` connection with no successful sync in the last 48 hours (`STALE_AFTER_HOURS`), or never synced 48 hours after its scope was confirmed, is stale: a `Stale` pill, a clock icon, a dotted border and the sentence "No successful sync for N days". Other states are never stale.
- **Next sync is not invented.** No scheduler calls `runConnectionSync` yet, so an active connection reads "Scheduled sync is not enabled yet"; paused, revoked, suspended and reauthorization-required connections say why sync is stopped. When a scheduler lands, this becomes data-driven in `describeConnection`.
- **Controls.** Pause (from `active` or `reauthorization_required`), Resume (from `paused`), Reauthorize (any live connection; a paused one stays paused) and Revoke (terminal) call `PATCH /api/v1/source-connections/{id}` and `POST …/reauthorize`. The transition rules live once in `connectionTransition` (core) and are used by the Postgres path, the demo store and the UI. Revoke uses the same modal destructive-confirmation pattern as the admin console (Cancel focused first) and lists exactly what stops and what is retained. After a command the list is reloaded, focus moves to the affected connection and the result is announced in a `role="status"` region.
- **Reauthorize payload.** `scoped_api_token` and `browser_session` send `{ "secret": { "token": "<value>" } }`; `service_account` and `oauth_client_credentials` send the pasted JSON object as `secret`. The field is masked, uncontrolled, `autocomplete="off"`, read once on submit and emptied immediately (also on failure and close); it is never rendered back, stored in the browser or echoed by the API. A connection that signs in with OAuth (`oauth_authorization_code`) has nothing to type: **Reauthorize** opens a dialog that sends the administrator through the provider's consent page again (see "Reauthorizing an OAuth connection" below), and the API refuses a pasted credential for it (`409 oauth_reauthorization_required`).
- **Run history link.** Each card links to its row in the existing "Source run history" section (focus moves to the row). That section now uses plain words for run states, outcomes and failure classes.
- **Attention.** The `source_attention` notification is a one-shot email (see `docs/NOTIFICATIONS.md`); the in-app attention banner is derived from live status and clears when the connection is reauthorized.
- **Audit.** Every command writes `source_connection.<action>` in the same transaction as the change, and the tenant access audit (`GET /api/v1/access/audit`, JSON and CSV) lists them.
- **Demo mode.** With `CORVIS_DEMO_MODE` the routes are served from an in-memory store (`adapters/demo/source-connection-store.ts`) seeded per demo tenant with healthy, stale, paused, reauthorization-required, suspended, transient-failure and revoked connections. It applies the same transition rules and never holds a credential. Production refuses demo mode.

## Connect source wizard

`features/documents/connect-source-wizard.tsx`, opened by **Connect source** in the Source connections section (administrators only; the section does not exist for anyone the API refuses with HTTP 403). It is a dialog of four steps, each with its own heading that takes focus when the step appears:

1. **Choose a source** lists only *approved* providers, each with a one-line access description (and a `Demo` pill for demonstration providers). When none is approved it says so honestly and offers Contact support; it never offers a provider that cannot be tested.
2. **Review what Corvis will access** shows, in plain language (no JSON, no stored identifiers), what is read (and the folders in scope), how the connection behaves and what Corvis will not do. The administrator names the connection and must tick the confirmation ("I am authorized to give Corvis access…"). Neither a credential field nor a redirect exists before this is confirmed; the server also refuses a request without `scopeConfirmed: true`.
3. **Authorize**: either *Authorize with the provider* (OAuth: a redirect through the provider's own consent page and back) or *Enter the credential* (a masked, uncontrolled field that is read once on submit and emptied immediately; it is never held in React state, rendered back, kept in browser storage, logged or echoed by the API).
4. **Test**: Corvis tests the connection automatically after authorization. A pass shows *Connection verified*; a failure shows *The connection test did not pass* with a plain reason and the one next step from `describeTestFailure` (core/source-connect-wizard.ts, built on `CONNECTOR_ERROR_COPY`), and says that scheduled collection stays off. A test can also be run on demand with **Test connection** on any live connection card.

**Failure blocks scheduled sync.** A connection is created `pending_authorization` and only a *passing* test moves it to `active` (`testAuditedSourceConnection`); a failed first test leaves it `pending_authorization` (transient or unclassified failure), `reauthorization_required` (auth) or `suspended` (permission/provider change), and `runConnectionSync` refuses every connection that is not `active`. A pending connection shows "Run a connection test to finish setup" and a primary Test connection button.

**Provider registry.** `lib/server/source-providers.ts` is the only source of approved providers: `registerApprovedSourceProvider(provider, driver)` approves a certified provider and registers its `ConnectorDriver` together, so a provider can never be offered without the means to test it. The registry is **empty** until the first customer-required provider is certified (#31); no real-vendor driver exists. In demo mode (never production) two clearly labelled providers are added from `adapters/demo/source-providers.ts` so the whole flow can be exercised end to end: *Demo GP portal (API token)* (valid token `demo-valid-token`; `demo-invalid-token`, `demo-no-access` and `demo-unreachable` reach the failed-test states) and *Demo data room (sign-in with OAuth)*, whose consent page is `GET /api/v1/source-connections/oauth/demo-consent` (404 outside demo mode, same-origin redirects only). Scope, credential type and connector version always come from the registry, never from the request.

**Routes** (all `admin:manage`, workspace-scoped, audited; see `lib/server/route-authorization.test.ts`):

| Route | Purpose |
| --- | --- |
| `GET /api/v1/source-connections/providers` | Approved providers as browser-safe descriptors (no OAuth client, no connector version). |
| `POST …/connect` | Direct-credential path: `{ providerKey, connectionLabel, scopeConfirmed: true, secret }` → `201 { connection, test }`. The secret goes to the `SecretStore`; Postgres keeps only the reference. |
| `POST …/oauth/start` | `{ providerKey, connectionLabel, scopeConfirmed: true }` to connect, or `{ sourceConnectionId }` to renew an existing connection's authorization → `{ authorizationUrl }` plus an HttpOnly, SameSite=Lax cookie pointing at the pending attempt. |
| `POST …/oauth/complete` | `{ code, state }` (or `{ denied: true }`) → `201 { outcome: "connected", connection, test }`, `200 { outcome: "reauthorized", connection, test }` for a renewal, or `{ outcome: "denied" }`. |
| `POST …/{id}/test` | On-demand test → `{ ok, errorClass? }`. Driver detail text never reaches the browser. |

**OAuth contract** (`lib/server/source-oauth.ts`, provider-neutral). A provider implements `SourceOAuthClient` (`authorizationUrl`, `exchangeCode`). Corvis generates `state` and the PKCE verifier (S256) server-side and keeps them, with the tenant, administrator and workspace that started the attempt, in the secret store with a 10-minute TTL (`SecretWriteOptions.ttlSeconds`, a Secret Manager `ttl`); the browser holds only an opaque pointer. The provider redirects to `/?source_oauth=return&code=…&state=…`; the page lands on Documents, removes the parameters from the URL at once and the wizard posts them to `oauth/complete`. The attempt is validated (tenant in the secret's resource name, same administrator and workspace, constant-time `state` match, unexpired) and destroyed whatever the outcome, so a replayed redirect finds nothing; every failure is the same `oauth_attempt_invalid`. The code is then exchanged server-side with the verifier and the resulting tokens go straight to the secret store. No migration was needed: pending attempts are short-lived secrets, not rows.

### Reauthorizing an OAuth connection (B1b, #345)

**Reauthorize** on an `oauth_authorization_code` card starts the same two-leg flow as the wizard, for that connection. `POST …/oauth/start` takes only `{ sourceConnectionId }`: the provider and the confirmed scope are already recorded, so nothing is re-asked and the scope cannot change. The pending attempt (state and PKCE verifier in the secret store, 10-minute TTL) additionally records the connection id; the provider redirects back as for a new connection, the wizard dialog resumes, and `POST …/oauth/complete` exchanges the code and then, instead of creating a connection, rotates the connection's secret through `reauthorizeAuditedSourceConnection` (new secret written first, compare-and-set on the old reference, audit `source_connection.reauthorize`, old secret destroyed only afterwards) and runs the connectivity test straight away (`200 { outcome: "reauthorized", connection, test }`). A paused connection stays paused. A passing test leaves the connection `active`; a failing one is reported with its class and moves the connection the way the test rules say (an `auth` failure leaves it `reauthorization_required`). Refused before anything is written: a revoked connection (`409 connection_revoked`), a connection of another workspace or organization (`404`), one that does not sign in with OAuth (`400`), and a provider that is no longer approved (`422`). A decline at the provider changes nothing (the card keeps its status; the dialog says nothing was connected or changed). The demo OAuth provider serves this end to end: the seeded *Summit virtual data room* connection (suspended) is renewed through the demo consent page and is active again (`e2e/connect-source.spec.ts`).

**Token expiry and refresh** (`lib/server/source-oauth.ts`, provider-neutral). The credential stored for an OAuth connection may carry `expiresAt` (epoch milliseconds) and `refreshToken`; a `SourceOAuthClient` may implement the optional `refresh({ refreshToken })`. Before a connectivity test (and, through the `resolveCredential` hook of `runConnectionSync`, before a sync run) `freshOAuthCredential` decides: no `expiresAt` or more than a minute left, use the credential as it is; expired or about to expire with a refresh token and a provider that can refresh, call the provider and use the replacement (the previous refresh token is kept unless the provider rotates it); if the provider refuses the refresh the credential is still used while it has time left, and once it has expired the call fails with `OAuthCredentialExpiredError` (connector error class `reauthorization`), so the test reports it and the connection moves to **Needs reauthorization**. A refreshed credential is stored as a new secret and swapped in with a compare-and-set on the old reference (audit `source_connection.token_refresh`, old secret destroyed after the swap; a lost race destroys the replacement and uses it for that call only). Only OAuth credentials are ever refreshed. No real vendor is involved: the demo provider issues one-hour tokens with a refresh token so the path is exercised in tests.

### Connect-flow hardening (B1d, #347)

- **Audit.** Starting an OAuth sign-in (`source_connection.oauth_start`) and declining it at the provider (`source_connection.oauth_declined`) are audited with the provider key (target: the connection being renewed, else the provider key) and appear in the tenant access audit; creating, testing, reauthorizing and refreshing were already audited. A decline that does not name an attempt of this administrator records nothing. The audit write is not best-effort: the start fails if its evidence cannot be written.
- **Attempt budget.** Each administrator may start 10 connect attempts per 10 minutes (`lib/server/source-connect-limits.ts`; a credential connect, an OAuth start and the start of a reauthorization all count; finishing a sign-in and malformed requests do not), then `429` with `Retry-After`. The counter is process-local like the SCIM limiter, under the per-tenant API budget every request already spends.
- **Duplicate guard.** A workspace that already has a live (not revoked) connection to a provider cannot connect it again: `409 source_connection_already_exists`, checked at the start of a sign-in and again when a connection would be created, so two sign-ins started before either finished cannot both succeed. A revoked connection does not block a new one. The check is application-level (a unique partial index would need a migration): two truly simultaneous connects can in principle both pass it, which is why the creation path re-checks.
- **Pending-attempt secrets.** Secret Manager deletes a pending attempt by itself (`ttl`). A store without native expiry implements the optional `SecretStore.sweepExpired`; the in-process placeholder honors `ttlSeconds` on read and on this sweep, which the private delivery tick (`POST /api/internal/delivery`, task `sourceSecretSweep`) runs. The sweep only touches a store the process already holds, so it never selects a store just to sweep it and is a no-op under Secret Manager. A real non-TTL store must implement `sweepExpired` before it can be selected.
- **Dev reload.** The driver registry, the approved-provider registry and the rate-limit counters live on `globalThis`, like the placeholder secret store, so `next dev` re-evaluating a module cannot drop a registered provider or hand an administrator a fresh budget mid-flow. They hold data and plain functions only. Anything that throws a class the routes test with `instanceof` (the demo service-account store and its `ServiceAccountError`) is deliberately **not** moved there: a store that outlives its module evaluation throws the previous copy of the class and the route answers 500 instead of 409.

**Remaining** (not part of this slice; each is provider-specific or a separate story): a real `ConnectorDriver`, `SourceOAuthClient` (including its `refresh`), disclosure copy and certification for the first required provider; provider redirect-URI registration; turning the scheduler on (and wiring `resolveCredential` with its system identity), after which a connected connection starts syncing; optional customer scope selection.

## Goal

Corvis may provide customer-configured source connectors that automatically collect authorized investment-reporting documents and feed them into the same immutable ingestion and extraction pipeline used for customer uploads.

```text
Customer portal
  ↓ connect source / authorize
Corvis customer application
  ├─ connection metadata → Postgres
  └─ credential/token material → GCP Secret Manager
          ↓
Source connector worker / Cloud Run Job
          ↓ authorized GP portal / data room
discover → download → deduplicate → register source
          ↓
GCS immutable source evidence
          ↓
standard Corvis extraction / review / publication pipeline
```

The connector is an acquisition adapter. It does not bypass source authorization, tenant isolation, document validation, malware controls, lineage, review or publication rules.

## Supported source patterns

Prefer source mechanisms in this order when the external system supports them:

1. provider API / OAuth authorization;
2. scoped service account or API token;
3. sanctioned repository integration;
4. browser automation using customer-authorized credentials when no supported API exists and the portal permits the workflow.

Potential connector families include GP investor portals, virtual data rooms, fund-administrator portals and sanctioned customer document repositories.

A portal-specific connector must not become a product/business semantic dependency. Provider-specific authentication, navigation and download logic stays behind a stable source-acquisition contract.

## Customer setup flow

The customer-facing platform should support a `Connect source` workflow:

1. authenticated customer administrator chooses a supported portal/provider;
2. Corvis displays the requested permissions, source scope and expected automation behavior;
3. customer confirms that it is authorized to provide/use the credentials and instruct Corvis to access the source;
4. customer completes OAuth/consent where available, or submits the minimum credential material required by the approved connector;
5. secret material is written directly to the runtime secret store; it must not be returned to the browser after setup;
6. Postgres stores only non-secret connection metadata plus the secret reference;
7. Corvis performs a scoped connectivity test and shows the customer the result;
8. the customer can pause, reauthorize, rotate or revoke the connection from the platform.

Do not make customer source credentials GitHub Environment secrets. GitHub secrets are deployment/bootstrap credentials; customer credentials are tenant runtime secrets.

## Credential storage

### Secret material

Store password/token/refresh-token/private credential material in **GCP Secret Manager** or an equivalent approved managed secret store. Secrets must:

- be tenant/connection scoped;
- be encrypted at rest and in transit;
- be accessible only to the connector execution identity that needs them;
- never appear in application logs, tracing, analytics, prompts or error payloads;
- never be persisted in Postgres plaintext columns;
- never be copied into GitHub, Terraform source, workflow artifacts or build output;
- support versioning/rotation/revocation and auditable access.

Prefer one secret resource per source connection or another design that preserves equivalent tenant isolation and least privilege.

### Postgres metadata

Postgres may store non-secret metadata such as:

```text
source_connection_id
tenant_id
provider_key
connection_label
source_scope
secret_reference
credential_type
status
created_by
last_authorized_at
last_success_at
last_attempt_at
last_error_class
next_scheduled_at
connector_version
```

The secret reference is not itself sufficient authorization to read the secret; IAM remains the enforcement boundary.

## Authentication rules

- Prefer OAuth and revocable scoped tokens over reusable passwords.
- Request the minimum permissions necessary for document discovery/download.
- Do not bypass MFA, CAPTCHA, anti-bot controls or provider security mechanisms.
- If a provider requires interactive MFA that cannot be lawfully/securely automated, mark the connector `reauthorization_required` and ask the customer to reauthenticate through the Corvis portal.
- Browser automation is permitted only for an approved connector where customer authorization and the portal/provider terms allow it.
- Never send source credentials or session tokens to an LLM/model.
- Do not use a Corvis employee's personal portal account as the production integration credential.

## Connector execution

Run portal acquisition as an isolated background workload, normally a Cloud Run Job or worker, with a dedicated service identity.

Each run should:

1. resolve the tenant-scoped source connection;
2. fetch the credential at runtime from Secret Manager;
3. authenticate to the approved external source;
4. discover only the authorized folders/funds/report types;
5. collect stable remote IDs, names, modification/version metadata and hashes where available;
6. identify new/changed documents idempotently;
7. download into controlled temporary storage/memory;
8. write the accepted source artifact to the tenant-scoped GCS ingestion path;
9. execute the normal integrity/signature/malware/quarantine checks;
10. register the immutable document/source lineage and emit the normal downstream event only after acceptance;
11. record run status, counts, latency and errors without credential leakage;
12. discard temporary sessions/files after the governed run boundary.

Connector downloads must enter the **same** document registry and downstream processing lifecycle as customer-uploaded documents. Do not build a parallel extraction path for portal-acquired documents.

## Idempotency and source lineage

A connector should retain enough external provenance to prove where each artifact came from, for example:

- provider / portal;
- source connection ID;
- remote document ID or stable path/key;
- remote version / modified timestamp where trustworthy;
- acquisition timestamp;
- content hash;
- connector/version used;
- source fund/account/folder scope.

Use stable remote identity plus content hash/version metadata to prevent repeated scheduled runs from producing duplicate source artifacts or duplicate extraction work.

If the remote system mutates or replaces a document, preserve each acquired version according to Corvis source-versioning rules rather than silently overwriting the prior evidence.

## Scheduling and automation

Connectors may run:

- on a customer-configured recurring schedule;
- on demand from the customer/admin portal;
- from an external webhook/event when the source provider supports one;
- as part of a controlled backfill.

Scheduling must use durable job state, bounded retries, backoff and dead-letter/operator handling. A broken portal connection must not block unrelated tenants or the general ingestion pipeline.

The customer portal should display at least:

- connection state;
- authorized scope;
- last successful sync;
- next scheduled sync;
- latest error/reauthorization requirement;
- documents discovered/imported;
- pause/reconnect/revoke controls.

## Browser automation boundary

Where an API is unavailable and browser automation is approved:

- isolate each run and tenant context;
- pin/test supported portal workflows and selectors defensively;
- bound navigation/download timeouts and retries;
- restrict outbound access to required destinations where practical;
- prevent downloaded content or page text from authorizing tools/actions;
- treat portal page content as untrusted input;
- never persist reusable browser profiles containing credentials in container images or shared filesystems;
- persist a session token/cookie only when necessary, allowed and securely stored with the same protections as credentials;
- fail closed when login flow, terms, permissions or page structure changes unexpectedly.

Do not design mechanisms to defeat CAPTCHA, MFA, access controls or provider rate/security restrictions.

## Rights and provider approval

A source connector may operate only when:

- the customer has documented authority to provide the credentials and instruct Corvis to access the material;
- the contracted source scope permits the processing;
- the external portal/provider terms and technical controls permit the intended automated access, or an approved exception has been reviewed;
- Security/Legal review is completed where a new connector changes credential, subprocessor, data-location or legal-risk posture.

A successful login is not proof of contractual right to ingest every visible document. Source scope and data rights remain independently enforced.

## Security and operational controls

At minimum, production connectors require:

- tenant-scoped authorization for connection create/update/test/pause/revoke;
- immutable audit events for credential setup/rotation/revocation and connector runs;
- least-privilege connector service identity;
- secret access logging and rotation procedures;
- no secret values in logs, telemetry, support UI or model prompts;
- rate limiting/backoff appropriate to each provider;
- safe error classification (`auth`, `reauthorization`, `permission`, `provider_change`, `network`, `download`, `validation`);
- alerts for repeated failures, prolonged stale sync or credential expiration;
- customer-visible health where the integration is contracted/active;
- deletion/revocation handling when a customer disconnects or terminates service.

## Testing

Each connector needs production-like tests covering, as applicable:

- successful authorization and scoped discovery;
- invalid/expired credential behavior;
- reauthorization and rotation;
- cross-tenant credential isolation;
- duplicate discovery/download idempotency;
- remote document replacement/versioning;
- timeout/retry/backoff/dead-letter behavior;
- portal UI/layout change failure safety for browser connectors;
- malware/invalid-file handling after download;
- secret redaction in logs/errors;
- revoke/disconnect behavior;
- end-to-end source lineage into GCS/Postgres and downstream processing.

Use synthetic/test portal accounts for UAT. Do not place real customer portal credentials or source data in `dev` or general CI.

## Initial implementation sequence

1. Define a provider-neutral `SourceConnector` contract and connection/run state model.
2. Implement customer/admin portal connection setup, status, pause/revoke and reauthorization surfaces.
3. Implement managed secret persistence and tenant-scoped credential references.
4. Build one approved representative connector end to end.
5. Feed acquired documents into the existing GCS/document-registration path.
6. Add scheduling, retry/dead-letter, audit and observability.
7. Add provider-specific connector certification/UAT fixtures.
8. Expand the connector catalog only when customer demand justifies maintenance cost.

## Non-negotiable invariants

- Customer source credentials are runtime secrets, never repository/GitHub configuration.
- Credentials are never exposed to models.
- Automation never bypasses MFA/CAPTCHA/access controls.
- Customer authorization and external-source permission are required separately from technical login success.
- Every acquired document enters the standard immutable GCS/document-registry pipeline.
- Connector execution is tenant isolated, auditable, idempotent and revocable.
- A source-provider outage or changed login flow cannot corrupt canonical data or block unrelated customers.
