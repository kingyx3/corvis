import type { RequestIdentity, ResearchAnswer, ResearchPin } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

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
  return rows.map(toPin);
}

export type PinResearchAnswerInput = { question: string; answer: ResearchAnswer; askedAt: string };

/** Stores the exact answer payload the caller already received; never re-runs the question. */
export async function pinResearchAnswer(
  identity: RequestIdentity,
  input: PinResearchAnswerInput,
  db?: PostgresSqlApi,
): Promise<ResearchPin> {
  const question = input.question.trim();
  if (!question || question.length > MAX_QUESTION_LENGTH) throw new ResearchPinError("invalid_question");
  if (!input.answer || typeof input.answer.answer !== "string") throw new ResearchPinError("invalid_answer");
  const askedAt = toIso(input.askedAt);
  if (unavailableInDemo(identity)) {
    return { pinId: crypto.randomUUID(), question, answer: input.answer, askedAt, pinnedAt: new Date().toISOString() };
  }
  const database = db ?? dbDefault();
  const countRows = await database.query(
    `select count(*)::int as count from corvis_control.research_answer_pin
      where tenant_id=$1::uuid and workspace_id=$2::uuid and auth_method=$3 and subject=$4`,
    [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject],
  );
  if (Number(countRows[0]?.count ?? 0) >= MAX_PINS) throw new ResearchPinError("pin_limit_reached", 409);
  const rows = await database.query(
    `insert into corvis_control.research_answer_pin
        (tenant_id,workspace_id,auth_method,subject,question,answer,asked_at,pinned_at)
      values ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::timestamptz,now())
      returning pin_id,question,answer,asked_at,pinned_at`,
    [identity.tenantId, identity.workspaceId, identity.authMethod, identity.subject, question, JSON.stringify(input.answer), askedAt],
  );
  return toPin(rows[0]!);
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
