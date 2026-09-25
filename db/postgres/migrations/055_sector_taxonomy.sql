-- Corvis governed sector taxonomy v1
-- Depends on migrations 001-054.
--
-- corvis_semantic.sector / sector_alias are global, versioned reference data
-- (like corvis_semantic.metric_definition: no tenant_id, not tenant-private).
-- The seed rows must match core/sector-taxonomy.ts exactly; the
-- core/sector-taxonomy.test.ts contract enforces it.
--
-- corvis_facts.company_sector_classification is the tenant's governed
-- assignment of a portfolio company to one sector. It is append-only history:
-- a reassignment supersedes the current row and appends a new version, so
-- every classification an exposure breakdown was ever computed from stays
-- attributable (who, when, why, under which taxonomy version). Writes go
-- only through corvis_facts.assign_company_sector, which the application
-- calls inside the same transaction as the generic audit event.

begin;

create or replace function corvis_semantic.normalize_sector_label(p_label text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(
    regexp_replace(regexp_replace(lower(coalesce(p_label,'')), '[&+]', ' and ', 'g'), '[^a-z0-9 ]+', ' ', 'g'),
    '\s+', ' ', 'g')), '')
$$;

create table if not exists corvis_semantic.sector (
  taxonomy_version text not null,
  sector_code text not null,
  display_name text not null,
  description text not null,
  display_order integer not null check (display_order > 0),
  created_at timestamptz not null default now(),
  primary key (taxonomy_version, sector_code),
  unique (taxonomy_version, display_order),
  check (sector_code ~ '^[a-z][a-z0-9_]*$'),
  check (btrim(display_name) <> ''),
  check (btrim(taxonomy_version) <> '')
);

create table if not exists corvis_semantic.sector_alias (
  taxonomy_version text not null,
  alias_normalized text not null,
  sector_code text not null,
  created_at timestamptz not null default now(),
  primary key (taxonomy_version, alias_normalized),
  foreign key (taxonomy_version, sector_code)
    references corvis_semantic.sector(taxonomy_version, sector_code),
  check (alias_normalized = corvis_semantic.normalize_sector_label(alias_normalized))
);

insert into corvis_semantic.sector (taxonomy_version, sector_code, display_name, description, display_order) values
  ('corvis_sector_v1','technology','Technology','Software, IT services, semiconductors and technology hardware.',1),
  ('corvis_sector_v1','healthcare','Healthcare','Healthcare providers and services, pharmaceuticals, biotechnology, medical devices and life sciences tools.',2),
  ('corvis_sector_v1','financials','Financials','Banks, insurance, asset and wealth management, payments and specialty finance.',3),
  ('corvis_sector_v1','industrials','Industrials','Capital goods, aerospace and defense, transportation, logistics and business services.',4),
  ('corvis_sector_v1','consumer_discretionary','Consumer discretionary','Retail, leisure, hospitality, automotive, education and consumer services.',5),
  ('corvis_sector_v1','consumer_staples','Consumer staples','Food, beverage, household and personal products, and staples retail.',6),
  ('corvis_sector_v1','communication_services','Communication services','Telecommunications, media, entertainment and interactive platforms.',7),
  ('corvis_sector_v1','energy','Energy','Oil, gas and consumable fuels, and energy equipment and services.',8),
  ('corvis_sector_v1','materials','Materials','Chemicals, construction materials, packaging, metals and mining.',9),
  ('corvis_sector_v1','real_estate','Real estate','Real estate owners, operators, developers and services.',10),
  ('corvis_sector_v1','utilities','Utilities','Electric, gas and water utilities, and renewable power producers.',11)
on conflict (taxonomy_version, sector_code) do nothing;

insert into corvis_semantic.sector_alias (taxonomy_version, alias_normalized, sector_code) values
  ('corvis_sector_v1','technology','technology'),
  ('corvis_sector_v1','tech','technology'),
  ('corvis_sector_v1','information technology','technology'),
  ('corvis_sector_v1','it','technology'),
  ('corvis_sector_v1','software','technology'),
  ('corvis_sector_v1','software and services','technology'),
  ('corvis_sector_v1','tmt','technology'),
  ('corvis_sector_v1','semiconductors','technology'),
  ('corvis_sector_v1','healthcare','healthcare'),
  ('corvis_sector_v1','health care','healthcare'),
  ('corvis_sector_v1','life sciences','healthcare'),
  ('corvis_sector_v1','pharmaceuticals','healthcare'),
  ('corvis_sector_v1','biotechnology','healthcare'),
  ('corvis_sector_v1','medical devices','healthcare'),
  ('corvis_sector_v1','financials','financials'),
  ('corvis_sector_v1','financial services','financials'),
  ('corvis_sector_v1','insurance','financials'),
  ('corvis_sector_v1','banking','financials'),
  ('corvis_sector_v1','industrials','industrials'),
  ('corvis_sector_v1','industrial','industrials'),
  ('corvis_sector_v1','business services','industrials'),
  ('corvis_sector_v1','aerospace and defense','industrials'),
  ('corvis_sector_v1','transportation','industrials'),
  ('corvis_sector_v1','logistics','industrials'),
  ('corvis_sector_v1','consumer discretionary','consumer_discretionary'),
  ('corvis_sector_v1','consumer','consumer_discretionary'),
  ('corvis_sector_v1','retail','consumer_discretionary'),
  ('corvis_sector_v1','leisure','consumer_discretionary'),
  ('corvis_sector_v1','education','consumer_discretionary'),
  ('corvis_sector_v1','consumer staples','consumer_staples'),
  ('corvis_sector_v1','food and beverage','consumer_staples'),
  ('corvis_sector_v1','communication services','communication_services'),
  ('corvis_sector_v1','communications','communication_services'),
  ('corvis_sector_v1','media','communication_services'),
  ('corvis_sector_v1','telecommunications','communication_services'),
  ('corvis_sector_v1','telecom','communication_services'),
  ('corvis_sector_v1','energy','energy'),
  ('corvis_sector_v1','oil and gas','energy'),
  ('corvis_sector_v1','materials','materials'),
  ('corvis_sector_v1','chemicals','materials'),
  ('corvis_sector_v1','real estate','real_estate'),
  ('corvis_sector_v1','property','real_estate'),
  ('corvis_sector_v1','utilities','utilities'),
  ('corvis_sector_v1','infrastructure and utilities','utilities')
on conflict (taxonomy_version, alias_normalized) do nothing;

create table if not exists corvis_facts.company_sector_classification (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  classification_id uuid not null default gen_random_uuid(),
  company_id text not null references corvis_identity.company(global_company_id),
  taxonomy_version text not null,
  sector_code text not null,
  basis text not null check (basis in ('reviewer_assigned')),
  version integer not null check (version > 0),
  reason text not null check (btrim(reason) <> ''),
  classified_by text not null check (btrim(classified_by) <> ''),
  classified_at timestamptz not null default now(),
  superseded_at timestamptz,
  primary key (tenant_id, classification_id),
  unique (tenant_id, company_id, version),
  foreign key (taxonomy_version, sector_code)
    references corvis_semantic.sector(taxonomy_version, sector_code),
  check (superseded_at is null or superseded_at >= classified_at)
);

alter table corvis_facts.company_sector_classification enable row level security;
alter table corvis_facts.company_sector_classification force row level security;

create policy company_sector_classification_tenant_select
  on corvis_facts.company_sector_classification for select
  using (corvis_control.has_tenant_access(tenant_id));

-- At most one current classification per company.
create unique index if not exists company_sector_classification_current_idx
  on corvis_facts.company_sector_classification (tenant_id, company_id)
  where superseded_at is null;

-- History is immutable: the only permitted update closes the current row.
create or replace function corvis_facts.guard_company_sector_classification()
returns trigger
language plpgsql
as $$
begin
  if old.superseded_at is not null
     or new.superseded_at is null
     or (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at') then
    raise exception 'company sector classifications are append-only; only superseding the current row is allowed';
  end if;
  return new;
end;
$$;

drop trigger if exists company_sector_classification_append_only on corvis_facts.company_sector_classification;
create trigger company_sector_classification_append_only
  before update on corvis_facts.company_sector_classification
  for each row execute function corvis_facts.guard_company_sector_classification();

-- Returns the new classification version, or null when p_expected_version is
-- not the company's current version (0 = never classified), which the
-- application reports as a 409 conflict.
create or replace function corvis_facts.assign_company_sector(
  p_tenant_id uuid,
  p_company_id text,
  p_sector_code text,
  p_expected_version integer,
  p_actor_subject text,
  p_reason text
)
returns integer
language plpgsql
security invoker
as $$
declare
  current_row corvis_facts.company_sector_classification%rowtype;
  current_version integer;
  next_version integer;
begin
  if p_reason is null or btrim(p_reason) = '' then raise exception 'sector classification reason is required'; end if;
  if p_actor_subject is null or btrim(p_actor_subject) = '' then raise exception 'sector classification actor is required'; end if;
  if not exists (
    select 1 from corvis_semantic.sector s
    where s.taxonomy_version = 'corvis_sector_v1' and s.sector_code = p_sector_code
  ) then
    raise exception 'unknown sector code';
  end if;

  -- Serialize assignments per company so two first-time classifications
  -- cannot both see version 0.
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':company_sector:' || p_company_id, 0));

  select * into current_row
  from corvis_facts.company_sector_classification c
  where c.tenant_id = p_tenant_id and c.company_id = p_company_id and c.superseded_at is null
  for update;
  current_version := case when found then current_row.version else 0 end;
  if current_version <> p_expected_version then return null; end if;
  next_version := current_version + 1;

  if current_version > 0 then
    update corvis_facts.company_sector_classification
    set superseded_at = now()
    where tenant_id = p_tenant_id and classification_id = current_row.classification_id;
  end if;

  insert into corvis_facts.company_sector_classification
    (tenant_id, company_id, taxonomy_version, sector_code, basis, version, reason, classified_by)
  values
    (p_tenant_id, p_company_id, 'corvis_sector_v1', p_sector_code, 'reviewer_assigned', next_version, btrim(p_reason), p_actor_subject);

  return next_version;
end;
$$;

create or replace view corvis_serving.company_sectors
with (security_invoker=true) as
select c.tenant_id, c.company_id, c.taxonomy_version, c.sector_code, s.display_name as sector_name,
       c.basis, c.version, c.classified_by, c.classified_at
from corvis_facts.company_sector_classification c
join corvis_semantic.sector s
  on s.taxonomy_version = c.taxonomy_version and s.sector_code = c.sector_code
where c.superseded_at is null;

commit;
