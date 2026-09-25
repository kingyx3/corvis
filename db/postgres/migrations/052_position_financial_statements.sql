-- Corvis position financial-statement model v1
-- Depends on migrations 001-051.
--
-- The canonical metric-observation model remains the semantic fact model. This
-- migration adds a presentation-preserving statement layer so a client can
-- reconstruct every disclosed portfolio-company statement row, including rows
-- that intentionally have no governed metric mapping yet.

begin;

alter table corvis_source.extraction_candidate
  drop constraint if exists extraction_candidate_candidate_type_check;
alter table corvis_source.extraction_candidate
  add constraint extraction_candidate_candidate_type_check check (candidate_type in (
    'fund','company','holding','instrument','lifecycle_event','metric_observation',
    'financial_statement_line','exception'
  ));

create table if not exists corvis_facts.position_financial_statement (
  tenant_id uuid not null references corvis_control.tenant(tenant_id),
  statement_id uuid not null,
  canonicalization_run_id uuid not null,
  extraction_run_id uuid not null,
  document_id uuid not null,
  fund_id text not null,
  holding_id text not null,
  company_id text not null,
  statement_type text not null check (statement_type in (
    'income_statement','balance_sheet','cash_flow_statement','statement_of_equity','other'
  )),
  statement_key text not null,
  source_title text,
  report_period text not null,
  source_document_period_end date,
  source_version_status text,
  review_policy_version text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, statement_id),
  foreign key (tenant_id, canonicalization_run_id)
    references corvis_facts.canonicalization_run(tenant_id, canonicalization_run_id),
  foreign key (tenant_id, extraction_run_id)
    references corvis_source.extraction_run(tenant_id, extraction_run_id),
  foreign key (tenant_id, document_id)
    references corvis_source.document(tenant_id, document_id),
  unique (tenant_id, extraction_run_id, statement_key),
  check (btrim(statement_key) <> ''),
  check (btrim(report_period) <> '')
);

create table if not exists corvis_facts.position_financial_statement_line (
  tenant_id uuid not null,
  statement_id uuid not null,
  line_id uuid not null,
  line_key text not null,
  semantic_line_key text not null,
  source_label text not null,
  metric_code text,
  line_role text not null default 'line_item' check (line_role in (
    'line_item','subtotal','total','header','memorandum','other'
  )),
  parent_line_key text,
  display_order integer not null check (display_order >= 0),
  depth integer not null default 0 check (depth >= 0),
  source_reference_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (tenant_id, line_id),
  foreign key (tenant_id, statement_id)
    references corvis_facts.position_financial_statement(tenant_id, statement_id),
  unique (tenant_id, statement_id, line_key),
  check (btrim(line_key) <> ''),
  check (btrim(semantic_line_key) <> ''),
  check (btrim(source_label) <> '')
);

create table if not exists corvis_facts.position_financial_statement_value (
  tenant_id uuid not null,
  statement_id uuid not null,
  line_id uuid not null,
  value_id uuid not null,
  candidate_id uuid not null,
  candidate_type text not null,
  value_raw text,
  value_number numeric(38,10),
  value_string text,
  value_qualifier text,
  currency text,
  unit text,
  reported_multiplier text,
  source_precision text,
  value_nature text,
  period_type text,
  period_start date,
  period_end date,
  as_of_date date,
  fiscal_year integer,
  fiscal_quarter integer check (fiscal_quarter is null or fiscal_quarter between 1 and 4),
  source_document_period_end date,
  source_column_label text,
  actuality text,
  scenario_type text,
  source_version_status text,
  preliminary boolean not null default false,
  is_restatement boolean not null default false,
  is_re_reported_prior_period boolean not null default false,
  is_derived boolean not null default false,
  derivation_formula text,
  source_reference_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (tenant_id, value_id),
  foreign key (tenant_id, statement_id)
    references corvis_facts.position_financial_statement(tenant_id, statement_id),
  foreign key (tenant_id, line_id)
    references corvis_facts.position_financial_statement_line(tenant_id, line_id),
  unique (tenant_id, statement_id, line_id, candidate_id),
  check (value_number is not null or value_string is not null or value_raw is not null)
);

alter table corvis_facts.position_financial_statement enable row level security;
alter table corvis_facts.position_financial_statement force row level security;
alter table corvis_facts.position_financial_statement_line enable row level security;
alter table corvis_facts.position_financial_statement_line force row level security;
alter table corvis_facts.position_financial_statement_value enable row level security;
alter table corvis_facts.position_financial_statement_value force row level security;

create policy position_financial_statement_tenant_select
  on corvis_facts.position_financial_statement for select
  using (corvis_control.has_tenant_access(tenant_id));
create policy position_financial_statement_line_tenant_select
  on corvis_facts.position_financial_statement_line for select
  using (corvis_control.has_tenant_access(tenant_id));
create policy position_financial_statement_value_tenant_select
  on corvis_facts.position_financial_statement_value for select
  using (corvis_control.has_tenant_access(tenant_id));

create index if not exists position_financial_statement_position_idx
  on corvis_facts.position_financial_statement
    (tenant_id, fund_id, holding_id, statement_type, source_document_period_end desc);
create index if not exists position_financial_statement_company_idx
  on corvis_facts.position_financial_statement
    (tenant_id, company_id, statement_type, source_document_period_end desc);
create index if not exists position_financial_statement_line_order_idx
  on corvis_facts.position_financial_statement_line
    (tenant_id, statement_id, display_order, line_id);
create index if not exists position_financial_statement_value_period_idx
  on corvis_facts.position_financial_statement_value
    (tenant_id, statement_id, period_type, fiscal_year, fiscal_quarter, period_end);

create or replace function corvis_facts.materialize_position_financial_statement_candidate()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, corvis_facts, corvis_source
as $$
declare
  p jsonb := new.effective_payload;
  v_statement_type text;
  v_statement_key text;
  v_line_key text;
  v_semantic_line_key text;
  v_source_label text;
  v_metric_code text;
  v_line_role text;
  v_report_period text;
  v_document_id uuid;
  v_statement_id uuid;
  v_line_id uuid;
  v_value_id uuid;
  v_display_order integer;
  v_depth integer;
  v_value_number numeric(38,10);
  v_value_number_text text;
  v_value_raw text;
  v_value_string text;
  v_source_document_period_end date;
begin
  if new.candidate_type not in ('metric_observation','financial_statement_line') then
    return new;
  end if;

  v_statement_type := nullif(btrim(coalesce(p ->> 'statement_type', p ->> 'statementType', '')), '');
  if v_statement_type is null then return new; end if;
  if v_statement_type not in ('income_statement','balance_sheet','cash_flow_statement','statement_of_equity','other') then
    raise exception 'unsupported financial statement type: %', v_statement_type;
  end if;

  v_statement_key := nullif(btrim(coalesce(p ->> 'statement_key', p ->> 'statementKey', '')), '');
  v_line_key := nullif(btrim(coalesce(p ->> 'statement_line_key', p ->> 'line_key', p ->> 'statementLineKey', '')), '');
  v_source_label := nullif(btrim(coalesce(p ->> 'statement_line_label', p ->> 'metric_label_original', p ->> 'line_label', '')), '');
  if v_statement_key is null or v_line_key is null or v_source_label is null then
    raise exception 'financial statement candidate requires statement_key, statement_line_key and statement_line_label';
  end if;

  v_metric_code := nullif(btrim(coalesce(p ->> 'metric_code', p ->> 'metricCode', '')), '');
  v_semantic_line_key := nullif(btrim(coalesce(p ->> 'semantic_line_key', p ->> 'semanticLineKey', v_metric_code, '')), '');
  if v_semantic_line_key is null then
    v_semantic_line_key := lower(regexp_replace(v_source_label, '[^[:alnum:]]+', '_', 'g'));
  end if;
  v_line_role := coalesce(nullif(btrim(coalesce(p ->> 'statement_line_role', p ->> 'line_role', '')), ''), 'line_item');
  if v_line_role not in ('line_item','subtotal','total','header','memorandum','other') then
    raise exception 'unsupported financial statement line role: %', v_line_role;
  end if;

  begin v_display_order := coalesce((p ->> 'display_order')::integer, (p ->> 'statement_line_order')::integer, 0);
  exception when invalid_text_representation then raise exception 'financial statement display_order must be an integer'; end;
  begin v_depth := coalesce((p ->> 'depth')::integer, (p ->> 'statement_line_depth')::integer, 0);
  exception when invalid_text_representation then raise exception 'financial statement depth must be an integer'; end;

  select r.document_id,d.report_period into v_document_id,v_report_period
  from corvis_source.extraction_run r
  join corvis_source.document d on d.tenant_id=r.tenant_id and d.document_id=r.document_id
  where r.tenant_id=new.tenant_id and r.extraction_run_id=new.extraction_run_id;
  v_report_period := coalesce(nullif(btrim(coalesce(p ->> 'report_period','')), ''), v_report_period);
  if v_document_id is null or v_report_period is null or btrim(v_report_period)='' then
    raise exception 'financial statement candidate requires a resolved source document report period';
  end if;
  if nullif(btrim(coalesce(p ->> 'fund_id','')), '') is null
     or nullif(btrim(coalesce(p ->> 'holding_id','')), '') is null
     or nullif(btrim(coalesce(p ->> 'company_id','')), '') is null then
    raise exception 'financial statement candidate requires resolved fund_id, holding_id and company_id';
  end if;

  begin v_source_document_period_end := nullif(p ->> 'source_document_period_end','')::date;
  exception when invalid_datetime_format then raise exception 'invalid source_document_period_end on financial statement candidate'; end;

  v_statement_id := md5(new.tenant_id::text || ':' || new.extraction_run_id::text || ':' || v_statement_key)::uuid;
  v_line_id := md5(v_statement_id::text || ':' || v_line_key)::uuid;
  v_value_id := md5(v_statement_id::text || ':' || v_line_key || ':' || new.candidate_id::text)::uuid;

  insert into corvis_facts.position_financial_statement (
    tenant_id,statement_id,canonicalization_run_id,extraction_run_id,document_id,
    fund_id,holding_id,company_id,statement_type,statement_key,source_title,report_period,
    source_document_period_end,source_version_status,review_policy_version
  ) values (
    new.tenant_id,v_statement_id,new.canonicalization_run_id,new.extraction_run_id,v_document_id,
    p ->> 'fund_id',p ->> 'holding_id',p ->> 'company_id',v_statement_type,v_statement_key,
    nullif(btrim(coalesce(p ->> 'statement_title','')), ''),v_report_period,
    v_source_document_period_end,nullif(btrim(coalesce(p ->> 'source_version_status','')), ''),new.review_policy_version
  ) on conflict (tenant_id,statement_id) do nothing;

  if not exists (
    select 1 from corvis_facts.position_financial_statement s
    where s.tenant_id=new.tenant_id and s.statement_id=v_statement_id
      and s.extraction_run_id=new.extraction_run_id and s.document_id=v_document_id
      and s.fund_id=p ->> 'fund_id' and s.holding_id=p ->> 'holding_id'
      and s.company_id=p ->> 'company_id' and s.statement_type=v_statement_type
      and s.statement_key=v_statement_key and s.report_period=v_report_period
  ) then
    raise exception 'financial statement identity conflicts within one extraction run';
  end if;

  insert into corvis_facts.position_financial_statement_line (
    tenant_id,statement_id,line_id,line_key,semantic_line_key,source_label,metric_code,line_role,
    parent_line_key,display_order,depth,source_reference_ids
  ) values (
    new.tenant_id,v_statement_id,v_line_id,v_line_key,v_semantic_line_key,v_source_label,v_metric_code,v_line_role,
    nullif(btrim(coalesce(p ->> 'parent_line_key','')), ''),v_display_order,v_depth,new.source_reference_ids
  ) on conflict (tenant_id,statement_id,line_key) do nothing;

  if not exists (
    select 1 from corvis_facts.position_financial_statement_line l
    where l.tenant_id=new.tenant_id and l.statement_id=v_statement_id and l.line_id=v_line_id
      and l.line_key=v_line_key and l.semantic_line_key=v_semantic_line_key and l.source_label=v_source_label
      and l.metric_code is not distinct from v_metric_code and l.line_role=v_line_role
      and l.parent_line_key is not distinct from nullif(btrim(coalesce(p ->> 'parent_line_key','')), '')
      and l.display_order=v_display_order and l.depth=v_depth
  ) then
    raise exception 'financial statement line presentation conflicts within one statement';
  end if;

  v_value_raw := nullif(p ->> 'value_raw','');
  v_value_string := nullif(coalesce(p ->> 'value_string',p ->> 'value_text'),'');
  v_value_number_text := nullif(btrim(coalesce(p ->> 'value_numeric',p ->> 'value_number','')), '');
  if v_value_number_text is not null then
    if v_value_number_text !~ '^[-+]?[0-9]+([.][0-9]+)?$' then
      raise exception 'financial statement value_numeric must be normalized decimal text';
    end if;
    v_value_number := v_value_number_text::numeric;
  end if;

  if v_value_raw is not null or v_value_string is not null or v_value_number is not null then
    insert into corvis_facts.position_financial_statement_value (
      tenant_id,statement_id,line_id,value_id,candidate_id,candidate_type,value_raw,value_number,value_string,
      value_qualifier,currency,unit,reported_multiplier,source_precision,value_nature,period_type,
      period_start,period_end,as_of_date,fiscal_year,fiscal_quarter,source_document_period_end,source_column_label,
      actuality,scenario_type,source_version_status,preliminary,is_restatement,is_re_reported_prior_period,
      is_derived,derivation_formula,source_reference_ids
    ) values (
      new.tenant_id,v_statement_id,v_line_id,v_value_id,new.candidate_id,new.candidate_type,v_value_raw,v_value_number,v_value_string,
      nullif(p ->> 'value_qualifier',''),nullif(p ->> 'currency',''),nullif(p ->> 'unit',''),
      nullif(p ->> 'reported_multiplier',''),nullif(p ->> 'source_precision',''),nullif(p ->> 'value_nature',''),
      nullif(p ->> 'period_type',''),nullif(p ->> 'period_start','')::date,nullif(p ->> 'period_end','')::date,
      nullif(p ->> 'as_of_date','')::date,nullif(p ->> 'fiscal_year','')::integer,nullif(p ->> 'fiscal_quarter','')::integer,
      v_source_document_period_end,nullif(coalesce(p ->> 'source_column_label',p ->> 'column_label'),''),
      nullif(p ->> 'actuality',''),nullif(p ->> 'scenario_type',''),nullif(p ->> 'source_version_status',''),
      coalesce((p ->> 'preliminary')::boolean,false),coalesce((p ->> 'is_restatement')::boolean,false),
      coalesce((p ->> 'is_re_reported_prior_period')::boolean,false),coalesce((p ->> 'is_derived')::boolean,false),
      nullif(p ->> 'derivation_formula',''),new.source_reference_ids
    ) on conflict (tenant_id,statement_id,line_id,candidate_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists canonical_candidate_position_financial_statement on corvis_facts.canonical_candidate;
create trigger canonical_candidate_position_financial_statement
after insert on corvis_facts.canonical_candidate
for each row execute function corvis_facts.materialize_position_financial_statement_candidate();

create or replace view corvis_serving.position_financial_statement_values as
select
  s.tenant_id,s.statement_id,s.canonicalization_run_id,s.extraction_run_id,s.document_id,
  s.fund_id,s.holding_id,s.company_id,s.statement_type,s.statement_key,s.source_title,s.report_period,
  s.source_document_period_end as statement_source_document_period_end,s.source_version_status as statement_source_version_status,
  l.line_id,l.line_key,l.semantic_line_key,l.source_label,l.metric_code,l.line_role,l.parent_line_key,l.display_order,l.depth,
  v.value_id,v.candidate_id,v.candidate_type,v.value_raw,v.value_number,v.value_string,v.value_qualifier,
  v.currency,v.unit,v.reported_multiplier,v.source_precision,v.value_nature,v.period_type,v.period_start,v.period_end,
  v.as_of_date,v.fiscal_year,v.fiscal_quarter,v.source_document_period_end,v.source_column_label,v.actuality,v.scenario_type,
  v.source_version_status,v.preliminary,v.is_restatement,v.is_re_reported_prior_period,v.is_derived,v.derivation_formula,
  coalesce(v.source_reference_ids,l.source_reference_ids) as source_reference_ids,
  sr.page_number,sr.sheet_name,sr.cell_range,sr.section_title,sr.table_title,sr.row_label,sr.column_label,sr.footnote_marker
from corvis_facts.position_financial_statement s
join corvis_facts.position_financial_statement_line l
  on l.tenant_id=s.tenant_id and l.statement_id=s.statement_id
left join corvis_facts.position_financial_statement_value v
  on v.tenant_id=l.tenant_id and v.statement_id=l.statement_id and v.line_id=l.line_id
left join corvis_source.source_reference sr
  on sr.tenant_id=l.tenant_id and sr.source_reference_id=coalesce(v.source_reference_ids[1],l.source_reference_ids[1]);

commit;
