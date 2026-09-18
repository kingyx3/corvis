import { createHash, randomUUID } from "crypto";
import type { RequestIdentity, ResearchAnswer, SourceCitation } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";
import { snowflake, type SnowflakeRow, type SnowflakeSqlApi } from "@/lib/server/snowflake";

type SearchHit = {
  sourceReferenceId: string;
  documentId: string;
  page?: number;
  label?: string;
  text?: string;
};

type SearchResponse = { hits?: SearchHit[] };
type AiResponse = { answer?: string; uncertainty?: string; usedFactIds?: string[]; modelVersion?: string };

function bearer(token?: string): Record<string, string> { return token ? { authorization: `Bearer ${token}` } : {}; }
function queryId(question: string, rows: SnowflakeRow[]): string {
  return `sq_${createHash("sha256").update(question).update(JSON.stringify(rows)).digest("hex").slice(0, 24)}`;
}

function sanitizeSnippet(value?: string): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 4000).replace(/\b(ignore|disregard|override)\s+(all|previous|system|developer)\s+(instructions?|rules?)\b/gi, "[untrusted-document-instruction]");
}

export class PermissionedResearchService {
  constructor(private readonly db: SnowflakeSqlApi = snowflake()) {}

  private async semanticFacts(identity: RequestIdentity): Promise<{ id: string; rows: SnowflakeRow[] }> {
    const rows = await this.db.query(`SELECT OBSERVATION_ID, FUND_ID, COMPANY_NAME, METRIC_CODE, VALUE_NUMBER, VALUE_STRING, CURRENCY, ECONOMIC_PERIOD, REPORT_DATE, SOURCE_REFERENCE_ID, VERSION FROM PM_SERVING.OBSERVATIONS WHERE TENANT_ID=? AND REVIEW_STATE='approved' ORDER BY UPDATED_AT DESC LIMIT 750`, [identity.tenantId]);
    return { id: randomUUID(), rows };
  }

  private async search(identity: RequestIdentity, question: string): Promise<SearchHit[]> {
    if (!identity.entitlements.sourceDocumentAccessAllowed) return [];
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
          documentIds: identity.entitlements.documentIds,
          fundIds: identity.entitlements.fundIds,
          sourceDocumentAccessAllowed: true,
        },
      }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Permissioned search failed (${response.status})`);
    const body = await response.json() as SearchResponse;
    return (body.hits ?? []).filter((hit) => hit.sourceReferenceId && hit.documentId).map((hit) => ({ ...hit, text: sanitizeSnippet(hit.text) }));
  }

  async answer(identity: RequestIdentity, question: string): Promise<ResearchAnswer> {
    const config = getServerConfig();
    if (!config.aiEndpoint) throw new Error("AI endpoint is not configured");
    const semantic = await this.semanticFacts(identity);
    const semanticQueryId = queryId(question, semantic.rows);
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
        semanticQuery: { id: semanticQueryId, rows: semantic.rows },
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
