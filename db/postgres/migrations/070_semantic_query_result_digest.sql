-- Record a digest of each governed semantic query's result rows (#245).
-- Depends on migrations 001-069.
--
-- An Ask Corvis pin carries its answer's computedResults back from the client.
-- The semantic query id proves the query ran for the tenant, but the rows were
-- checked only for internal consistency. With the SHA-256 of the canonical rows
-- the server returned logged beside the id, a pin is accepted only when its rows
-- are exactly the rows the server computed. Rows logged before this migration
-- have no digest; answers from them can no longer be pinned (ask again).

begin;

alter table corvis_control.semantic_query_log
  add column if not exists result_rows_sha256 text
    check (result_rows_sha256 is null or result_rows_sha256 ~ '^[0-9a-f]{64}$');

commit;
