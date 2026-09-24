-- Follow-up: missing maintenance sweeps (idempotency key expiry index).
-- Depends on migrations 001-048.
--
-- corvis_control.idempotency_key (migration 001) has had a not-null
-- `expires_at` on every row since it was created, but nothing has ever swept
-- expired rows and there is no index to support that sweep: a bounded
-- `delete ... where expires_at <= now() limit N` would otherwise need a full
-- table scan to find its candidates. This index supports that sweep
-- (lib/server/idempotency.ts's `sweepExpiredIdempotencyKeys`).
--
-- The runner applies each migration in one transaction, so this index is
-- built without CONCURRENTLY.

begin;

create index if not exists idempotency_key_expires_at_idx
  on corvis_control.idempotency_key (expires_at);

commit;
