-- Corvis identity lifecycle provenance and creation guards.
-- Depends on migrations 032-033.

begin;

-- New identities must receive an initial canonical-name history row just as
-- existing identities were backfilled in migration 032. Updates remain handled
-- by the rename-history triggers from that migration.
create or replace function corvis_identity.seed_fund_canonical_name_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_identity
as $$
begin
  insert into corvis_identity.entity_name
    (fund_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_fund_id,new.canonical_name,'canonical',true,'governed','canonical-name-insert-trigger')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists fund_canonical_name_history_on_insert on corvis_identity.fund;
create trigger fund_canonical_name_history_on_insert
after insert on corvis_identity.fund
for each row execute function corvis_identity.seed_fund_canonical_name_history();

create or replace function corvis_identity.seed_company_canonical_name_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_identity
as $$
begin
  insert into corvis_identity.entity_name
    (company_id,name,name_kind,is_current,source_kind,recorded_by)
  values
    (new.global_company_id,new.canonical_name,'canonical',true,'governed','canonical-name-insert-trigger')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists company_canonical_name_history_on_insert on corvis_identity.company;
create trigger company_canonical_name_history_on_insert
after insert on corvis_identity.company
for each row execute function corvis_identity.seed_company_canonical_name_history();

-- Global lifecycle/event rows hold non-confidential economic identity metadata.
-- Exact evidence from a private tenant document stays tenant-scoped here and is
-- never exposed through the global directory solely because identities match.
create table if not exists corvis_identity.tenant_entity_lifecycle_evidence (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  lifecycle_event_id uuid not null references corvis_identity.entity_lifecycle_event(lifecycle_event_id),
  source_reference_id uuid not null,
  evidence_role text not null default 'supporting' check (evidence_role in (
    'primary','supporting','contradicting','announcement','completion','other'
  )),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  review_status text not null default 'candidate' check (review_status in (
    'candidate','approved','rejected','superseded'
  )),
  created_at timestamptz not null default now(),
  primary key (tenant_id, lifecycle_event_id, source_reference_id),
  foreign key (tenant_id, source_reference_id)
    references corvis_source.source_reference(tenant_id, source_reference_id)
);

alter table corvis_identity.tenant_entity_lifecycle_evidence enable row level security;
alter table corvis_identity.tenant_entity_lifecycle_evidence force row level security;
create policy tenant_entity_lifecycle_evidence_select
  on corvis_identity.tenant_entity_lifecycle_evidence
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists tenant_entity_lifecycle_evidence_event_idx
  on corvis_identity.tenant_entity_lifecycle_evidence
    (tenant_id, lifecycle_event_id, review_status, created_at desc);
create index if not exists tenant_entity_lifecycle_evidence_source_idx
  on corvis_identity.tenant_entity_lifecycle_evidence
    (tenant_id, source_reference_id, lifecycle_event_id);

-- Avoid duplicate relationship edges for the same populated polymorphic source
-- and target. The event FK remains part of uniqueness so separate transactions
-- can create separate historical edges without being collapsed.
create unique index if not exists entity_relationship_fund_to_fund_event_uniq
  on corvis_identity.entity_relationship
    (relationship_type, source_fund_id, target_fund_id, lifecycle_event_id)
  where source_fund_id is not null and target_fund_id is not null and lifecycle_event_id is not null;
create unique index if not exists entity_relationship_fund_to_company_event_uniq
  on corvis_identity.entity_relationship
    (relationship_type, source_fund_id, target_company_id, lifecycle_event_id)
  where source_fund_id is not null and target_company_id is not null and lifecycle_event_id is not null;
create unique index if not exists entity_relationship_company_to_fund_event_uniq
  on corvis_identity.entity_relationship
    (relationship_type, source_company_id, target_fund_id, lifecycle_event_id)
  where source_company_id is not null and target_fund_id is not null and lifecycle_event_id is not null;
create unique index if not exists entity_relationship_company_to_company_event_uniq
  on corvis_identity.entity_relationship
    (relationship_type, source_company_id, target_company_id, lifecycle_event_id)
  where source_company_id is not null and target_company_id is not null and lifecycle_event_id is not null;

commit;
