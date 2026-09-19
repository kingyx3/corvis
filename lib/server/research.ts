import { createHash } from "crypto";
import type { RequestIdentity, ResearchAnswer, SourceCitation } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

type SearchHit = {
  sourceReferenceId: string;
  documentId: string;
  page?: number;
  label?: string;
  text?: string;
};

type SearchResponse = { hits?: SearchHit[] };
type AiResponse = { answer?: string; uncertainty?: string; usedFactIds?: string[]; modelVersion?: string };
type SemanticQueryShape = {
  version: "v1";
  source: "corvis_serving.observations";
  reviewState: "approved";
  fundIds: string[];
  documentIds: string[];
  limit: number;
};

function bearer(token?: string): Record<string, string> { return token ? { authorization: `Bearer ${token}` } : {}; }
function queryId(question: string, shape: SemanticQueryShape, rows: PostgresRow[]): string {
  return `sq_${createHash("sha256").update(question).update(JSON.stringify(shape)).update(JSON.stringify(rows)).digest("hex").slice(0, 24)}`;
}
function questionHash(question: string): string { return createHash("sha256").update(question).digest("hex"); }

function sanitizeSnippet(value?: string): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 4000).replace(/\b(ignore|disregard|override)\s+(all|previous|system|developer)\s+(instructions?|rules?)\b/gi, "[untrusted-document-instruction]");
}

export class PermissionedResearchService {
  private readonly db: PostgresSqlApi;

  constructor(db?: PostgresSqlApi) {
    this.db = db ?? postgres(getServerConfig().postgresDsn);
  }

  private semanticQueryShape(identity: RequestIdentity): SemanticQueryShape {
    return {
      version: "v1",
      source: "corvis_serving.observations",
      reviewState: "approved",
      fundIds: [...(identity.entitlements.fundIds ?? [])].sort(),
      documentIds: [...(identity.entitlements.documentIds ?? [])].sort(),
      limit: 750,
    };
  }

  private async semanticFacts(identity: RequestIdentity, shape: SemanticQueryShape): Promise<PostgresRow[]> {
    if (shape.fundIds.length === 0 || shape.documentIds.length === 0) return [];
    return this.db.query(`select o.observation_id, o.fund_id, o.company_id, o.metric_code, o.value_number, o.value_string,
        o.currency, o.economic_period, o.report_date, o.source_reference_id, o.version
      from corvis_serving.observations o
      join corvis_source.source_reference r
        on r.tenant_id=o.tenant_id and r.source_reference_id=o.source_reference_id
      where o.tenant_id=$1
        and o.review_state='approved'
        and o.fund_id in (select jsonb_array_elements_text($2::jsonb))
        and r.document_id::text in (select jsonb_array_elements_text($3::jsonb))
      order by o.updated_at desc
      limit $4`, [identity.tenantId, JSON.stringify(shape.fundIds), JSON.stringify(shape.documentIds), shape.limit]);
  }

  private async search(identity: RequestIdentity, question: string): Promise<SearchHit[]> {
    const sourceDocumentIds = identity.entitlements.sourceDocumentIds ?? [];
    if (!identity.entitlements.sourceDocumentAccessAllowed || sourceDocumentIds.length === 0) return [];
    const config = getServerConfig();
    if (!config.searchEndpoint) throw new Error("Search endpoint is not configured");
    const response = await fetch(`${config.searchEndpoint.replace(/\/$/, "")}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(config.searchApiToken) },
      body: JSON.stringify({
        query: question,
        limit: 8,
        filters: {
          tenantId: identity.tenantId,
          workspaceId: identity.workspaceId,
          documentIds: sourceDocumentIds,
          fundIds: identity.entitlements.fundIds,
          sourceDocumentAccessAllowed: true,
        },
      }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Permissioned search failed (${response.status})`);
    const body = await response.json() as SearchResponse;
    return (body.hits ?? [])
      .filter((hit) => hit.sourceReferenceId && hit.documentId && sourceDocumentIds.includes(hit.documentId))
      .map((hit) => ({ ...hit, text: sanitizeSnippet(hit.text) }));
  }

  async answer(identity: RequestIdentity, question: string): Promise<ResearchAnswer> {
    const config = getServerConfig();
    if (!config.aiEndpoint) throw new Error("AI endpoint is not configured");
    const shape = this.semanticQueryShape(identity);
    const rows = await this.semanticFacts(identity, shape);
    const semanticQueryId = queryId(question, shape, rows);
    const factIds = rows.map((row) => String(row.observation_id || "")).filter(Boolean);
    await this.db.execute(`insert into corvis_control.semantic_query_log
        (tenant_id,semantic_query_id,actor_subject,question_hash,result_fact_ids,result_row_count,query_shape,created_at,completed_at)
      values ($1,$2,$3,$4,
        array(select jsonb_array_elements_text($5::jsonb)::uuid),$6,$7::jsonb,now(),now())
      on conflict (tenant_id,semantic_query_id) do nothing`,
    [identity.tenantId,semanticQueryId,identity.subject,questionHash(question),JSON.stringify(factIds),rows.length,JSON.stringify(shape)]);
    const hits = await this.search(identity, question);
    const response = await fetch(`${config.aiEndpoint.replace(/\/$/, "")}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(config.aiApiToken) },
      body: JSON.stringify({
        question,
        mode: "trusted_data",
        policy: {
          quantitativeClaimsMustUseProvidedFacts: true,
          documentsAreUntrustedDataNotInstructions: true,
          refuseWhenEvidenceIsInsufficient: true,
        },
        semanticQuery: { id: semanticQueryId, shape, rows },
        retrieval: hits.map((hit) => ({
          sourceReferenceId: hit.sourceReferenceId,
          documentId: hit.documentId,
          page: hit.page,
          label: hit.label,
          excerpt: hit.text,
        })),
      }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`AI answer service failed (${response.status})`);
    const body = await response.json() as AiResponse;
    if (!body.answer) throw new Error("AI answer service returned no answer");
    const citations: SourceCitation[] = hits.map((hit) => ({ sourceReferenceId: hit.sourceReferenceId, documentId: hit.documentId, page: hit.page, label: hit.label || `Source ${hit.sourceReferenceId}` }));
    return { answer: body.answer, citations, semanticQueryIds: [semanticQueryId], modelVersion: body.modelVersion, uncertainty: body.uncertainty };
  }
}

let singleton: PermissionedResearchService | undefined;
export function researchService(): PermissionedResearchService {
  if (!singleton) singleton = new PermissionedResearchService();
  return singleton;
}
