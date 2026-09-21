-- Corvis governed holding/instrument hardening v1
-- Depends on migrations 001-034. Migration 003 already created the base
-- holding/instrument tables; this migration tightens them to the canonical
-- Fund -> Holding -> (Company | Underlying Fund) model and approved-only serving.

begin;

alter table corvis_facts.holding
  add column if not exists review_state text not null default 'review_required',
  add column if not exists valid_from date,
  add column if not exists valid_to date;

alter table corvis_facts.instrument
  add column if not exists review_state text not null default 'review_required';

alter table corvis_facts.holding
  drop constraint if exists holding_target_type_governed_check,
  add constraint holding_target_type_governed_check check (target_type in ('company','fund')) not valid,
  drop constraint if exists holding_exact_target_check,
  add constraint holding_exact_target_check check (
    (target_type='company' and target_company_id is not null and target_fund_id is null)
    or
    (target_type='fund' and target_fund_id is not null and target_company_id is null)
  ) not valid,
  drop constraint if exists holding_review_state_check,
  add constraint holding_review_state_check check (review_state in ('review_required','approved','rejected','superseded')) not valid,
  drop constraint if exists holding_valid_range_check,
  add constraint holding_valid_range_check check (valid_to is null or valid_from is null or valid_to >= valid_from) not valid,
  drop constraint if exists holding_fund_identity_fk,
  add constraint holding_fund_identity_fk foreign key (fund_id) references corvis_identity.fund(global_fund_id) not valid,
  drop constraint if exists holding_target_company_identity_fk,
  add constraint holding_target_company_identity_fk foreign key (target_company_id) references corvis_identity.company(global_company_id) not valid,
  drop constraint if exists holding_target_fund_identity_fk,
  add constraint holding_target_fund_identity_fk foreign key (target_fund_id) references corvis_identity.fund(global_fund_id) not valid;

alter table corvis_facts.instrument
  drop constraint if exists instrument_review_state_check,
  add constraint instrument_review_state_check check (review_state in ('review_required','approved','rejected','superseded')) not valid,
  drop constraint if exists instrument_security_name_required_check,
  add constraint instrument_security_name_required_check check (security_name is not null and btrim(security_name) <> '') not valid;

alter table corvis_facts.holding validate constraint holding_target_type_governed_check;
alter table corvis_facts.holding validate constraint holding_exact_target_check;
alter table corvis_facts.holding validate constraint holding_review_state_check;
alter table corvis_facts.holding validate constraint holding_valid_range_check;
alter table corvis_facts.holding validate constraint holding_fund_identity_fk;
alter table corvis_facts.holding validate constraint holding_target_company_identity_fk;
alter table corvis_facts.holding validate constraint holding_target_fund_identity_fk;
alter table corvis_facts.instrument validate constraint instrument_review_state_check;
alter table corvis_facts.instrument validate constraint instrument_security_name_required_check;

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

alter table corvis_facts.holding force row level security;
alter table corvis_facts.instrument force row level security;

create index if not exists holding_tenant_fund_review_idx
  on corvis_facts.holding (tenant_id,fund_id,review_state,updated_at desc);
create index if not exists holding_company_target_review_idx
  on corvis_facts.holding (tenant_id,target_company_id,review_state)
  where target_company_id is not null;
create index if not exists holding_fund_target_review_idx
  on corvis_facts.holding (tenant_id,target_fund_id,review_state)
  where target_fund_id is not null;
create index if not exists instrument_holding_review_idx
  on corvis_facts.instrument (tenant_id,holding_id,review_state,updated_at desc);

create or replace view corvis_serving.holdings as
select tenant_id,holding_id,fund_id,target_type,target_company_id,target_fund_id,
       status,investment_date,strategy,geography,source_reference_id,
       valid_from,valid_to,version,updated_at
from corvis_facts.holding
where review_state='approved';

create or replace view corvis_serving.instruments as
select i.tenant_id,i.instrument_id,i.holding_id,h.fund_id,h.target_company_id as company_id,
       i.security_name as security_description,i.instrument_type,i.currency,i.seniority,
       i.maturity_date,i.coupon_rate,i.source_reference_id,i.version,i.updated_at
from corvis_facts.instrument i
join corvis_facts.holding h
  on h.tenant_id=i.tenant_id and h.holding_id=i.holding_id
where i.review_state='approved' and h.review_state='approved' and h.target_type='company';

commit;
