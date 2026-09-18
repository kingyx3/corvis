# Corvis

Corvis is a tenant-isolated private-markets data platform that turns confidential fund documents into reviewed, source-traceable fund-period data, APIs, exports and permissioned research.

## What is implemented

- Customer workspace for reporting cycles, documents, trusted observations and Ask Corvis.
- Versioned `/api/v1` routes with authenticated tenant/workspace context and server-side authorization.
- Resumable direct-to-object-store multipart upload with durable sessions, idempotency, exact part validation and quarantine.
- Immutable document/artifact identities and source references.
- Snowflake `SOURCE → CANONICAL → CURATED → SEMANTIC → SERVING` schemas with tenant row policies and secure serving views.
- Canonical funds, companies, holdings, instruments and vertical metric observations.
- Auditable review/correction events, optimistic concurrency, critical-fact independent review and server-side publication gates.
- Durable processing jobs/outbox events, bounded retry/dead-letter model and audited operator retry.
- Permissioned retrieval + trusted-data research adapter: structured facts and source evidence remain separate permission boundaries.
- Audit events, export jobs/manifests/checksums, signed-webhook primitives, retention/data-right/control-evidence schemas.
- Structured telemetry forwarding, health/readiness endpoints and AWS reference IaC for KMS/S3/queues.
- Deterministic CI with lint, typecheck, unit tests, build, Playwright, dependency audit and CodeQL.

Raw extraction-agent payloads and physical Snowflake tables are never customer product contracts.

## Architecture: linked, not married

```text
Browser / customer integrations
        │
        ▼
application + versioned API contracts
        │
        ├── identity / authorization port
        ├── upload / source-store port
        ├── orchestration / event contracts
        ├── canonical + serving repository port
        ├── semantic-query port
        ├── permissioned retrieval port
        └── audit / telemetry / delivery ports
                │
                ▼
replaceable production adapters
```

Feature code depends on stable contracts. S3, Snowflake, search, AI, identity and telemetry are implementation adapters rather than business semantics.

## Local development

```bash
npm ci
npm run dev
```

Local demo behavior is **explicit opt-in**:

```bash
CORVIS_DEMO_MODE=true
NEXT_PUBLIC_CORVIS_DEMO_MODE=true
```

Production rejects demo mode and missing required enterprise bindings.

## Production document flow

```text
initiate
  → immutable document/artifact IDs
  → presigned multipart upload
  → resumable S3 part state
  → exact file-signature validation
  → quarantine
  → malware clean disposition
  → DocumentRegistered outbox event
  → interpretation
  → extraction
  → review
  → canonicalization
  → reconciliation
  → consolidation
  → versioned fund-period snapshot
  → semantic / serving layer
```

Source bytes remain in private versioned object storage. Snowflake is the structured system of record.

## Production data and AI rule

Quantitative research is grounded in tenant-scoped serving facts. Narrative evidence comes only from a source corpus filtered by tenant/workspace/document/fund entitlement **before retrieval**. Document text is treated as untrusted data and cannot authorize tools or permissions.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm audit --audit-level=high
```

GitHub Actions also runs CodeQL. Reference infrastructure lives under `infra/terraform/aws-reference`.

## Activation

Source control cannot prove that an IdP policy, cloud account, Snowflake grant, malware scanner, backup restore or operational control is actually running. Production therefore stays fail-closed until live bindings and evidence are present.

See:

- `docs/ENTERPRISE_IMPLEMENTATION.md`
- `docs/PRODUCTION_ACTIVATION.md`
- `.env.example`
- `db/migrations/`

`GET /api/v1/admin/readiness` is the deployment binding gate; the Confluence Enterprise Control Register remains the operating-evidence authority.
