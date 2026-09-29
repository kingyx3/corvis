-- Invariant: every table in every corvis_* schema has row-level security
-- enabled AND forced, except a short, explicit allow-list of documented global
-- (non-tenant) reference tables. A new table added by a future migration
-- without `enable` + `force row level security` fails this test, so tenant
-- isolation cannot silently regress. Run after the full migration chain on an
-- isolated disposable database. Read-only.

\set ON_ERROR_STOP on

begin;

create temporary table rls_global_allowlist (schema_name text, table_pattern text, reason text) on commit drop;
insert into rls_global_allowlist values
  -- Shared canonical identity graph: no tenant_id, tenant visibility is decided
  -- by the corvis_serving views/functions that join through tenant-owned facts.
  ('corvis_identity', 'company', 'global canonical company registry'),
  ('corvis_identity', 'fund', 'global canonical fund registry'),
  ('corvis_identity', 'entity\_%', 'global entity identity graph (names, identifiers, relationships, lifecycle)'),
  -- Governed semantic layer: metric and sector taxonomies shared by all tenants.
  ('corvis_semantic', '%', 'governed global semantic taxonomy'),
  -- Created by the migration runner (not by a migration file); owner-only ledger.
  ('corvis_migration', 'schema_migration', 'migration ledger managed by db/postgres/migrate.ts');

create temporary table rls_tables on commit drop as
select n.nspname as schema_name, c.relname as table_name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
       exists (
         select 1 from pg_attribute a
         where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
       ) as has_tenant_id,
       exists (
         select 1 from rls_global_allowlist g
         where g.schema_name = n.nspname and c.relname like g.table_pattern
       ) as allow_listed
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname like 'corvis\_%'
  and c.relkind in ('r', 'p')
  and not c.relispartition;

do $$
declare
  total integer;
  offenders text;
begin
  select count(*) into total from rls_tables;
  if total < 80 then
    raise exception 'expected to discover the full corvis_* table set, found only % tables', total;
  end if;

  select string_agg(schema_name || '.' || table_name, ', ' order by schema_name, table_name) into offenders
  from rls_tables
  where not allow_listed and (not rls or not forced);
  if offenders is not null then
    raise exception 'tables without ENABLE + FORCE row level security: %', offenders;
  end if;

  -- The allow-list must never shelter a tenant-scoped table.
  select string_agg(schema_name || '.' || table_name, ', ' order by schema_name, table_name) into offenders
  from rls_tables
  where allow_listed and has_tenant_id;
  if offenders is not null then
    raise exception 'allow-listed global tables must not carry tenant_id: %', offenders;
  end if;

  -- Every tenant-scoped table (has tenant_id) is covered by the first check;
  -- assert the population is non-trivial so a broken catalog query cannot pass vacuously.
  if (select count(*) from rls_tables where has_tenant_id and rls and forced) < 60 then
    raise exception 'expected at least 60 tenant-scoped tables with forced RLS';
  end if;

  -- An allow-list entry that matches nothing is stale documentation.
  select string_agg(g.schema_name || '.' || g.table_pattern, ', ') into offenders
  from rls_global_allowlist g
  where g.table_pattern <> 'schema_migration'
    and not exists (select 1 from rls_tables t where t.schema_name = g.schema_name and t.table_name like g.table_pattern);
  if offenders is not null then
    raise exception 'stale RLS allow-list entries: %', offenders;
  end if;
end $$;

rollback;
