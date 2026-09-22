-- Fix PL/pgSQL output-column ambiguity in canonicalization.
-- Depends on migrations 001-041.
--
-- canonicalize_reviewed_extraction returns a column named canonicalization_run_id.
-- Unqualified references to the same table column therefore fail at runtime under
-- PostgreSQL's default variable-conflict policy. Preserve the existing reviewed /
-- correction-replay semantics and qualify the affected persistence references.

begin;

do $migration$
declare
  source text;
  patched text;
begin
  source := pg_get_functiondef(
    'corvis_facts.canonicalize_reviewed_extraction(uuid,uuid,uuid,text,text,text,text)'::regprocedure
  );
  patched := source;

  patched := replace(
    patched,
    'on conflict (tenant_id,canonicalization_run_id) do nothing',
    'on conflict on constraint canonicalization_run_pkey do nothing'
  );

  patched := replace(
    patched,
    'on conflict (tenant_id,canonicalization_run_id,candidate_id) do nothing',
    'on conflict on constraint canonical_candidate_pkey do nothing'
  );

  patched := replace(
    patched,
    E'from corvis_facts.canonicalization_run\n  where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id\n  for update;',
    E'from corvis_facts.canonicalization_run cr\n  where cr.tenant_id=p_tenant_id and cr.canonicalization_run_id=canonical_run_id\n  for update;'
  );

  patched := replace(
    patched,
    E'from corvis_facts.canonical_candidate\n  where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id;',
    E'from corvis_facts.canonical_candidate cc\n  where cc.tenant_id=p_tenant_id and cc.canonicalization_run_id=canonical_run_id;'
  );

  patched := replace(
    patched,
    E'update corvis_facts.canonicalization_run\n  set status=''ready'',canonical_candidate_count=actual_candidate_count,\n      observation_count=actual_observation_count,source_reference_count=actual_reference_count,\n      completed_at=coalesce(completed_at,now())\n  where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id and status=''writing''',
    E'update corvis_facts.canonicalization_run cr\n  set status=''ready'',canonical_candidate_count=actual_candidate_count,\n      observation_count=actual_observation_count,source_reference_count=actual_reference_count,\n      completed_at=coalesce(cr.completed_at,now())\n  where cr.tenant_id=p_tenant_id and cr.canonicalization_run_id=canonical_run_id and cr.status=''writing'''
  );

  patched := replace(
    patched,
    E'select * into existing_run from corvis_facts.canonicalization_run\n    where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id;',
    E'select * into existing_run from corvis_facts.canonicalization_run cr\n    where cr.tenant_id=p_tenant_id and cr.canonicalization_run_id=canonical_run_id;'
  );

  if patched = source then
    raise exception 'migration 042 could not locate canonicalization ambiguity sites';
  end if;
  if position('on conflict (tenant_id,canonicalization_run_id)' in patched) > 0
    or position('on conflict (tenant_id,canonicalization_run_id,candidate_id)' in patched) > 0
    or position('where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id' in patched) > 0 then
    raise exception 'migration 042 left an ambiguous canonicalization_run_id reference';
  end if;

  execute patched;
end
$migration$;

commit;
