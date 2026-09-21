-- Corvis governed holding/instrument model v1
-- Depends on migrations 001-034.
--
-- Canonical economic graph:
--   fund -> holding -> (company | underlying fund)
--   company-targeted holding -> instrument(s)
-- Holdings/instruments are tenant-scoped governed records. Global fund/company
-- identity does not itself grant customer visibility.

begin;

create table if not exists corvis_facts.holding (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  holding_id uuid not null default gen_random_uuid(),
  fund_id text not null references corvis_identity.fund(global_fund_id),
  target_type text not null check (target_type in ('company','fund')),
  target_company_id text references corvis_identity.company(global_company_id),
  target_fund_id text references corvis_identity.fund(global_fund_id),
  source_reference_id uuid,
  review_state text not null default 'review_required' check (review_state in ('review_required','approved','rejected','superseded')),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, holding_id),
  foreign key (tenant_id, source_reference_id) references corvis_source.source_reference(tenant_id, source_reference_id),
  check (
    (target_type='company' and target_company_id is not null and target_fund_id is null)
    or
    (target_type='fund' and target_fund_id is not null and target_company_id is null)
  ),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table if not exists corvis_facts.instrument (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  instrument_id uuid not null default gen_random_uuid(),
  holding_id uuid not null,
  security_description text not null check (btrim(security_description) <> ''),
  instrument_type text,
  currency text,
  source_reference_id uuid,
  review_state text not null default 'review_required' check (review_state in ('review_required','approved','rejected','superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, instrument_id),
  foreign key (tenant_id, holding_id) references corvis_facts.holding(tenant_id, holding_id),
  foreign key (tenant_id, source_reference_id) references corvis_source.source_reference(tenant_id, source_reference_id)
);

create or replace function corvis_facts.enforce_instrument_company_holding()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_facts
as $$
begin
  if not exists (
    select 1 from corvis_facts.holding h
    where h.tenant_id=new.tenant_id
      and h.holding_id=new.holding_id
      and h.target_type='company'
      and h.target_company_id is not null
  ) then
    raise exception 'instrument must belong to a company-targeted holding';
  end if;
  return new;
end;
$$;

drop trigger if exists instrument_company_holding_guard on corvis_facts.instrument;
create trigger instrument_company_holding_guard
before insert or update of tenant_id,holding_id on corvis_facts.instrument
for each row execute function corvis_facts.enforce_instrument_company_holding();

alter table corvis_facts.holding enable row level security;
alter table corvis_facts.holding force row level security;
alter table corvis_facts.instrument enable row level security;
alter table corvis_facts.instrument force row level security;

create policy holding_tenant_select on corvis_facts.holding
  for select using (corvis_control.has_tenant_access(tenant_id));
create policy instrument_tenant_select on corvis_facts.instrument
  for select using (corvis_control.has_tenant_access(tenant_id));

create index if not exists holding_tenant_fund_idx
  on corvis_facts.holding (tenant_id,fund_id,review_state,updated_at desc);
create index if not exists holding_company_target_idx
  on corvis_facts.holding (tenant_id,target_company_id,review_state)
  where target_company_id is not null;
create index if not exists holding_fund_target_idx
  on corvis_facts.holding (tenant_id,target_fund_id,review_state)
  where target_fund_id is not null;
create index if not exists instrument_holding_idx
  on corvis_facts.instrument (tenant_id,holding_id,review_state,updated_at desc);

create or replace view corvis_serving.holdings as
select tenant_id,holding_id,fund_id,target_type,target_company_id,target_fund_id,
       source_reference_id,valid_from,valid_to,updated_at
from corvis_facts.holding
where review_state='approved';

create or replace view corvis_serving.instruments as
select i.tenant_id,i.instrument_id,i.holding_id,h.fund_id,h.target_company_id as company_id,
       i.security_description,i.instrument_type,i.currency,i.source_reference_id,i.updated_at
from corvis_facts.instrument i
join corvis_facts.holding h
  on h.tenant_id=i.tenant_id and h.holding_id=i.holding_id
where i.review_state='approved' and h.review_state='approved' and h.target_type='company';

commit;
