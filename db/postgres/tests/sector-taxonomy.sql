-- Acceptance for migration 055: company sector classifications are assigned
-- only through corvis_facts.assign_company_sector with optimistic
-- concurrency, keep exactly one current row per company, preserve every
-- prior version as immutable history, and reject codes outside the
-- governed taxonomy. Run after the full migration chain on an isolated
-- disposable database. Rolled back.

\set ON_ERROR_STOP on

begin;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('a0550000-0000-4000-8000-000000000001','sector-taxonomy-ci','Sector Taxonomy CI');
insert into corvis_identity.company (global_company_id,canonical_name)
values ('company-sector-ci','Sector CI Holdings')
on conflict (global_company_id) do nothing;

do $$
declare
  tenant uuid := 'a0550000-0000-4000-8000-000000000001';
  assigned integer;
  raised boolean;
begin
  -- The seed matches the eleven-sector v1 taxonomy and resolves aliases.
  if (select count(*) from corvis_semantic.sector where taxonomy_version='corvis_sector_v1') <> 11 then
    raise exception 'corvis_sector_v1 must seed exactly eleven sectors';
  end if;
  if (select sector_code from corvis_semantic.sector_alias
      where taxonomy_version='corvis_sector_v1' and alias_normalized=corvis_semantic.normalize_sector_label(' Health-Care ')) <> 'healthcare' then
    raise exception 'GP label normalization must resolve "Health-Care" to healthcare';
  end if;

  -- First classification expects version 0.
  assigned := corvis_facts.assign_company_sector(tenant,'company-sector-ci','technology',0,'ci|reviewer-1','initial classification');
  if assigned is distinct from 1 then raise exception 'first assignment must return version 1, got %', assigned; end if;

  -- A stale expected version is a conflict, not a silent overwrite.
  assigned := corvis_facts.assign_company_sector(tenant,'company-sector-ci','healthcare',0,'ci|reviewer-2','stale');
  if assigned is not null then raise exception 'a stale expected version must return null'; end if;

  -- Reassignment supersedes the current row and appends version 2.
  assigned := corvis_facts.assign_company_sector(tenant,'company-sector-ci','healthcare',1,'ci|reviewer-2','GP reclassified as medtech');
  if assigned is distinct from 2 then raise exception 'reassignment must return version 2, got %', assigned; end if;
  if (select count(*) from corvis_facts.company_sector_classification where tenant_id=tenant and company_id='company-sector-ci') <> 2 then
    raise exception 'history must keep both versions';
  end if;
  if (select count(*) from corvis_facts.company_sector_classification
      where tenant_id=tenant and company_id='company-sector-ci' and superseded_at is null) <> 1 then
    raise exception 'exactly one classification may be current';
  end if;
  if (select sector_code from corvis_serving.company_sectors where tenant_id=tenant and company_id='company-sector-ci') <> 'healthcare' then
    raise exception 'the serving view must expose only the current classification';
  end if;

  -- Unknown sector codes and empty reasons are refused.
  raised := false;
  begin
    perform corvis_facts.assign_company_sector(tenant,'company-sector-ci','crypto',2,'ci|reviewer-1','not governed');
  exception when others then
    if sqlerrm <> 'unknown sector code' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'an ungoverned sector code must be refused'; end if;
  raised := false;
  begin
    perform corvis_facts.assign_company_sector(tenant,'company-sector-ci','energy',2,'ci|reviewer-1','  ');
  exception when others then
    if sqlerrm <> 'sector classification reason is required' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'a blank reason must be refused'; end if;

  -- Superseded history is immutable, and a current row can only be closed.
  raised := false;
  begin
    update corvis_facts.company_sector_classification set sector_code='energy'
    where tenant_id=tenant and company_id='company-sector-ci' and version=1;
  exception when others then
    if sqlerrm not like 'company sector classifications are append-only%' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'superseded history must be immutable'; end if;
  raised := false;
  begin
    update corvis_facts.company_sector_classification set sector_code='energy'
    where tenant_id=tenant and company_id='company-sector-ci' and superseded_at is null;
  exception when others then
    if sqlerrm not like 'company sector classifications are append-only%' then raise; end if;
    raised := true;
  end;
  if not raised then raise exception 'a current classification must not be rewritten in place'; end if;
end;
$$;

rollback;
