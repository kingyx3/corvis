# Source acquisition connectors

This document is the technical source of truth for automated acquisition of authorized customer documents from GP portals, data rooms and similar external repositories. Confluence owns the business/source-right requirements; GitHub owns connector implementation, credential handling, runtime isolation and operational behavior.

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
