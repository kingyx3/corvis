-- Corvis customer-authorized source acquisition connectors v1
-- Depends on migrations 001-012.
-- Postgres holds non-secret connection metadata, run state and acquisition
-- lineage only. Credential/token material lives in the runtime managed secret
-- store and is referenced here by resource name.

begin;

create table if not exists corvis_source.source_connection (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  source_connection_id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  provider_key text not null check (provider_key ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  connection_label text not null check (length(connection_label) between 1 and 200),
  credential_type text not null check (credential_type in ('oauth_authorization_code','oauth_client_credentials','scoped_api_token','service_account','browser_session')),
  source_scope jsonb not null default '[]'::jsonb,
  scope_confirmed_by text not null,
  scope_confirmed_at timestamptz not null,
  secret_reference text not null,
  connector_version text not null,
  status text not null default 'pending_authorization'
    check (status in ('pending_authorization','active','paused','reauthorization_required','suspended','revoked')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_authorized_at timestamptz,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error_class text check (last_error_class in ('auth','reauthorization','permission','provider_change','network','download','validation','rate_limit')),
  next_scheduled_at timestamptz,
  revoked_at timestamptz,
  unique (tenant_id, source_connection_id),
  -- The secret resource name is itself tenant-bound, so a reference belonging to
  -- another tenant cannot be stored against this connection even if an
  -- application layer is bypassed. The charset also forbids embedding credential
  -- material in the reference column.
  constraint source_connection_secret_reference_tenant_scoped check (
    secret_reference ~ ('^projects/[a-z0-9][a-z0-9-]{4,28}[a-z0-9]/secrets/corvis-src-' || tenant_id::text || '-[a-z0-9][a-z0-9-]{0,63}(/versions/(latest|[0-9]+))?$')
  ),
  constraint source_connection_revoked_is_terminal check ((status = 'revoked') = (revoked_at is not null))
);

create table if not exists corvis_source.source_connection_run (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  run_id uuid primary key default gen_random_uuid(),
  source_connection_id uuid not null,
  trigger text not null check (trigger in ('scheduled','on_demand','webhook','backfill')),
  state text not null check (state in ('running','succeeded','failed','retryable','dead_letter','refused')),
  attempt integer not null check (attempt > 0),
  max_attempts integer not null check (max_attempts > 0),
  connector_version text not null,
  discovered_count integer not null default 0 check (discovered_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  error_class text check (error_class in ('auth','reauthorization','permission','provider_change','network','download','validation','rate_limit')),
  error_summary text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  next_attempt_at timestamptz,
  unique (tenant_id, run_id),
  foreign key (tenant_id, source_connection_id) references corvis_source.source_connection(tenant_id, source_connection_id)
);

create table if not exists corvis_source.acquired_document (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  acquisition_id uuid primary key default gen_random_uuid(),
  source_connection_id uuid not null,
  run_id uuid not null,
  provider_key text not null,
  remote_document_id text not null check (length(remote_document_id) between 1 and 512),
  remote_version text not null,
  remote_path text not null,
  remote_modified_at timestamptz,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  acquisition_key text not null check (acquisition_key ~ '^[0-9a-f]{64}$'),
  connector_version text not null,
  acquired_at timestamptz not null default now(),
  disposition text not null check (disposition in ('accepted','duplicate','rejected','quarantined')),
  rejection_reason text,
  document_id uuid,
  document_artifact_version_id uuid,
  unique (tenant_id, acquisition_id),
  -- Stable remote identity plus content hash makes repeated scheduled runs
  -- idempotent; a genuine remote replacement changes the key and is retained
  -- alongside the prior acquisition rather than overwriting it.
  unique (tenant_id, source_connection_id, acquisition_key),
  foreign key (tenant_id, source_connection_id) references corvis_source.source_connection(tenant_id, source_connection_id),
  foreign key (tenant_id, run_id) references corvis_source.source_connection_run(tenant_id, run_id),
  foreign key (tenant_id, document_id) references corvis_source.document(tenant_id, document_id),
  foreign key (tenant_id, document_artifact_version_id) references corvis_source.document_artifact_version(tenant_id, document_artifact_version_id)
);

alter table corvis_source.source_connection enable row level security;
alter table corvis_source.source_connection force row level security;
alter table corvis_source.source_connection_run enable row level security;
alter table corvis_source.acquired_document enable row level security;

-- corvis_source.source_connection carries the managed-secret resource name and
-- is intentionally server-only: it gets no client SELECT policy. Customer-visible
-- connection health is served through the connector API, which projects
-- non-secret fields under an explicit tenant predicate.
create policy source_connection_run_tenant_select on corvis_source.source_connection_run
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy acquired_document_tenant_select on corvis_source.acquired_document
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists source_connection_schedule_idx
  on corvis_source.source_connection (tenant_id, status, next_scheduled_at);
create index if not exists source_connection_run_connection_idx
  on corvis_source.source_connection_run (tenant_id, source_connection_id, started_at desc);
create index if not exists acquired_document_remote_idx
  on corvis_source.acquired_document (tenant_id, source_connection_id, remote_document_id, acquired_at desc);
create index if not exists acquired_document_document_idx
  on corvis_source.acquired_document (tenant_id, document_id);

commit;
