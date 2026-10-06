-- Acceptance: corvis_control.control_evidence_record is append-only.
--
-- Every other audit/evidence table in this schema (review_item_comment, reconciliation_exception's
-- resolution ledger, etc.) has a dedicated acceptance test asserting its append-only trigger guard
-- actually fires with the expected error text. control_evidence_record's guard
-- (corvis_control.reject_control_evidence_mutation(), trigger control_evidence_record_append_only)
-- had no such coverage: a typo in the trigger definition or a migration that dropped it would pass
-- every other suite silently. This proves UPDATE, DELETE and TRUNCATE are all rejected.
--
-- Run after supabase-auth-fixture.sql and the full migration chain. Everything is rolled back.

\set ON_ERROR_STOP on

begin;

create function pg_temp.expect_error(statement text, fragment text) returns void language plpgsql as $$
declare
  raised text;
begin
  begin
    execute statement;
  exception when others then
    raised := sqlerrm;
  end;
  if raised is null then
    raise exception 'expected failure containing "%" but the statement succeeded: %', fragment, statement;
  end if;
  if position(fragment in raised) = 0 then
    raise exception 'expected failure containing "%" but got "%"', fragment, raised;
  end if;
end;
$$;

insert into corvis_control.tenant (tenant_id,slug,display_name)
values ('c0e00000-0000-4000-8000-00000000000a','evidence-a','Evidence A');

insert into corvis_control.control_definition (tenant_id,control_code,title,domain,owner,implementation_state,promoted_at,promoted_by)
values ('c0e00000-0000-4000-8000-00000000000a','ctrl-1','Control One','security','security-team','implemented',now(),'security-team');

insert into corvis_control.control_evidence_requirement
  (tenant_id,control_code,source_key,title,producer,owner,cadence_days,collection,collectable)
values
  ('c0e00000-0000-4000-8000-00000000000a','ctrl-1','src-1','Evidence source one','vendor','security-team',90,'provider_gated',false);

insert into corvis_control.control_evidence_record
  (tenant_id,evidence_record_id,control_code,source_key,revision,result,collection_method,collected_at,valid_through,collected_by,payload_digest)
values
  ('c0e00000-0000-4000-8000-00000000000a','c0e00000-0000-4000-8000-0000000000e1','ctrl-1','src-1',1,'pass','attested_manual',now(),now()+interval '90 days','auditor@example.test',repeat('a', 64));

-- 1. The trigger rejects UPDATE, DELETE and TRUNCATE with its documented message, whatever column is touched.
do $$
declare
  r uuid := 'c0e00000-0000-4000-8000-0000000000e1';
begin
  perform pg_temp.expect_error(format($f$update corvis_control.control_evidence_record set result = 'fail' where evidence_record_id = %L$f$, r),
    'corvis_control.control_evidence_record is append-only; record a new revision instead');
  perform pg_temp.expect_error(format($f$update corvis_control.control_evidence_record set payload_digest = %L where evidence_record_id = %L$f$, repeat('b', 64), r),
    'corvis_control.control_evidence_record is append-only; record a new revision instead');
  perform pg_temp.expect_error(format($f$delete from corvis_control.control_evidence_record where evidence_record_id = %L$f$, r),
    'corvis_control.control_evidence_record is append-only; record a new revision instead');
  perform pg_temp.expect_error('truncate corvis_control.control_evidence_record',
    'corvis_control.control_evidence_record is append-only; record a new revision instead');
end $$;

-- 2. A new revision is a plain insert, not blocked by the guard, and both revisions coexist.
insert into corvis_control.control_evidence_record
  (tenant_id,evidence_record_id,control_code,source_key,revision,result,collection_method,collected_at,valid_through,collected_by,payload_digest,previous_digest)
values
  ('c0e00000-0000-4000-8000-00000000000a','c0e00000-0000-4000-8000-0000000000e2','ctrl-1','src-1',2,'pass','attested_manual',now(),now()+interval '90 days','auditor@example.test',repeat('c', 64),repeat('a', 64));

do $$
begin
  if (select count(*) from corvis_control.control_evidence_record where tenant_id = 'c0e00000-0000-4000-8000-00000000000a') <> 2 then
    raise exception 'recording a new revision must not be blocked by the append-only guard';
  end if;
end $$;

rollback;
