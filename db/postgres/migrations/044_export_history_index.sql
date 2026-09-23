-- Per-requester export history lookup.
-- Depends on migrations 001-043.
--
-- GET /api/v1/exports lists the caller's own exports
-- (tenant_id, requested_by) newest first and is polled while exports are in
-- flight. The existing export_job_tenant_state_idx leads with state, so the
-- history query had to scan every export in the tenant; this index serves the
-- filter and the ordering directly and keeps the bounded LIMIT cheap.

begin;

create index if not exists export_job_requester_history_idx
  on corvis_serving.export_job (tenant_id, requested_by, created_at desc);

commit;
