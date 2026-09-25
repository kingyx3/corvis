-- Corvis client portfolio attribution layer v1
-- Depends on migrations 001-052.
--
-- This layer sits ABOVE the canonical fund -> holding -> company/fund graph.
-- A client portfolio groups one or more invested fund positions. It attributes
-- the holdings reachable through those funds to the portfolio without rewriting,
-- cloning or ownership-weighting underlying fund/company facts. In particular,
-- company revenue/EBITDA and other operating facts remain 100% source-reported
-- company facts; ownership and position-size observations remain attached to the
-- relevant canonical holding/instrument.

begin;

create table if not exists corvis_facts.client_portfolio (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  workspace_id uuid not null,
  portfolio_id uuid not null default gen_random_uuid(),
  portfolio_key text not null,
  display_name text not null,
  base_currency text,
  external_portfolio_id text,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,portfolio_id),
  foreign key (tenant_id,workspace_id)
    references corvis_control.workspace(tenant_id,workspace_id),
  unique (tenant_id,workspace_id,portfolio_key),
  check (btrim(portfolio_key) <> ''),
  check (btrim(display_name) <> ''),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table if not exists corvis_facts.client_portfolio_fund_position (
  tenant_id uuid not null,
  portfolio_fund_position_id uuid not null default gen_random_uuid(),
  portfolio_id uuid not null,
  position_key text not null,
  fund_id text not null,
  position_label text,
  external_position_id text,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,portfolio_fund_position_id),
  foreign key (tenant_id,portfolio_id)
    references corvis_facts.client_portfolio(tenant_id,portfolio_id),
  foreign key (fund_id)
    references corvis_identity.fund(global_fund_id),
  unique (tenant_id,portfolio_id,position_key),
  check (btrim(position_key) <> ''),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

alter table corvis_facts.client_portfolio enable row level security;
alter table corvis_facts.client_portfolio force row level security;
alter table corvis_facts.client_portfolio_fund_position enable row level security;
alter table corvis_facts.client_portfolio_fund_position force row level security;

create policy client_portfolio_workspace_select
  on corvis_facts.client_portfolio for select
  using (corvis_control.has_workspace_access(tenant_id,workspace_id));

create policy client_portfolio_fund_workspace_select
  on corvis_facts.client_portfolio_fund_position for select
  using (exists (
    select 1
    from corvis_facts.client_portfolio p
    where p.tenant_id=client_portfolio_fund_position.tenant_id
      and p.portfolio_id=client_portfolio_fund_position.portfolio_id
      and corvis_control.has_workspace_access(p.tenant_id,p.workspace_id)
  ));

-- No direct client write policies are intentionally created. Portfolio setup is
-- a governed server/import concern; membership must never become an entitlement.

create index if not exists client_portfolio_workspace_status_idx
  on corvis_facts.client_portfolio (tenant_id,workspace_id,status,display_name,portfolio_id);
create index if not exists client_portfolio_fund_portfolio_idx
  on corvis_facts.client_portfolio_fund_position (tenant_id,portfolio_id,fund_id,portfolio_fund_position_id);
create index if not exists client_portfolio_fund_fund_idx
  on corvis_facts.client_portfolio_fund_position (tenant_id,fund_id,portfolio_id);

create or replace view corvis_serving.client_portfolios as
select tenant_id,workspace_id,portfolio_id,portfolio_key,display_name,base_currency,
       external_portfolio_id,status,valid_from,valid_to,created_at,updated_at
from corvis_facts.client_portfolio
where status='active'
  and (valid_from is null or valid_from <= current_date)
  and (valid_to is null or valid_to >= current_date);

create or replace view corvis_serving.client_portfolio_fund_positions as
select pf.tenant_id,p.workspace_id,pf.portfolio_fund_position_id,pf.portfolio_id,
       pf.position_key,pf.fund_id,pf.position_label,pf.external_position_id,
       pf.valid_from,pf.valid_to,pf.created_at,pf.updated_at
from corvis_facts.client_portfolio_fund_position pf
join corvis_serving.client_portfolios p
  on p.tenant_id=pf.tenant_id and p.portfolio_id=pf.portfolio_id
where (pf.valid_from is null or pf.valid_from <= current_date)
  and (pf.valid_to is null or pf.valid_to >= current_date);

-- Preserve every fund/holding path. The same company may therefore appear more
-- than once in one portfolio when different invested funds hold it. Those rows
-- are intentionally NOT collapsed: fund-specific ownership/position-size facts
-- belong to each canonical holding and remain available through holding metrics.
-- No operating metric is multiplied by ownership, LP interest or path weights.
create or replace view corvis_serving.client_portfolio_holding_attribution as
with recursive fund_path as (
  select
    pf.tenant_id,
    pf.workspace_id,
    pf.portfolio_id,
    pf.portfolio_fund_position_id,
    pf.fund_id as root_fund_id,
    pf.fund_id as owning_fund_id,
    array[pf.fund_id]::text[] as fund_path,
    array[]::uuid[] as parent_holding_path,
    0::integer as lookthrough_depth
  from corvis_serving.client_portfolio_fund_positions pf

  union all

  select
    fp.tenant_id,
    fp.workspace_id,
    fp.portfolio_id,
    fp.portfolio_fund_position_id,
    fp.root_fund_id,
    h.target_fund_id as owning_fund_id,
    fp.fund_path || h.target_fund_id,
    fp.parent_holding_path || h.holding_id,
    fp.lookthrough_depth + 1
  from fund_path fp
  join corvis_serving.holdings h
    on h.tenant_id=fp.tenant_id
   and h.fund_id=fp.owning_fund_id
   and h.target_type='fund'
   and h.target_fund_id is not null
  where fp.lookthrough_depth < 15
    and not (h.target_fund_id = any(fp.fund_path))
)
select
  md5(
    fp.tenant_id::text || ':' || fp.portfolio_id::text || ':' ||
    fp.portfolio_fund_position_id::text || ':' || h.holding_id::text || ':' ||
    array_to_string(fp.fund_path,'>')
  ) as attribution_key,
  fp.tenant_id,
  fp.workspace_id,
  fp.portfolio_id,
  fp.portfolio_fund_position_id,
  fp.root_fund_id,
  fp.owning_fund_id,
  h.holding_id,
  h.target_type,
  h.target_company_id,
  h.target_fund_id,
  h.status as holding_status,
  h.investment_date,
  h.strategy,
  h.geography,
  h.source_reference_id,
  h.valid_from as holding_valid_from,
  h.valid_to as holding_valid_to,
  fp.fund_path,
  fp.parent_holding_path || h.holding_id as holding_path,
  fp.lookthrough_depth
from fund_path fp
join corvis_serving.holdings h
  on h.tenant_id=fp.tenant_id
 and h.fund_id=fp.owning_fund_id;

commit;
