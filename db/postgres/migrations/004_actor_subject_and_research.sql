-- Corvis Postgres actor identity and research persistence v1
-- Depends on migrations 001-003.

begin;

-- OIDC/SAML/service-account subjects are opaque strings, not necessarily UUIDs.
alter table corvis_control.feature_flag
  alter column updated_by type text using updated_by::text;

-- Quantitative Ask Corvis execution records are durable and tenant-scoped.
-- query_shape records the deterministic semantic query contract separately
-- from any generative explanation or source-retrieval context.
alter table corvis_control.semantic_query_log
  add column if not exists query_shape jsonb not null default '{}'::jsonb;

alter table corvis_control.semantic_query_log
  add column if not exists completed_at timestamptz;

create index if not exists semantic_query_tenant_time_idx
  on corvis_control.semantic_query_log (tenant_id, created_at desc);

commit;
