import type { RequestIdentity, ResearchAnswer, ResearchPin } from "../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../platform/config.ts";
import { postgres, withTransaction, type PostgresRow, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import {
  assessNumericGrounding,
  computedRowsDigest,
  entitledSourceReferenceIds,
  MAX_ANSWER_TEXT_LENGTH,
  NO_GROUNDED_FIGURES_ANSWER,
  parseResearchAnswerPayload,
} from "./research-grounding.ts";

export class ResearchPinError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.name = "ResearchPinError";
    this.code = code;
    this.status = status;
  }
}

const MAX_PINS = 50;
const MAX_QUESTION_LENGTH = 2000;
/**
 * A pinned answer is the payload the caller already received; bound it so a client cannot store arbitrary blobs.
 * A semantic query returns up to 200 rows and the answer carries them all, so the bound must admit a full result
 * (a 64 KiB cap refused to pin any answer with more than ~150 realistic rows).
 */
const MAX_ANSWER_JSON_LENGTH = 512 * 1024;

function dbDefault(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new ResearchPinError("invalid_timestamp");
  return parsed.toISOString();
}

function toPin(row: PostgresRow): ResearchPin {
  return {
    pinId: String(row.pin_id),
    question: String(row.question),
    answer: (typeof row.answer === "string" ? JSON.parse(row.answer) : row.answer) as ResearchAnswer,
    askedAt: toIso(row.asked_at),
    pinnedAt: toIso(row.pinned_at),
  };
}

function unavailableInDemo(identity: RequestIdentity): boolean {
  return getServerConfig().demoMode || identity.authMethod === "demo";
}

/** The logged scope, not client-supplied rows or citations, defines all data an answer used. */
function queryScopePermitted(identity: RequestIdentity, value: unknown): boolean {
  let shape: unknown = value;
  if (typeof shape === "string") {
    try { shape = JSON.parse(shape); } catch { return false; }
  }
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return false;
  const scope = shape as Record<string, unknown>;
  const contained = (ids: unknown, permitted: string[] | undefined) =>
    Array.isArray(ids) && ids.every((id) => typeof id === "string" && (permitted ?? []).includes(id));
  return contained(scope.fundIds, identity.entitlements.fundIds)
    && contained(scope.documentIds, identity.entitlements.documentIds);
}

async function permittedQueryDigests(identity: RequestIdentity, queryIds: string[], db: PostgresSqlApi): Promise<Map<string, string | null>> {
  if (queryIds.length === 0) return new Map();
  const rows = await db.query(
    `select semantic_query_id,result_rows_sha256,query_shape from corvis_control.semantic_query_log
      where tenant_id=$1::uuid
        and semantic_query_id in (select jsonb_array_elements_text($2::jsonb))`,
    [identity.tenantId, JSON.stringify([...new Set(queryIds)])],
  );
  return new Map(rows.filter((row) => queryScopePermitted(identity, row.query_shape))
    .map((row) => [String(row.semantic_query_id), row.result_rows_sha256 == null ? null : String(row.result_rows_sha256)]));
}

function computedResultsPermitted(answer: ResearchAnswer, digests: Map<string, string | null>): boolean {
  return answer.semanticQueryIds.every((id) => digests.has(id))
    && (answer.computedResults ?? []).every((result) => digests.get(result.semanticQueryId) === computedRowsDigest(result.rows));
}

export async function listResearchPins(identity: RequestIdentity, db?: PostgresSqlApi): Promise<ResearchPin[]> {
  if (unavailableInDemo(identity)) return [];
  const database = db ?? dbDefault();
  const rows = await database.query(
    `select pin_id,question,answer,asked_at,pinned_at
       from corvis_control.research_answer_pin
      where tenant_id=$1::uuid and workspace_id=$2::uuid and auth_method=$3 and subject=$4
      order by pinned_at desc
      limit $5`,
    [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject, MAX_PINS],
  );
  const pins = rows.map(toPin);
  // Access is re-checked on read, as it was when the answer was pinned: a caller who has since lost access to a
  // cited document must not keep reading that document's figures out of an old pin.
  const citations = pins.flatMap((pin) => pin.answer.citations ?? []);
  const readable = citations.length ? await entitledSourceReferenceIds(database, identity, citations) : new Set<string>();
  const digests = await permittedQueryDigests(identity, pins.flatMap((pin) => pin.answer.semanticQueryIds), database);
  return pins.filter((pin) => (pin.answer.citations ?? []).every((citation) => readable.has(citation.sourceReferenceId))
    && computedResultsPermitted(pin.answer, digests));
}

export type PinResearchAnswerInput = { question: string; answer: ResearchAnswer; askedAt: string };

/**
 * Validates the client-supplied answer without server-held answer storage (that would need a migration):
 *  1. strict `ResearchAnswer` shape (types, lengths, array caps, no unknown keys) -> `invalid_answer` (400);
 *  2. figures in the text (and uncertainty) must be grounded in the payload's own computed rows, and a
 *     "no_grounded_figures" answer must carry exactly the server's fixed text -> `invalid_answer` (400);
 *  3. every citation must be a source reference of a document this caller may read, and every semantic query id
 *     must have a server-recorded fund/document scope contained in the caller's current entitlements -> `answer_not_permitted` (403). The ids are content
 *     hashes and the log keeps the first asker, so two users with the same question and scope share an id;
 *     the check is therefore tenant-scoped, not per-actor.
 *  4. every computed result's rows must hash to the digest the server logged for its semantic query id when it
 *     computed them (migration 070), so the pinned figures are the server's, not the client's -> `answer_not_permitted`.
 */
async function verifiedAnswer(identity: RequestIdentity, raw: unknown, database: () => PostgresSqlApi, demo: boolean): Promise<ResearchAnswer> {
  const answer = parseResearchAnswerPayload(raw);
  if (!answer || JSON.stringify(answer).length > MAX_ANSWER_JSON_LENGTH || answer.answer.length > MAX_ANSWER_TEXT_LENGTH) throw new ResearchPinError("invalid_answer");
  if (answer.grounding === "no_grounded_figures") {
    if (answer.answer !== NO_GROUNDED_FIGURES_ANSWER) throw new ResearchPinError("invalid_answer");
  } else {
    const rows = answer.computedResults?.flatMap((result) => result.rows) ?? [];
    if (!assessNumericGrounding(answer.answer, rows, undefined).grounded) throw new ResearchPinError("invalid_answer");
    if (answer.uncertainty && !assessNumericGrounding(answer.uncertainty, rows, undefined).grounded) throw new ResearchPinError("invalid_answer");
  }
  // Demo identities have no Postgres-backed documents or query log; demo pins are never persisted.
  if (demo) return answer;
  if (answer.citations.length > 0) {
    const readable = await entitledSourceReferenceIds(database(), identity, answer.citations);
    if (answer.citations.some((citation) => !readable.has(citation.sourceReferenceId))) throw new ResearchPinError("answer_not_permitted", 403);
  }
  if (answer.semanticQueryIds.length > 0) {
    const digests = await permittedQueryDigests(identity, answer.semanticQueryIds, database());
    // Missing scope/digest cannot prove either current rights or the original computed rows.
    if (!computedResultsPermitted(answer, digests)) throw new ResearchPinError("answer_not_permitted", 403);
  }
  return answer;
}

/** Stores the validated answer payload the caller already received; never re-runs the question. */
export async function pinResearchAnswer(
  identity: RequestIdentity,
  input: PinResearchAnswerInput,
  db?: PostgresSqlApi,
): Promise<ResearchPin> {
  const question = input.question.trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) throw new ResearchPinError("invalid_question");
  const demo = unavailableInDemo(identity);
  let cachedDb: PostgresSqlApi | undefined = db;
  const getDb = () => (cachedDb ??= dbDefault());
  const answer = await verifiedAnswer(identity, input.answer, getDb, demo);
  const askedAt = toIso(input.askedAt);
  if (demo) {
    return { pinId: crypto.randomUUID(), question, answer, askedAt, pinnedAt: new Date().toISOString() };
  }
  const database = getDb();
  // The count-then-insert below must not observe another concurrent pin from
  // the same subject: an advisory lock scoped to (tenant, workspace, auth
  // method, subject) serializes concurrent requests so two racing inserts
  // can't both pass the MAX_PINS check and push the subject over the cap.
  return withTransaction(database, async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${identity.tenantId}:${identity.workspaceId}:${identity.authMethod}:${identity.subject}`,
    ]);
    const countRows = await tx.query(
      `select count(*)::int as count from corvis_control.research_answer_pin
        where tenant_id=$1::uuid and workspace_id=$2::uuid and auth_method=$3 and subject=$4`,
      [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject],
    );
    if (Number(countRows[0]?.count ?? 0) >= MAX_PINS) throw new ResearchPinError("pin_limit_reached", 409);
    const rows = await tx.query(
      `insert into corvis_control.research_answer_pin
          (tenant_id,workspace_id,auth_method,subject,question,answer,asked_at,pinned_at)
        values ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::timestamptz,now())
        returning pin_id,question,answer,asked_at,pinned_at`,
      [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject, question, JSON.stringify(answer), askedAt],
    );
    return toPin(rows[0]!);
  });
}

export async function unpinResearchAnswer(identity: RequestIdentity, pinId: string, db?: PostgresSqlApi): Promise<void> {
  if (!pinId) throw new ResearchPinError("invalid_pin_id");
  if (unavailableInDemo(identity)) return;
  const database = db ?? dbDefault();
  const rows = await database.query(
    `delete from corvis_control.research_answer_pin
      where pin_id=$1::uuid and tenant_id=$2::uuid and workspace_id=$3::uuid and auth_method=$4 and subject=$5
      returning pin_id`,
    [pinId, identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject],
  );
  if (!rows.length) throw new ResearchPinError("pin_not_found", 404);
}
