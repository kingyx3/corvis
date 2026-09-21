# Independent production security assessment pack

This directory prepares Corvis for the independent production-like UAT security assessment tracked by issue #80. It is intentionally safe for a public repository and must not contain credentials, private assessor reports, customer data, exploit payloads against third parties, or confidential infrastructure exports.

## In-scope production-equivalent boundaries

The assessor should test the deployed UAT configuration that mirrors production: Cloudflare DNS/TLS/WAF/Workers; the customer, admin and public API hostnames; Google API Gateway identities and API keys; IAM-private Cloud Run API/customer/admin/worker services; the scheduled control-loop Cloud Run Job; authentication/session lifecycle; tenant authorization and Postgres RLS; upload and immutable GCS source lineage; Pub/Sub and Cloud Tasks service identity; source connections; webhooks and exports; review/recovery/correction controls; and any enabled Ask Corvis retrieval/evidence boundary.

Source review is useful but does not substitute for testing the deployed production-equivalent configuration.

## Test identities and data

Use dedicated sanitized UAT tenants only. At minimum provision two ordinary tenants, one administrator identity, one ordinary human identity per tenant, and the production-equivalent service identities. The corpus must contain synthetic documents and deterministic expected outputs; no customer data or production credentials may be copied into the assessment environment.

## Required negative tests

The assessment must cover cross-tenant read/write attempts, privilege escalation, session revocation, direct origin/gateway bypass attempts, customer/admin runtime surface isolation, unauthorized worker invocation, RLS bypass attempts, upload authorization/content controls, webhook signing/replay behavior, export authorization and expiry, secret exposure in errors/logs, and mutation/recovery endpoints that require `admin:manage`.

## Evidence handling

Only sanitized scope, status, remediation references and non-sensitive proof belong in this public repository. Full reports, screenshots containing identifiers, exploit traces, credentials, provider exports and customer-like data must be retained in an access-controlled evidence repository referenced by the enterprise control process.

## Launch disposition

Every finding requires an owner and disposition. Any finding judged launch-blocking by the independent assessor or Corvis risk owner must be remediated and objectively retested before production approval. A completed source scan or this preparation pack is not an independent assessment and must never be represented as certification or attestation.
