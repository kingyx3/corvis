-- Runs against the isolated CI fixture, never a customer database.
do $$
declare
  v_allowed boolean;
  v_retry integer;
begin
  select allowed into v_allowed from corvis_control.consume_api_rate_limit('11111111-1111-1111-1111-111111111111', 'first', 1);
  if not v_allowed then raise exception 'first request denied'; end if;
  select allowed, retry_after_seconds into v_allowed, v_retry from corvis_control.consume_api_rate_limit('11111111-1111-1111-1111-111111111111', 'first', 1);
  if v_allowed or v_retry < 1 or v_retry > 60 then raise exception 'budget not enforced'; end if;
  select allowed into v_allowed from corvis_control.consume_api_rate_limit('22222222-2222-2222-2222-222222222222', 'first', 1);
  if not v_allowed then raise exception 'tenant budgets overlap'; end if;
  select allowed into v_allowed from corvis_control.consume_api_rate_limit('11111111-1111-1111-1111-111111111111', 'second', 1);
  if not v_allowed then raise exception 'subject budgets overlap'; end if;
  update corvis_control.api_rate_limit set window_start = clock_timestamp() - interval '61 seconds' where subject = 'first';
  select allowed into v_allowed from corvis_control.consume_api_rate_limit('11111111-1111-1111-1111-111111111111', 'first', 1);
  if not v_allowed then raise exception 'window did not reset'; end if;
  if has_function_privilege('authenticated', 'corvis_control.consume_api_rate_limit(uuid,text,integer)', 'execute') then
    raise exception 'browser role can mutate counters';
  end if;
end;
$$;
