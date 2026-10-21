-- Acceptance: corvis_control.control_evidence (distinct from its sibling
-- control_evidence_record, covered by control-evidence-append-only.sql) is append-only.
--
-- Added by migration 008 after a rotation review found this table had no guard at all: unlike
-- its sibling, neither a BEFORE DELETE OR UPDATE row trigger nor a BEFORE TRUNCATE statement
-- trigger existed. This proves UPDATE, DELETE and TRUNCATE are all rejected with the documented
-- error text, and that a fresh INSERT (its only real write path, from listControlEvidence's
-- companion insert in src/modules/governance/server/operations/operations.ts) is never blocked.
--
-- Run after the full migration chain on an isolated disposable database. Rolled back.

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
values ('c0e10000-0000-4000-8000-00000000000a','evidence-table-a','Evidence Table A');

insert into corvis_control.control_evidence
  (tenant_id,evidence_id,control_code,evidence_type,evidence_payload,result,generated_at,generated_by)
values
  ('c0e10000-0000-4000-8000-00000000000a','c0e10000-0000-4000-8000-0000000000e1','ENTERPRISE_RUNTIME','automated_runtime_snapshot','{}'::jsonb,'pass',now(),'runtime');

-- 1. The trigger rejects UPDATE, DELETE and TRUNCATE with its documented message, whatever column is touched.
do $$
declare
  r uuid := 'c0e10000-0000-4000-8000-0000000000e1';
begin
  perform pg_temp.expect_error(format($f$update corvis_control.control_evidence set result = 'fail' where evidence_id = %L$f$, r),
    'corvis_control.control_evidence is append-only');
  perform pg_temp.expect_error(format($f$update corvis_control.control_evidence set evidence_payload = '{"changed":true}'::jsonb where evidence_id = %L$f$, r),
    'corvis_control.control_evidence is append-only');
  perform pg_temp.expect_error(format($f$delete from corvis_control.control_evidence where evidence_id = %L$f$, r),
    'corvis_control.control_evidence is append-only');
  perform pg_temp.expect_error('truncate corvis_control.control_evidence',
    'corvis_control.control_evidence is append-only');
end $$;

-- 2. A fresh snapshot is a plain insert, not blocked by the guard, and both rows coexist.
insert into corvis_control.control_evidence
  (tenant_id,evidence_id,control_code,evidence_type,evidence_payload,result,generated_at,generated_by)
values
  ('c0e10000-0000-4000-8000-00000000000a','c0e10000-0000-4000-8000-0000000000e2','ENTERPRISE_RUNTIME','automated_runtime_snapshot','{}'::jsonb,'pass',now(),'runtime');

do $$
begin
  if (select count(*) from corvis_control.control_evidence where tenant_id = 'c0e10000-0000-4000-8000-00000000000a') <> 2 then
    raise exception 'recording a new snapshot must not be blocked by the append-only guard';
  end if;
end $$;

rollback;
