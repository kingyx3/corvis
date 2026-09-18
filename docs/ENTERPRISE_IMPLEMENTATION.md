# Enterprise implementation

This document records production contracts implemented in-repository and the external infrastructure that must be bound before customer production use.

## Implemented contracts

- Tenant-scoped request context and RBAC policy model
- Versioned API envelope and audit event schema
- Upload session lifecycle with resumability, idempotency, checksum metadata and quarantine states
- Durable processing job/event model with retries and dead-letter states
- Review decision and snapshot publication contracts
- Semantic query and permissioned retrieval request/response contracts
- Export/webhook contracts with manifest/checksum/idempotency fields
- Observability correlation identifiers and service health contract
- Production configuration validation

## Required production bindings

The repository deliberately does not hard-code vendors. Production must bind these ports to approved providers:

1. Enterprise OIDC/SAML identity provider and SCIM/JIT provisioning.
2. Private object storage with KMS encryption, multipart APIs, malware scanning and retention controls.
3. Durable queue/workflow engine for processing orchestration.
4. Snowflake SOURCE/CANONICAL/CURATED/SEMANTIC/SERVING schemas with row-access policies.
5. Search/retrieval backend constrained by tenant/source entitlements before result materialization.
6. Central logging/tracing/metrics backend and paging/incident system.
7. Secrets manager and environment-specific configuration store.
8. Email/webhook/export delivery infrastructure.

No production deployment should enable `CORVIS_DEMO_MODE` or use demo adapters for customer data.