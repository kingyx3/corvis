import { createHash } from "crypto";
import type {
  RequestIdentity,
  ResearchAnswer,
  ResearchProgressPhase,
  SemanticComputedResult,
  SourceCitation,
} from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { isFeatureEnabled } from "./feature-flags.ts";
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

// A provider that is unreachable or answers with a non-JSON body is a provider outage (502),
// not an internal Corvis failure; an abort while the body streams keeps its timeout/cancel code.
async function providerJson<T>(response: Response, provider: "search" | "ai", signal: AbortSignal): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (signal.aborted) throwExecutionAbort(signal);
    throw new ResearchProviderError(provider, response.status);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResearchProviderError(provider, response.status);
  return body as T;
}

export const MAX_RESEARCH_QUESTION_LENGTH = 4000;

/** Returns the trimmed question, or null when the request body does not carry a usable one. */
export function parseResearchQuestion(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as { question?: unknown }).question;
  if (typeof raw !== "string") return null;
  const question = raw.trim();
  return question && question.length <= MAX_RESEARCH_QUESTION_LENGTH ? question : null;
}

// Loose shape check only (unlike a strict RFC4122 version/variant match): this
// gates a cast in a query built from an external search index's own ids, not
// a client-authorization boundary, and Postgres's uuid type itself accepts
// any 8-4-4-4-12 hex string.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CitationLink = { observationId?: string; hasOpenReconciliation: boolean };

export class PermissionedResearchService {
  private readonly db: PostgresSqlApi;

  constructor(db?: PostgresSqlApi) {
    this.db = db ?? postgres(getServerConfig().postgresDsn);
  }

  /**
   * Links each citation's source reference to the reviewed observation it
   * produced (D2, #177) and flags whether that source is part of a currently
   * open reconciliation exception. Best-effort: retrieval hits come from an
   * external search index, so a source reference id that doesn't resolve to
   * anything in Postgres (or isn't even a UUID) just gets no link rather than
   * failing the whole answer -- this is chrome on top of an already-returned,
   * already-entitled answer, never a gate on it.
   */
  private async citationLinks(tenantId: string, sourceReferenceIds: string[]): Promise<Map<string, CitationLink>> {
    const ids = [...new Set(sourceReferenceIds)].filter((id) => UUID.test(id));
    const links = new Map<string, CitationLink>();
    if (ids.length === 0) return links;
    try {
      const rows = await this.db.query(`select osr.source_reference_id, osr.observation_id,
          exists (
            select 1 from corvis_consolidated.reconciliation_exception e
            where e.tenant_id=osr.tenant_id and e.status='open'
              and osr.source_reference_id=any(e.competing_source_reference_ids)
          ) as has_open_reconciliation
        from corvis_facts.observation_source_reference osr
        where osr.tenant_id=$1 and osr.source_reference_id in (select jsonb_array_elements_text($2::jsonb)::uuid)
        order by osr.source_reference_id, osr.observation_id`, [tenantId, JSON.stringify(ids)]);
      for (const row of rows) {
        const sourceReferenceId = String(row.source_reference_id);
        const hasOpenReconciliation = row.has_open_reconciliation === true || row.has_open_reconciliation === "true";
        const existing = links.get(sourceReferenceId);
        if (existing) {
          existing.hasOpenReconciliation ||= hasOpenReconciliation;
          continue;
        }
        links.set(sourceReferenceId, { observationId: String(row.observation_id), hasOpenReconciliation });
      }
    } catch {
      // Enrichment only; an unreachable/misbehaving database here must not
      // turn an already-governed, already-entitled answer into a failure.
      return new Map();
    }
    return links;
  }

  private async search(identity: RequestIdentity, question: string, fundIds: string[], signal: AbortSignal): Promise<SearchHit[]> {
    const sourceDocumentIds = identity.entitlements.sourceDocumentIds ?? [];
    if (!identity.entitlements.sourceDocumentAccessAllowed || sourceDocumentIds.length === 0) return [];
    if (!await isFeatureEnabled(identity, "retrieval.hybrid_search", "ai_retrieval", this.db)) return [];
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
    } catch {
      if (signal.aborted) throwExecutionAbort(signal);
      throw new ResearchProviderError("search");
    }
    if (!response.ok) throw new ResearchProviderError("search", response.status);
    const body = await providerJson<SearchResponse>(response, "search", signal);
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
      } catch {
        if (execution.signal.aborted) throwExecutionAbort(execution.signal);
        throw new ResearchProviderError("ai");
      }
      if (!response.ok) throw new ResearchProviderError("ai", response.status);
      const body = await providerJson<AiResponse>(response, "ai", execution.signal);
      if (!body.answer) throw new ResearchProviderError("ai", response.status);
      validateUsedFactIds(body.usedFactIds, semantic.factIds);

      const links = await this.citationLinks(identity.tenantId, hits.map((hit) => hit.sourceReferenceId));
      const citations: SourceCitation[] = hits.map((hit) => {
        const link = links.get(hit.sourceReferenceId);
        return {
          sourceReferenceId: hit.sourceReferenceId,
          documentId: hit.documentId,
          page: hit.page,
          label: hit.label || `Source ${hit.sourceReferenceId}`,
          observationId: link?.observationId,
          hasOpenReconciliation: link?.hasOpenReconciliation,
        };
      });
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
