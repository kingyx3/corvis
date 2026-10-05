-- Shared helpers for the runtime-role acceptance probes (#227): runtime-role-acceptance.sql and
-- db/postgres/runtime_security_acceptance.sql both `\ir` this file AFTER they are running as corvis_runtime. The helpers live
-- in the temp schema and are owned by the runtime role itself (a temp function needs only the TEMP privilege), so every
-- statement they run uses the runtime role's real privileges.

-- Runs a statement that must fail with exactly the given SQLSTATE (42501 = insufficient_privilege, which is also what an
-- RLS WITH CHECK violation raises).
create function pg_temp.expect_sqlstate(p_label text, p_statement text, p_expected text) returns void language plpgsql as $$
declare v_got text := 'no error';
begin
  begin
    execute p_statement;
  exception when others then
    v_got := sqlstate;
  end;
  if v_got is distinct from p_expected then
    raise exception '%: expected SQLSTATE % but got % for: %', p_label, p_expected, v_got, p_statement;
  end if;
end $$;

-- Binds a subject (request.jwt.claim.sub, exactly what auth.uid() reads) and asserts that every listed relation shows that
-- subject's own tenant and nothing of any other tenant (p_expect_own = false: nothing at all).
create function pg_temp.assert_scoped(p_label text, p_subject uuid, p_own uuid, p_other uuid, p_expect_own boolean, p_relations text[])
returns void language plpgsql as $$
declare
  v_rel text;
  v_own bigint;
  v_other bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_subject::text, ''), true);
  foreach v_rel in array p_relations loop
    execute format('select count(*) filter (where tenant_id = %L), count(*) filter (where tenant_id <> %L) from %s', p_own, p_own, v_rel)
      into v_own, v_other;
    if v_other <> 0 then raise exception '%: % shows % row(s) of tenants other than the subject''s', p_label, v_rel, v_other; end if;
    if p_expect_own and v_own < 1 then raise exception '%: % hides the subject''s own tenant', p_label, v_rel; end if;
    if not p_expect_own and v_own <> 0 then raise exception '%: % shows rows to a subject without membership', p_label, v_rel; end if;
    execute format('select count(*) from %s where tenant_id = %L', v_rel, p_other) into v_other;
    if v_other <> 0 then raise exception '%: % leaks % row(s) of another tenant', p_label, v_rel, v_other; end if;
  end loop;
end $$;
