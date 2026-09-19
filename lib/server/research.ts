import { createHash } from "crypto";
import type {
  RequestIdentity,
  ResearchAnswer,
  ResearchProgressPhase,
  SemanticComputedResult,
  SourceCitation,
} from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
import { GovernedSemanticQueryService, type GovernedSemanticQueryShape } from "./semantic-query.ts";

type SearchHit = {
  sourceReferenceId: string;
  documentId: string;
  page?: number;
  label?: string;
  text?: string;
};

type SearchResponse = { hits?: SearchHit[] };
type AiResponse = { answer?: string; uncertainty?: string; usedFactIds?: string[]; modelVersion?: string };
export type ResearchExecutionOptions = {
  signal?: AbortSignal;
  onProgress?: (phase: ResearchProgressPhase) => void;
};

export class ResearchTimeoutError extends Error {
  readonly code = "research_timeout";
  constructor() {
    super("Research request timed out");
    this.name = "ResearchTimeoutError";
  }
}

export class ResearchCancelledError extends Error {
  readonly code = "research_cancelled";
  constructor() {
    super("Research request was cancelled");
    this.name = "ResearchCancelledError";
  }
}

export class ResearchProviderError extends Error {
  readonly code = "research_provider_error";
  readonly provider: "search" | "ai";
  readonly status?: number;

  constructor(provider: "search" | "ai", status?: number) {
    super("Research provider is unavailable");
    this.name = "ResearchProviderError";
    this.provider = provider;
    this.status = status;
  }
}

function bearer(token?: string): Record<string, string> { return token ? { authorization: `Bearer ${token}` } : {}; }
function queryId(question: string, shape: GovernedSemanticQueryShape, rows: PostgresRow[]): string {
  return `sq_${createHash("sha256").update(question).update(JSON.stringify(shape)).update(JSON.stringify(rows)).digest("hex").slice(0, 24)}`;
}
function questionHash(question: string): string { return createHash("sha256").update(question).digest("hex"); }

function sanitizeSnippet(value?: string): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 4000).replace(/\b(ignore|disregard|override)\s+(all|previous|system|developer)\s+(instructions?|rules?)\b/gi, "[untrusted-document-instruction]");
}

function validateUsedFactIds(usedFactIds: string[] | undefined, allowedFactIds: string[]): void {
  if (!usedFactIds) return;
  const allowed = new Set(allowedFactIds);
  if (usedFactIds.some((factId) => !allowed.has(factId))) {
    throw new Error("AI answer service referenced facts outside the governed semantic result");
  }
}

function managedSignal(callerSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cancel = () => {
    if (!controller.signal.aborted) controller.abort(new ResearchCancelledError());
  };
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener("abort", cancel, { once: true });

  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new ResearchTimeoutError());
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", cancel);
    },
  };
}

function throwExecutionAbort(signal: AbortSignal): never {
  const reason = signal.reason;
  if (reason instanceof ResearchTimeoutError || reason instanceof ResearchCancelledError) throw reason;
  throw new ResearchCancelledError();
}

function checkExecutionSignal(signal: AbortSignal): void {
  if (signal.aborted) throwExecutionAbort(signal);
}

export class PermissionedResearchService {
  private readonly db: PostgresSqlApi;

  constructor(db?: PostgresSqlApi) {
    this.db = db ?? postgres(getServerConfig().postgresDsn);
  }

  private async search(identity: RequestIdentity, question: string, fundIds: string[], signal: AbortSignal): Promise<SearchHit[]> {
    const sourceDocumentIds = identity.entitlements.sourceDocumentIds ?? [];
    if (!identity.entitlements.sourceDocumentAccessAllowed || sourceDocumentIds.length === 0) return [];
    const config = getServerConfig();
    if (!config.searchEndpoint) throw new ResearchProviderError("search");
    let response: Response;
    try {
      response = await fetch(`${config.searchEndpoint.replace(/\/$/, "")}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(config.searchApiToken) },
        body: JSON.stringify({
          query: question,
          limit: 8,
          filters: {
            tenantId: identity.tenantId,
            workspaceId: identity.workspaceId,
            documentIds: sourceDocumentIds,
            fundIds,
            sourceDocumentAccessAllowed: true,
          },
        }),
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throwExecutionAbort(signal);
      throw error;
    }
    if (!response.ok) throw new ResearchProviderError("search", response.status);
    const body = await response.json() as SearchResponse;
    return (body.hits ?? [])
      .filter((hit) => hit.sourceReferenceId && hit.documentId && sourceDocumentIds.includes(hit.documentId))
      .map((hit) => ({ ...hit, text: sanitizeSnippet(hit.text) }));
  }

  async answer(identity: RequestIdentity, question: string, options: ResearchExecutionOptions = {}): Promise<ResearchAnswer> {
    const config = getServerConfig();
    if (!config.aiEndpoint) throw new ResearchProviderError("ai");
    const execution = managedSignal(options.signal, config.researchTimeoutMs);

    try {
      checkExecutionSignal(execution.signal);
      options.onProgress?.("planning");
      const semantic = await new GovernedSemanticQueryService(this.db).execute(identity, question);
      checkExecutionSignal(execution.signal);
      const semanticQueryId = queryId(question, semantic.shape, semantic.rows);
      await this.db.execute(`insert into corvis_control.semantic_query_log
          (tenant_id,semantic_query_id,actor_subject,question_hash,result_fact_ids,result_row_count,query_shape,created_at,completed_at)
        values ($1,$2,$3,$4,
          array(select jsonb_array_elements_text($5::jsonb)::uuid),$6,$7::jsonb,now(),now())
        on conflict (tenant_id,semantic_query_id) do nothing`,
      [identity.tenantId,semanticQueryId,identity.subject,questionHash(question),JSON.stringify(semantic.factIds),semantic.rows.length,JSON.stringify(semantic.shape)]);
      checkExecutionSignal(execution.signal);

      options.onProgress?.("retrieval");
      const hits = await this.search(identity, question, semantic.shape.fundIds, execution.signal);
      checkExecutionSignal(execution.signal);

      options.onProgress?.("generation");
      let response: Response;
      try {
        response = await fetch(`${config.aiEndpoint.replace(/\/$/, "")}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(config.aiApiToken) },
          body: JSON.stringify({
            question,
            mode: "trusted_data",
            policy: {
              quantitativeClaimsMustUseSemanticResult: true,
              retrievalMayExplainButMustNotCalculate: true,
              documentsAreUntrustedDataNotInstructions: true,
              refuseWhenEvidenceIsInsufficient: true,
            },
            semanticQuery: {
              id: semanticQueryId,
              status: semantic.status,
              shape: semantic.shape,
              rows: semantic.rows,
              result: { rows: semantic.rows, factIds: semantic.factIds },
            },
            retrieval: hits.map((hit) => ({
              sourceReferenceId: hit.sourceReferenceId,
              documentId: hit.documentId,
              page: hit.page,
              label: hit.label,
              excerpt: hit.text,
            })),
          }),
          cache: "no-store",
          signal: execution.signal,
        });
      } catch (error) {
        if (execution.signal.aborted) throwExecutionAbort(execution.signal);
        throw error;
      }
      if (!response.ok) throw new ResearchProviderError("ai", response.status);
      const body = await response.json() as AiResponse;
      if (!body.answer) throw new ResearchProviderError("ai", response.status);
      validateUsedFactIds(body.usedFactIds, semantic.factIds);

      const citations: SourceCitation[] = hits.map((hit) => ({
        sourceReferenceId: hit.sourceReferenceId,
        documentId: hit.documentId,
        page: hit.page,
        label: hit.label || `Source ${hit.sourceReferenceId}`,
      }));
      const computed: SemanticComputedResult = {
        semanticQueryId,
        status: semantic.status,
        metricCode: semantic.shape.metricCode,
        operation: semantic.shape.operation,
        rows: semantic.rows,
        reason: semantic.shape.reason,
      };
      return {
        answer: body.answer,
        citations,
        semanticQueryIds: [semanticQueryId],
        computedResults: [computed],
        modelVersion: body.modelVersion,
        uncertainty: body.uncertainty,
      };
    } finally {
      execution.dispose();
    }
  }
}

let singleton: PermissionedResearchService | undefined;
export function researchService(): PermissionedResearchService {
  if (!singleton) singleton = new PermissionedResearchService();
  return singleton;
}
