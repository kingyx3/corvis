-- Corvis economic entity name/history/lifecycle model v1
-- Depends on migrations 001-031.
--
-- Economic identity is durable. Names, ownership and corporate/fund structure may
-- change without changing the immutable global fund/company ID. Renames are name
-- history on one identity; mergers/splits/acquisitions are explicit lifecycle
-- events and relationships between identities. Tenant-private aliases remain
-- tenant scoped and never become global merely because they were observed.

begin;

create or replace function corvis_identity.normalize_entity_name(p_name text)
returns text
language sql
immutable
strict
as $$
  select btrim(regexp_replace(lower(p_name), '[^[:alnum:]]+', ' ', 'g'));
$$;

create table if not exists corvis_identity.entity_name (
  entity_name_id uuid primary key default gen_random_uuid(),
  fund_id text references corvis_identity.fund(global_fund_id),
  company_id text references corvis_identity.company(global_company_id),
  name text not null check (btrim(name) <> ''),
  normalized_name text generated always as (corvis_identity.normalize_entity_name(name)) stored,
  name_kind text not null check (name_kind in (
    'canonical','legal','trading','marketed','abbreviation','program_code','codename','other'
  )),
  is_current boolean not null default false,
  valid_from date,
  valid_to date,
  source_kind text not null default 'governed' check (source_kind in (
    'governed','public_registry','manual_migration','other'
  )),
  source_note text,
  recorded_by text not null default 'system',
  recorded_at timestamptz not null default now(),
  check ((case when fund_id is null then 0 else 1 end) + (case when company_id is null then 0 else 1 end) = 1),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create unique index if not exists entity_name_current_fund_canonical_uniq
  on corvis_identity.entity_name (fund_id)
  where fund_id is not null and name_kind='canonical' and is_current;
create unique index if not exists entity_name_current_company_canonical_uniq
  on corvis_identity.entity_name (company_id)
  where company_id is not null and name_kind='canonical' and is_current;
create index if not exists entity_name_normalized_lookup_idx
  on corvis_identity.entity_name (normalized_name, is_current desc, recorded_at desc);
create index if not exists entity_name_fund_history_idx
  on corvis_identity.entity_name (fund_id, is_current desc, valid_from desc nulls last, recorded_at desc)
  where fund_id is not null;
create index if not exists entity_name_company_history_idx
  on corvis_identity.entity_name (company_id, is_current desc, valid_from desc nulls last, recorded_at desc)
  where company_id is not null;

-- Backfill the current names without inventing an economic effective date. The
-- recorded_at timestamp captures when Corvis knew the name; valid_from/valid_to
-- remain available for evidence-backed economic dates.
insert into corvis_identity.entity_name (fund_id,name,name_kind,is_current,source_kind,recorded_by)
select f.global_fund_id,f.canonical_name,'canonical',true,'manual_migration','migration-032'
from corvis_identity.fund f
where not exists (
  select 1 from corvis_identity.entity_name n
  where n.fund_id=f.global_fund_id and n.name_kind='canonical' and n.is_current
);

insert into corvis_identity.entity_name (company_id,name,name_kind,is_current,source_kind,recorded_by)
select c.global_company_id,c.canonical_name,'canonical',true,'manual_migration','migration-032'
from corvis_identity.company c
where not exists (
  select 1 from corvis_identity.entity_name n
  where n.company_id=c.global_company_id and n.name_kind='canonical' and n.is_current
);

create or replace function corvis_identity.capture_fund_canonical_name_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_identity
as $$
begin
  if new.canonical_name is not distinct from old.canonical_name then
    return new;
  end if;

  update corvis_identity.entity_name
  set is_current=false
  where fund_id=old.global_fund_id and name_kind='canonical' and is_current;

  insert into corvis_identity.entity_name
    (fund_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_fund_id,new.canonical_name,'canonical',true,'governed','canonical-name-trigger');

  return new;
end;
$$;

drop trigger if exists fund_canonical_name_history on corvis_identity.fund;
create trigger fund_canonical_name_history
after update of canonical_name on corvis_identity.fund
for each row execute function corvis_identity.capture_fund_canonical_name_history();

create or replace function corvis_identity.capture_company_canonical_name_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_identity
as $$
begin
  if new.canonical_name is not distinct from old.canonical_name then
    return new;
  end if;

  update corvis_identity.entity_name
  set is_current=false
  where company_id=old.global_company_id and name_kind='canonical' and is_current;

  insert into corvis_identity.entity_name
    (company_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_company_id,new.canonical_name,'canonical',true,'governed','canonical-name-trigger');

  return new;
end;
$$;

drop trigger if exists company_canonical_name_history on corvis_identity.company;
create trigger company_canonical_name_history
after update of canonical_name on corvis_identity.company
for each row execute function corvis_identity.capture_company_canonical_name_history();

-- Tenant-private labels/codenames are deliberately separated from the global
-- alias corpus. A private source label must not leak across customers merely
-- because two tenants resolve to the same global economic identity.
create table if not exists corvis_identity.tenant_entity_name (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  tenant_entity_name_id uuid not null default gen_random_uuid(),
  fund_id text references corvis_identity.fund(global_fund_id),
  company_id text references corvis_identity.company(global_company_id),
  name text not null check (btrim(name) <> ''),
  normalized_name text generated always as (corvis_identity.normalize_entity_name(name)) stored,
  name_kind text not null check (name_kind in (
    'source_label','legal','trading','marketed','abbreviation','program_code','codename','former_name','other'
  )),
  first_seen_date date,
  last_seen_date date,
  source_reference_id uuid,
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  review_status text not null default 'candidate' check (review_status in (
    'candidate','approved','rejected','superseded'
  )),
  created_at timestamptz not null default now(),
  primary key (tenant_id, tenant_entity_name_id),
  foreign key (tenant_id, source_reference_id)
    references corvis_source.source_reference(tenant_id, source_reference_id),
  check ((case when fund_id is null then 0 else 1 end) + (case when company_id is null then 0 else 1 end) = 1),
  check (last_seen_date is null or first_seen_date is null or last_seen_date >= first_seen_date)
);

alter table corvis_identity.tenant_entity_name enable row level security;
alter table corvis_identity.tenant_entity_name force row level security;
create policy tenant_entity_name_tenant_select on corvis_identity.tenant_entity_name
  for select using (corvis_control.has_tenant_access(tenant_id));
create index if not exists tenant_entity_name_lookup_idx
  on corvis_identity.tenant_entity_name (tenant_id, normalized_name, review_status, last_seen_date desc nulls last);
create index if not exists tenant_entity_name_fund_idx
  on corvis_identity.tenant_entity_name (tenant_id, fund_id, last_seen_date desc nulls last)
  where fund_id is not null;
create index if not exists tenant_entity_name_company_idx
  on corvis_identity.tenant_entity_name (tenant_id, company_id, last_seen_date desc nulls last)
  where company_id is not null;

-- External identifiers anchor matching when names change or collide. Identifier
-- history is additive because registry IDs, tickers and vendor IDs can themselves
-- change over time.
create table if not exists corvis_identity.entity_external_identifier (
  entity_external_identifier_id uuid primary key default gen_random_uuid(),
  fund_id text references corvis_identity.fund(global_fund_id),
  company_id text references corvis_identity.company(global_company_id),
  identifier_type text not null check (identifier_type in (
    'lei','cik','company_registry','ticker','isin','sedol','cusip','vendor_id','gp_or_admin_id','other'
  )),
  identifier_value text not null check (btrim(identifier_value) <> ''),
  issuer text,
  jurisdiction text,
  is_current boolean not null default true,
  valid_from date,
  valid_to date,
  recorded_at timestamptz not null default now(),
  check ((case when fund_id is null then 0 else 1 end) + (case when company_id is null then 0 else 1 end) = 1),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create index if not exists entity_external_identifier_lookup_idx
  on corvis_identity.entity_external_identifier
    (identifier_type, identifier_value, is_current desc, valid_from desc nulls last);
create index if not exists entity_external_identifier_fund_idx
  on corvis_identity.entity_external_identifier (fund_id, is_current desc, identifier_type)
  where fund_id is not null;
create index if not exists entity_external_identifier_company_idx
  on corvis_identity.entity_external_identifier (company_id, is_current desc, identifier_type)
  where company_id is not null;

-- Lifecycle events describe what happened. Participants describe which durable
-- identities played which roles. This supports one-to-one, many-to-one and
-- one-to-many events without collapsing distinct economic entities.
create table if not exists corvis_identity.entity_lifecycle_event (
  lifecycle_event_id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in (
    'rename','acquisition','merger','demerger','split','spin_off','carve_out',
    'partial_divestiture','reorganization','legal_form_change','domicile_change',
    'formation','dissolution','liquidation','fund_restructure','manager_change',
    'listing','delisting','take_private','successor_transition','other'
  )),
  event_status text not null default 'completed' check (event_status in (
    'announced','pending','completed','cancelled','unknown'
  )),
  announced_date date,
  effective_date date,
  closed_date date,
  event_subtype_raw text,
  description text,
  source_kind text not null default 'governed' check (source_kind in (
    'governed','public_registry','tenant_evidence','manual','other'
  )),
  recorded_at timestamptz not null default now(),
  check (closed_date is null or effective_date is null or closed_date >= effective_date)
);

create table if not exists corvis_identity.entity_lifecycle_participant (
  lifecycle_event_id uuid not null references corvis_identity.entity_lifecycle_event(lifecycle_event_id) on delete cascade,
  fund_id text references corvis_identity.fund(global_fund_id),
  company_id text references corvis_identity.company(global_company_id),
  participant_role text not null check (participant_role in (
    'subject','predecessor','successor','acquirer','acquired','surviving_entity',
    'merged_constituent','source_entity','resulting_entity','parent','child',
    'seller','buyer','transferred_entity','other'
  )),
  economic_identity_continues boolean,
  ownership_before numeric(9,6) check (ownership_before is null or (ownership_before >= 0 and ownership_before <= 1)),
  ownership_after numeric(9,6) check (ownership_after is null or (ownership_after >= 0 and ownership_after <= 1)),
  notes text,
  created_at timestamptz not null default now(),
  check ((case when fund_id is null then 0 else 1 end) + (case when company_id is null then 0 else 1 end) = 1),
  unique (lifecycle_event_id, fund_id, company_id, participant_role)
);

create index if not exists entity_lifecycle_participant_fund_idx
  on corvis_identity.entity_lifecycle_participant (fund_id, lifecycle_event_id)
  where fund_id is not null;
create index if not exists entity_lifecycle_participant_company_idx
  on corvis_identity.entity_lifecycle_participant (company_id, lifecycle_event_id)
  where company_id is not null;
create index if not exists entity_lifecycle_event_effective_idx
  on corvis_identity.entity_lifecycle_event (effective_date desc nulls last, event_type, event_status);

-- Relationships express durable or time-bounded links that directory/search/API
-- consumers can traverse directly. Lifecycle events remain the provenance anchor.
create table if not exists corvis_identity.entity_relationship (
  entity_relationship_id uuid primary key default gen_random_uuid(),
  relationship_type text not null check (relationship_type in (
    'successor_of','merged_into','acquired_by','parent_of','subsidiary_of',
    'spun_off_from','carved_out_from','reorganized_from','related_vehicle','other'
  )),
  source_fund_id text references corvis_identity.fund(global_fund_id),
  source_company_id text references corvis_identity.company(global_company_id),
  target_fund_id text references corvis_identity.fund(global_fund_id),
  target_company_id text references corvis_identity.company(global_company_id),
  lifecycle_event_id uuid references corvis_identity.entity_lifecycle_event(lifecycle_event_id),
  relationship_status text not null default 'active' check (relationship_status in (
    'planned','active','historical','cancelled','unknown'
  )),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  check ((case when source_fund_id is null then 0 else 1 end) + (case when source_company_id is null then 0 else 1 end) = 1),
  check ((case when target_fund_id is null then 0 else 1 end) + (case when target_company_id is null then 0 else 1 end) = 1),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (not (source_fund_id is not null and source_fund_id=target_fund_id)),
  check (not (source_company_id is not null and source_company_id=target_company_id))
);

create index if not exists entity_relationship_source_fund_idx
  on corvis_identity.entity_relationship (source_fund_id, relationship_status, valid_from desc nulls last)
  where source_fund_id is not null;
create index if not exists entity_relationship_source_company_idx
  on corvis_identity.entity_relationship (source_company_id, relationship_status, valid_from desc nulls last)
  where source_company_id is not null;
create index if not exists entity_relationship_target_fund_idx
  on corvis_identity.entity_relationship (target_fund_id, relationship_status, valid_from desc nulls last)
  where target_fund_id is not null;
create index if not exists entity_relationship_target_company_idx
  on corvis_identity.entity_relationship (target_company_id, relationship_status, valid_from desc nulls last)
  where target_company_id is not null;

-- Global directory view exposes only non-tenant-confidential identity metadata.
-- Tenant-private aliases stay behind tenant_entity_name RLS.
create or replace view corvis_serving.entity_directory as
select
  'fund'::text as entity_type,
  f.global_fund_id as entity_id,
  f.canonical_name,
  f.manager_name,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'name',n.name,
      'nameKind',n.name_kind,
      'isCurrent',n.is_current,
      'validFrom',n.valid_from,
      'validTo',n.valid_to
    ) order by n.is_current desc,n.recorded_at desc)
    from corvis_identity.entity_name n
    where n.fund_id=f.global_fund_id
  ),'[]'::jsonb) as names,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'type',i.identifier_type,
      'value',i.identifier_value,
      'issuer',i.issuer,
      'jurisdiction',i.jurisdiction,
      'isCurrent',i.is_current
    ) order by i.is_current desc,i.recorded_at desc)
    from corvis_identity.entity_external_identifier i
    where i.fund_id=f.global_fund_id
  ),'[]'::jsonb) as external_identifiers
from corvis_identity.fund f
union all
select
  'company'::text as entity_type,
  c.global_company_id as entity_id,
  c.canonical_name,
  null::text as manager_name,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'name',n.name,
      'nameKind',n.name_kind,
      'isCurrent',n.is_current,
      'validFrom',n.valid_from,
      'validTo',n.valid_to
    ) order by n.is_current desc,n.recorded_at desc)
    from corvis_identity.entity_name n
    where n.company_id=c.global_company_id
  ),'[]'::jsonb) as names,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'type',i.identifier_type,
      'value',i.identifier_value,
      'issuer',i.issuer,
      'jurisdiction',i.jurisdiction,
      'isCurrent',i.is_current
    ) order by i.is_current desc,i.recorded_at desc)
    from corvis_identity.entity_external_identifier i
    where i.company_id=c.global_company_id
  ),'[]'::jsonb) as external_identifiers
from corvis_identity.company c;

create or replace view corvis_serving.entity_relationships as
select
  r.entity_relationship_id,
  r.relationship_type,
  case when r.source_fund_id is not null then 'fund' else 'company' end as source_entity_type,
  coalesce(r.source_fund_id,r.source_company_id) as source_entity_id,
  case when r.target_fund_id is not null then 'fund' else 'company' end as target_entity_type,
  coalesce(r.target_fund_id,r.target_company_id) as target_entity_id,
  r.lifecycle_event_id,
  r.relationship_status,
  r.valid_from,
  r.valid_to,
  r.created_at
from corvis_identity.entity_relationship r;

commit;
