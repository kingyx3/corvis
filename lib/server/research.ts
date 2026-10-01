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
import { logEvent } from "./telemetry.ts";
import { GovernedSemanticQueryService, type GovernedSemanticQueryShape } from "./semantic-query.ts";
import {
  assessNumericGrounding,
  computedRowsDigest,
  entitledSourceReferenceIds,
  extractNumericFigures,
  MAX_ANSWER_TEXT_LENGTH,
  MAX_MODEL_VERSION_LENGTH,
  MAX_UNCERTAINTY_TEXT_LENGTH,
  NO_GROUNDED_FIGURES_ANSWER,
  NO_GROUNDED_FIGURES_UNCERTAINTY,
  sanitizeLabel,
  sanitizePage,
  sanitizeRowsForModel,
  sanitizeSnippet,
} from "./research-grounding.ts";

type SearchHit = {
  sourceReferenceId: string;
  documentId: string;
  page?: number;
  label?: string;
  text?: string;
};

type SearchResponse = { hits?: SearchHit[] };
// Untyped on purpose: the body is external, so every field is validated before use.
type AiResponse = { answer?: unknown; uncertainty?: unknown; usedFactIds?: unknown; modelVersion?: unknown };
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

const MAX_USED_FACT_IDS = 1000;

/**
 * `usedFactIds` must be an array of strings; anything else (absent, null, wrong type) counts as "cited nothing".
 * Ids outside the governed semantic result are a provider contract violation and abort the answer.
 */
function normalizeUsedFactIds(usedFactIds: unknown, allowedFactIds: string[]): string[] {
  if (!Array.isArray(usedFactIds) || usedFactIds.length > MAX_USED_FACT_IDS || !usedFactIds.every((id) => typeof id === "string")) return [];
  const allowed = new Set(allowedFactIds);
  if (usedFactIds.some((factId) => !allowed.has(factId))) {
    throw new Error("AI answer service referenced facts outside the governed semantic result");
  }
  return [...new Set(usedFactIds as string[])];
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
   * already-entitled answer, never a gate on it. A database failure is logged (the answer still returns): the open
   * reconciliation flag is then absent from every citation, which the UI cannot tell apart from "no open exception".
   */
  private async citationLinks(identity: RequestIdentity, correlationId: string, sourceReferenceIds: string[]): Promise<Map<string, CitationLink>> {
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
        order by osr.source_reference_id, osr.observation_id`, [identity.tenantId, JSON.stringify(ids)]);
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
    } catch (error) {
      // Enrichment only; an unreachable/misbehaving database here must not
      // turn an already-governed, already-entitled answer into a failure. It must not be silent either: the
      // hasOpenReconciliation risk signal is dropped for this answer. Only the error class/code is logged (no SQL text).
      const code = (error as { code?: unknown } | null)?.code;
      logEvent("warn", "research.citation_links_failed", {
        correlationId,
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        actorSubject: identity.subject,
      }, {
        citationCount: ids.length,
        errorName: error instanceof Error ? error.name : typeof error,
        ...(typeof code === "string" ? { code } : {}),
      });
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
    const hits = Array.isArray(body.hits) ? body.hits : [];
    // Rebuild every hit from known fields only: the index is external, so nothing it returns reaches the model or a
    // citation unless it is a string id we recognise, a bounded page number, or text through the shared sanitizer.
    const candidates: SearchHit[] = hits
      .filter((hit): hit is SearchHit => typeof hit === "object" && hit !== null
        && typeof hit.sourceReferenceId === "string" && typeof hit.documentId === "string"
        && sourceDocumentIds.includes(hit.documentId))
      .map((hit) => ({
        sourceReferenceId: hit.sourceReferenceId,
        documentId: hit.documentId,
        page: sanitizePage(hit.page),
        label: sanitizeLabel(hit.label),
        text: sanitizeSnippet(hit.text),
      }));
    // Same rule as GET /source-references/[id]: the reference must exist for this tenant, belong to the claimed
    // document, and that document must be readable by the caller. Others are dropped before the model sees them.
    const readable = await entitledSourceReferenceIds(this.db, identity, candidates);
    return candidates.filter((hit) => readable.has(hit.sourceReferenceId));
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
      // The id hashes the rows, so one digest per (tenant, id) holds for every asker; pins are checked against it.
      await this.db.execute(`insert into corvis_control.semantic_query_log
          (tenant_id,semantic_query_id,actor_subject,question_hash,result_fact_ids,result_row_count,query_shape,result_rows_sha256,created_at,completed_at)
        values ($1,$2,$3,$4,
          array(select jsonb_array_elements_text($5::jsonb)::uuid),$6,$7::jsonb,$8,now(),now())
        on conflict (tenant_id,semantic_query_id) do update
          set result_rows_sha256=coalesce(corvis_control.semantic_query_log.result_rows_sha256,excluded.result_rows_sha256)`,
      [identity.tenantId,semanticQueryId,identity.subject,questionHash(question),JSON.stringify(semantic.factIds),semantic.rows.length,JSON.stringify(semantic.shape),computedRowsDigest(semantic.rows)]);
      checkExecutionSignal(execution.signal);

      options.onProgress?.("retrieval");
      const hits = await this.search(identity, question, semantic.shape.fundIds, execution.signal);
      checkExecutionSignal(execution.signal);

      options.onProgress?.("generation");
      // The model gets a sanitized copy (value_string is free text from GP documents); the original rows stay the
      // source for the digest, grounding and computedResults.
      const modelRows = sanitizeRowsForModel(semantic.rows);
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
              rows: modelRows,
              result: { rows: modelRows, factIds: semantic.factIds },
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
      // The provider is external: anything other than a bounded string (a number, an object, an over-long text that
      // could never be pinned later) is a provider contract violation (502), not an internal failure.
      const answerText = body.answer;
      const uncertaintyText = body.uncertainty ?? undefined;
      const modelVersion = body.modelVersion ?? undefined;
      if (typeof answerText !== "string" || answerText.length === 0 || answerText.length > MAX_ANSWER_TEXT_LENGTH
        || (uncertaintyText !== undefined && (typeof uncertaintyText !== "string" || uncertaintyText.length > MAX_UNCERTAINTY_TEXT_LENGTH))
        || (modelVersion !== undefined && (typeof modelVersion !== "string" || modelVersion.length > MAX_MODEL_VERSION_LENGTH))) {
        throw new ResearchProviderError("ai", response.status);
      }
      const usedFactIds = normalizeUsedFactIds(body.usedFactIds, semantic.factIds);
      // Figures in the generated text must be citable facts and must appear in the cited rows (research-grounding.ts).
      // A failing answer is downgraded, not thrown: the deterministic computedResults are still worth showing and the
      // user gets a clearly labelled "no grounded figures" answer instead of a provider error. Foreign fact ids above
      // still throw: that is a contract violation, not a weak answer.
      const grounding = assessNumericGrounding(answerText, semantic.rows, usedFactIds);
      const uncertaintyGrounded = !uncertaintyText || extractNumericFigures(uncertaintyText).length === 0
        || assessNumericGrounding(uncertaintyText, semantic.rows, usedFactIds).grounded;

      const links = await this.citationLinks(identity, semanticQueryId, hits.map((hit) => hit.sourceReferenceId));
      const citations: SourceCitation[] = grounding.grounded ? hits.map((hit) => {
        const link = links.get(hit.sourceReferenceId);
        return {
          sourceReferenceId: hit.sourceReferenceId,
          documentId: hit.documentId,
          page: hit.page,
          label: hit.label || `Source ${hit.sourceReferenceId}`,
          observationId: link?.observationId,
          hasOpenReconciliation: link?.hasOpenReconciliation,
        };
      }) : [];
      const computed: SemanticComputedResult = {
        semanticQueryId,
        status: semantic.status,
        metricCode: semantic.shape.metricCode,
        operation: semantic.shape.operation,
        rows: semantic.rows,
        reason: semantic.shape.reason,
      };
      if (!grounding.grounded) {
        return {
          answer: NO_GROUNDED_FIGURES_ANSWER,
          citations,
          semanticQueryIds: [semanticQueryId],
          computedResults: [computed],
          modelVersion,
          uncertainty: NO_GROUNDED_FIGURES_UNCERTAINTY,
          grounding: "no_grounded_figures",
        };
      }
      return {
        answer: answerText,
        citations,
        semanticQueryIds: [semanticQueryId],
        computedResults: [computed],
        modelVersion,
        uncertainty: uncertaintyGrounded ? uncertaintyText : undefined,
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
