-- Physical export delivery authorization and retrieval grants.
-- Existing queued rows remain nullable and fail closed in the worker; every new
-- export records the authorization context needed for delivery-time revalidation.

begin;

alter table corvis_serving.export_job
  add column if not exists workspace_id uuid,
  add column if not exists auth_method text,
  add column if not exists session_id text;

create table if not exists corvis_serving.export_download_grant (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  grant_id uuid primary key default gen_random_uuid(),
  export_id uuid not null references corvis_serving.export_job(export_id) on delete cascade,
  subject text not null,
  token_sha256 text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, grant_id),
  unique (token_sha256),
  check (expires_at > created_at)
);

alter table corvis_serving.export_download_grant enable row level security;

create policy export_download_grant_tenant_select
  on corvis_serving.export_download_grant
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists export_download_grant_lookup_idx
  on corvis_serving.export_download_grant (tenant_id, export_id, subject, expires_at desc);

create index if not exists export_download_grant_expiry_idx
  on corvis_serving.export_download_grant (expires_at);

commit;
