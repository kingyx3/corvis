-- Fix PL/pgSQL variable/column ambiguity in canonicalization.
-- Depends on migrations 001-041.
--
-- canonicalize_reviewed_extraction has output/local variables whose names overlap
-- table columns. PostgreSQL correctly treats those unqualified references as
-- ambiguous at runtime. Preserve the existing reviewed/correction-replay semantics
-- and qualify the affected persistence/review references in a forward migration.

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
    E'select review_event_id,correction_payload\n      into correction_event_id,correction_payload\n    from corvis_review.candidate_review_event\n    where tenant_id=p_tenant_id\n      and extraction_run_id=p_extraction_run_id\n      and candidate_id=candidate_row.candidate_id\n      and review_policy_version=p_review_policy_version\n      and decision=''correct''\n    order by event_sequence desc',
    E'select cre.review_event_id,cre.correction_payload\n      into correction_event_id,correction_payload\n    from corvis_review.candidate_review_event cre\n    where cre.tenant_id=p_tenant_id\n      and cre.extraction_run_id=p_extraction_run_id\n      and cre.candidate_id=candidate_row.candidate_id\n      and cre.review_policy_version=p_review_policy_version\n      and cre.decision=''correct''\n    order by cre.event_sequence desc'
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
    or position('where tenant_id=p_tenant_id and canonicalization_run_id=canonical_run_id' in patched) > 0
    or position('select review_event_id,correction_payload' in patched) > 0 then
    raise exception 'migration 042 left an ambiguous canonicalization reference';
  end if;

  execute patched;
end
$migration$;

commit;
