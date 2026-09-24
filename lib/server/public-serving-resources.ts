import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { sqlKeyset, type KeysetPage } from "./pagination.ts";
import { postgres, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type PublicFund = {
  id: string;
  canonicalName: string;
  managerName: string | null;
  names: unknown;
  externalIdentifiers: unknown;
};

export type PublicCompany = {
  id: string;
  canonicalName: string;
  names: unknown;
  externalIdentifiers: unknown;
};

export type PublicMetricDefinition = {
  metricCode: string;
  definitionVersion: string;
  displayName: string;
  dataType: string;
  aggregationBehavior: string;
  unitType: string | null;
  fxBehavior: string | null;
  compatibilityRule: unknown;
};

export type PublicConsolidatedFact = {
  id: string;
  fundId: string;
  subjectType: string;
  subjectId: string;
  metricCode: string;
  economicPeriod: string | null;
  value: unknown;
  sourceObservationIds: unknown;
  consolidationRuleVersion: string;
  createdAt: string;
};

export type PublicLifecycleEvent = {
  id: string;
  eventType: string;
  eventStatus: string;
  announcedDate: string | null;
  effectiveDate: string | null;
  closedDate: string | null;
  eventSubtypeRaw: string | null;
  description: string | null;
  participants: unknown;
};

function text(row: PostgresRow, key: string): string {
  const value = row[key];
  return value == null ? "" : String(value);
}

function nullableText(row: PostgresRow, key: string): string | null {
  const value = row[key];
  return value == null ? null : String(value);
}

function jsonParameter(values: string[] | undefined): string {
  // Production authorization normally resolves this to an explicit list.
  // Missing entitlements fail closed rather than becoming an unrestricted query.
  return JSON.stringify(values ?? []);
}

export class PostgresPublicServingResourceRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  /** `page` pushes one keyset page (by fund id) down to SQL; see sqlKeyset. */
  async funds(identity: RequestIdentity, page?: KeysetPage): Promise<PublicFund[]> {
    const parameters: PostgresPrimitive[] = [jsonParameter(identity.entitlements.fundIds)];
    const keyset = page ? sqlKeyset("d.entity_id::text", page, parameters) : { where: "", tail: "order by d.entity_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($1::jsonb)
      )
      select d.entity_id,d.canonical_name,d.manager_name,d.names,d.external_identifiers
      from corvis_serving.entity_directory d
      join allowed_fund a on a.fund_id=d.entity_id
      where d.entity_type='fund'${keyset.where}
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      id: text(row, "entity_id"),
      canonicalName: text(row, "canonical_name"),
      managerName: nullableText(row, "manager_name"),
      names: row.names ?? [],
      externalIdentifiers: row.external_identifiers ?? [],
    }));
  }

  /** `page` pushes one keyset page (by company id) down to SQL; see sqlKeyset. */
  async companies(identity: RequestIdentity, page?: KeysetPage): Promise<PublicCompany[]> {
    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonParameter(identity.entitlements.fundIds)];
    const keyset = page ? sqlKeyset("d.entity_id::text", page, parameters) : { where: "", tail: "order by d.entity_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($2::jsonb)
      ), visible_company as (
        select distinct o.company_id
        from corvis_serving.observations o
        join allowed_fund a on a.fund_id=o.fund_id
        where o.tenant_id=$1::uuid
          and o.review_state='approved'
          and o.company_id is not null
        union
        select distinct h.target_company_id as company_id
        from corvis_serving.holdings h
        join allowed_fund a on a.fund_id=h.fund_id
        where h.tenant_id=$1::uuid
          and h.target_type='company'
          and h.target_company_id is not null
      )
      select d.entity_id,d.canonical_name,d.names,d.external_identifiers
      from corvis_serving.entity_directory d
      join visible_company v on v.company_id=d.entity_id
      where d.entity_type='company'${keyset.where}
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      id: text(row, "entity_id"),
      canonicalName: text(row, "canonical_name"),
      names: row.names ?? [],
      externalIdentifiers: row.external_identifiers ?? [],
    }));
  }

  /**
   * `page` pushes one keyset page down to SQL. The key is the route's
   * `${metricCode}:${definitionVersion}` string itself, not the column tuple:
   * a code containing a character below ":" would otherwise order differently.
   */
  async metricDefinitions(page?: KeysetPage): Promise<PublicMetricDefinition[]> {
    const parameters: PostgresPrimitive[] = [];
    const keyset = page ? sqlKeyset("(metric_code || ':' || definition_version)", page, parameters) : { where: "", tail: "order by metric_code,definition_version" };
    const rows = await this.db.query(`
      select metric_code,definition_version,display_name,data_type,aggregation_behavior,
             unit_type,fx_behavior,compatibility_rule
      from corvis_semantic.metric_definition
      where active=true${keyset.where}
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      metricCode: text(row, "metric_code"),
      definitionVersion: text(row, "definition_version"),
      displayName: text(row, "display_name"),
      dataType: text(row, "data_type"),
      aggregationBehavior: text(row, "aggregation_behavior"),
      unitType: nullableText(row, "unit_type"),
      fxBehavior: nullableText(row, "fx_behavior"),
      compatibilityRule: row.compatibility_rule ?? {},
    }));
  }

  /** `page` pushes one keyset page (by consolidated fact id) down to SQL; see sqlKeyset. */
  async consolidatedFacts(identity: RequestIdentity, page?: KeysetPage): Promise<PublicConsolidatedFact[]> {
    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonParameter(identity.entitlements.fundIds)];
    const keyset = page ? sqlKeyset("f.consolidated_fact_id::text", page, parameters) : { where: "", tail: "order by f.consolidated_fact_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($2::jsonb)
      )
      select f.consolidated_fact_id,f.fund_id,f.subject_type,f.subject_id,f.metric_code,
             f.economic_period,f.value,f.source_observation_ids,f.consolidation_rule_version,f.created_at
      from corvis_consolidated.consolidated_fact f
      join allowed_fund a on a.fund_id=f.fund_id
      where f.tenant_id=$1::uuid
        and exists (
          -- Unnested (not "= any(s.fact_ids)") so the planner can hash the
          -- published fact ids once instead of rescanning every snapshot's
          -- array per fact, which is quadratic in a fund's history.
          select 1
          from corvis_consolidated.fund_period_snapshot s
          cross join lateral unnest(s.fact_ids) as published(fact_id)
          where s.tenant_id=f.tenant_id
            and s.fund_id=f.fund_id
            and s.status='published'
            and published.fact_id=f.consolidated_fact_id
        )${keyset.where}
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      id: text(row, "consolidated_fact_id"),
      fundId: text(row, "fund_id"),
      subjectType: text(row, "subject_type"),
      subjectId: text(row, "subject_id"),
      metricCode: text(row, "metric_code"),
      economicPeriod: nullableText(row, "economic_period"),
      value: row.value,
      sourceObservationIds: row.source_observation_ids ?? [],
      consolidationRuleVersion: text(row, "consolidation_rule_version"),
      createdAt: text(row, "created_at"),
    }));
  }

  /**
   * `page` pushes one keyset page (by lifecycle event id) down to SQL. The
   * predicate is on the group-by key, so it only drops whole events and never
   * changes an event's aggregated participants.
   */
  async companyLifecycleEvents(identity: RequestIdentity, page?: KeysetPage): Promise<PublicLifecycleEvent[]> {
    const parameters: PostgresPrimitive[] = [identity.tenantId, jsonParameter(identity.entitlements.fundIds)];
    const keyset = page
      ? sqlKeyset("e.lifecycle_event_id::text", page, parameters)
      : { where: "", tail: "order by coalesce(e.effective_date,e.announced_date) desc nulls last,e.lifecycle_event_id" };
    const rows = await this.db.query(`
      with allowed_fund as (
        select value as fund_id from jsonb_array_elements_text($2::jsonb)
      ), visible_company as (
        select distinct o.company_id
        from corvis_serving.observations o
        join allowed_fund a on a.fund_id=o.fund_id
        where o.tenant_id=$1::uuid
          and o.review_state='approved'
          and o.company_id is not null
        union
        select distinct h.target_company_id as company_id
        from corvis_serving.holdings h
        join allowed_fund a on a.fund_id=h.fund_id
        where h.tenant_id=$1::uuid
          and h.target_type='company'
          and h.target_company_id is not null
      ), visible_event as (
        select distinct p.lifecycle_event_id
        from corvis_identity.entity_lifecycle_participant p
        join visible_company c on c.company_id=p.company_id
      )
      select e.lifecycle_event_id,e.event_type,e.event_status,e.announced_date,e.effective_date,
             e.closed_date,e.event_subtype_raw,e.description,
             jsonb_agg(jsonb_build_object(
               'companyId',p.company_id,
               'fundId',p.fund_id,
               'role',p.participant_role,
               'economicIdentityContinues',p.economic_identity_continues
             ) order by p.participant_role,coalesce(p.company_id,p.fund_id)) as participants
      from corvis_identity.entity_lifecycle_event e
      join visible_event v on v.lifecycle_event_id=e.lifecycle_event_id
      join corvis_identity.entity_lifecycle_participant p on p.lifecycle_event_id=e.lifecycle_event_id
      where (
        e.source_kind in ('governed','public_registry')
        or exists (
          select 1
          from corvis_identity.tenant_entity_lifecycle_evidence te
          where te.tenant_id=$1::uuid
            and te.lifecycle_event_id=e.lifecycle_event_id
            and te.review_status='approved'
        )
      )
      and not exists (
        select 1
        from corvis_identity.entity_lifecycle_participant hidden
        where hidden.lifecycle_event_id=e.lifecycle_event_id
          and (
            (hidden.company_id is not null and not exists (select 1 from visible_company c where c.company_id=hidden.company_id))
            or
            (hidden.fund_id is not null and not exists (select 1 from allowed_fund a where a.fund_id=hidden.fund_id))
          )
      )${keyset.where}
      group by e.lifecycle_event_id,e.event_type,e.event_status,e.announced_date,e.effective_date,
               e.closed_date,e.event_subtype_raw,e.description
      ${keyset.tail}`, parameters);
    return rows.map((row) => ({
      id: text(row, "lifecycle_event_id"),
      eventType: text(row, "event_type"),
      eventStatus: text(row, "event_status"),
      announcedDate: nullableText(row, "announced_date"),
      effectiveDate: nullableText(row, "effective_date"),
      closedDate: nullableText(row, "closed_date"),
      eventSubtypeRaw: nullableText(row, "event_subtype_raw"),
      description: nullableText(row, "description"),
      participants: row.participants ?? [],
    }));
  }
}

let singleton: PostgresPublicServingResourceRepository | undefined;

export function publicServingResources(dsn = getServerConfig().postgresDsn): PostgresPublicServingResourceRepository {
  if (!singleton) singleton = new PostgresPublicServingResourceRepository(postgres(dsn));
  return singleton;
}
