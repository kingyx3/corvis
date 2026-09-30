import { createHash } from "node:crypto";
import { assertDocumentAccess } from "../../core/enterprise.ts";
import type {
  RequestIdentity,
  ResearchAnswer,
  SemanticComputedResult,
  SourceCitation,
} from "../../core/enterprise.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { rowFactIds } from "./semantic-query.ts";
import { rfc3339FromPostgres } from "./timestamps.ts";

/* -------------------------------------------------------------------------- */
/* Retrieval sanitizer (#233 c)                                               */
/* -------------------------------------------------------------------------- */

export const UNTRUSTED_INSTRUCTION_MARKER = "[untrusted-document-instruction]";
export const MAX_RETRIEVAL_SNIPPET_LENGTH = 4000;
export const MAX_RETRIEVAL_LABEL_LENGTH = 200;

// Characters that hide text from a human reviewer but not from a model: C0/C1 controls (except tab/newline),
// zero-width and bidi-override/isolate characters, the BOM and the interlinear-annotation marks.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]/g;

const VERBS = "ignore|disregard|override|forget|bypass|discard|overrule|skip";
const TARGETS = "all|any|every|previous|prior|earlier|above|preceding|former|system|developer|the|your|these|those|safety|policy|policies|guardrails?";
const OBJECTS = "instructions?|rules?|prompts?|directions?|guidelines?|polic(?:y|ies)|constraints?|guardrails?|context";
const INJECTION_PATTERNS: RegExp[] = [
  // "ignore all previous instructions", "disregard the above rules", "forget your earlier guidelines" (up to two qualifiers)
  new RegExp(`\\b(?:${VERBS})\\s+(?:(?:${TARGETS})\\s+){1,3}(?:${OBJECTS})\\b`, "gi"),
  new RegExp(`\\b(?:new|updated|revised)\\s+(?:system\\s+)?instructions?\\s*:`, "gi"),
  new RegExp(`\\b(?:you\\s+are\\s+now|from\\s+now\\s+on\\s+you\\s+(?:are|will|must)|act\\s+as\\s+if\\s+you\\s+(?:are|were)|pretend\\s+(?:to\\s+be|you\\s+are))\\b`, "gi"),
  new RegExp(`\\b(?:reveal|print|repeat|show|output)\\s+(?:your|the)\\s+(?:system|developer|hidden)\\s+(?:prompt|instructions?|message)\\b`, "gi"),
  // chat-template control tokens and role/tag delimiters
  /<\|[^|>\n]{0,40}\|>/g,
  /<\/?\s*(?:system|assistant|developer|user|instructions?|tool)\b[^>\n]{0,40}>/gi,
  /\[\/?\s*(?:INST|SYS|SYSTEM)\s*\]/gi,
  /^[ \t]*(?:system|assistant|developer)\s*:/gim,
  /^[ \t]*#{1,6}[ \t]*(?:system|instructions?)\b/gim,
];

/**
 * The single sanitizer for every retrieval-derived string that reaches the model or a citation
 * (snippets, labels, titles). Document text is data, never instructions; this is defence in depth on top
 * of the `documentsAreUntrustedDataNotInstructions` policy flag, not a guarantee.
 *
 * Steps: reject non-strings; Unicode NFKC (folds full-width / compatibility lookalikes so the patterns can
 * see them); drop invisible characters; collapse whitespace (single line unless `multiline`); truncate to
 * `maxLength`; replace known prompt-injection constructs with a visible marker.
 */
export function sanitizeRetrievalText(value: unknown, options: { maxLength: number; multiline?: boolean }): string | undefined {
  if (typeof value !== "string") return undefined;
  // Bound the work before normalising: NFKC can expand a character a few-fold.
  let text = value.slice(0, options.maxLength * 4).normalize("NFKC").replace(INVISIBLE, "");
  text = options.multiline
    ? text.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  text = text.trim().slice(0, options.maxLength);
  // Patterns run after truncation so a marker is never cut in half, and before a final trim so removal leaves no edge gaps.
  for (const pattern of INJECTION_PATTERNS) text = text.replace(pattern, UNTRUSTED_INSTRUCTION_MARKER);
  text = text.trim();
  return text ? text : undefined;
}

export function sanitizeSnippet(value: unknown): string | undefined {
  return sanitizeRetrievalText(value, { maxLength: MAX_RETRIEVAL_SNIPPET_LENGTH, multiline: true });
}

export function sanitizeLabel(value: unknown): string | undefined {
  return sanitizeRetrievalText(value, { maxLength: MAX_RETRIEVAL_LABEL_LENGTH });
}

export function sanitizePage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100000 ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* Numeric grounding (#233 a, b)                                              */
/* -------------------------------------------------------------------------- */

export type NumericFigure = {
  /** The token exactly as written in the answer. */
  raw: string;
  /** The number as written, before any magnitude suffix ("1.2" for "$1.2m"). */
  value: number;
  /** 1 for none; 1e3/1e6/1e9/1e12 for k/thousand, m/million, b/bn/billion, t/tn/trillion. */
  multiplier: number;
  /** Digits after the decimal point as written; sets the rounding tolerance. */
  decimals: number;
  unit: "none" | "percent" | "bps" | "multiple";
};

const SUFFIXES: Array<[RegExp, Pick<NumericFigure, "multiplier" | "unit">]> = [
  [/^%$|^per\s?cent$|^pct$/i, { multiplier: 1, unit: "percent" }],
  [/^bps?$|^basis\s+points?$/i, { multiplier: 1, unit: "bps" }],
  [/^x$/i, { multiplier: 1, unit: "multiple" }],
  [/^(?:k|thousand)$/i, { multiplier: 1e3, unit: "none" }],
  [/^(?:m|mm|mn|million)$/i, { multiplier: 1e6, unit: "none" }],
  [/^(?:b|bn|billion)$/i, { multiplier: 1e9, unit: "none" }],
  [/^(?:t|tn|trillion)$/i, { multiplier: 1e12, unit: "none" }],
];

// digits with optional thousands separators and decimals | plain digits with decimals | leading-dot decimals
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;
const SUFFIX = String.raw`%|per\s?cent\b|pct\b|bps?\b|basis\s+points?\b|thousand\b|million\b|billion\b|trillion\b|mm\b|mn\b|bn\b|tn\b|[kKmMbBtTxX]\b`;
const FIGURE = new RegExp(String.raw`(?<![\d.,])(${NUMBER})(?:\s?(${SUFFIX}))?(?![\w])`, "g");

const WORD_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const WORD_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD_SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
const WORD_UNIT_SUFFIX = /^[ \t]*(%|per[ \t]?cent\b|pct\b|basis[ \t]+points?\b|bps?\b)/i;

/**
 * Spelled-out numbers ("four percent", "twelve million", "twenty-five", "one hundred and five", "two point five
 * percent"). A lone small number word ("one of the funds", "three companies") is prose, not a checkable claim,
 * so a phrase counts as a figure only when it carries a unit, ends in a magnitude word or is a compound of two or
 * more number words.
 */
function extractSpelledFigures(text: string): NumericFigure[] {
  const tokens = [...text.matchAll(/[A-Za-z]+/g)].map((match) => ({ word: match[0].toLowerCase(), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }));
  const isNumberWord = (word: string) => word in WORD_UNITS || word in WORD_TENS || word === "hundred" || word in WORD_SCALES;
  const adjacent = (a: { end: number }, b: { start: number }) => /^[ \t-]+$/.test(text.slice(a.end, b.start));
  const figures: NumericFigure[] = [];
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i]!;
    if (!(first.word in WORD_UNITS || first.word in WORD_TENS) || (i > 0 && adjacent(tokens[i - 1]!, first) && isNumberWord(tokens[i - 1]!.word))) { i += 1; continue; }
    let total = 0, current = 0, words = 0, lastScale = 1, j = i, last = first;
    const parts: string[] = [];
    while (j < tokens.length) {
      const token = tokens[j]!;
      if (j > i && !adjacent(last, token)) break;
      const { word } = token;
      if (word === "and" && j > i && (last.word === "hundred" || last.word in WORD_SCALES) && tokens[j + 1] && adjacent(token, tokens[j + 1]!) && (tokens[j + 1]!.word in WORD_UNITS || tokens[j + 1]!.word in WORD_TENS)) { last = token; j += 1; continue; }
      if (word in WORD_UNITS) current += WORD_UNITS[word]!;
      else if (word in WORD_TENS) current += WORD_TENS[word]!;
      else if (word === "hundred") current = (current || 1) * 100;
      else if (word in WORD_SCALES) { total += (current || 1) * WORD_SCALES[word]!; current = 0; lastScale = WORD_SCALES[word]!; }
      else break;
      lastScale = word in WORD_SCALES ? lastScale : 1;
      parts.push(word); words += 1; last = token; j += 1;
    }
    let value = total + current;
    let decimals = 0;
    // "two point five": digit words after "point" are the decimal places.
    if (tokens[j]?.word === "point" && adjacent(last, tokens[j]!)) {
      let k = j + 1, fraction = "", prev = tokens[j]!;
      while (k < tokens.length && tokens[k]!.word in WORD_UNITS && WORD_UNITS[tokens[k]!.word]! < 10 && adjacent(prev, tokens[k]!)) { fraction += String(WORD_UNITS[tokens[k]!.word]); prev = tokens[k]!; k += 1; }
      if (fraction) { value = Number(`${value}.${fraction}`); decimals = fraction.length; words += 1 + fraction.length; parts.push("point", fraction); last = prev; j = k; }
    }
    const unitMatch = WORD_UNIT_SUFFIX.exec(text.slice(last.end));
    const suffixText = unitMatch?.[1] ?? "";
    const suffix = suffixText ? SUFFIXES.find(([pattern]) => pattern.test(suffixText.replace(/[ \t]+/g, " ")))?.[1] : undefined;
    if (suffix || lastScale > 1 || words >= 2) {
      figures.push({
        raw: `${parts.join(" ")}${suffixText ? ` ${suffixText}` : ""}`,
        value: lastScale > 1 ? value / lastScale : value,
        multiplier: lastScale,
        decimals,
        unit: suffix?.unit ?? "none",
      });
    }
    i = Math.max(j, i + 1);
  }
  return figures;
}

/**
 * Pulls the numeric claims out of free text. Deliberately NOT counted as figures (they are labels, not claims):
 * bare four-digit years 1900-2100, dates (ISO, uuids, urls are stripped first), list markers at the start of a
 * line, and digits glued to letters such as "Q2", "FY25", "H1", "fund-a2", "company-7" (a currency code such as "USD100" is
 * still a figure). Spelled-out numbers are parsed too (see `extractSpelledFigures`), so writing "four percent"
 * instead of "4%" does not bypass the grounding check.
 */
export function extractNumericFigures(text: string): NumericFigure[] {
  const cleaned = text
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?)?\b/gi, " ")
    .replace(/^[ \t]*(?:[-*•][ \t]*)?\d{1,2}[.)][ \t]/gm, " ");
  const figures: NumericFigure[] = [];
  for (const match of cleaned.matchAll(FIGURE)) {
    const numberText = match[1] ?? "";
    const suffixText = (match[2] ?? "").trim();
    const before = cleaned.slice(0, match.index ?? 0);
    if (/[A-Za-z_]-?$/.test(before) && !/\b[A-Z]{3}$/.test(before)) continue;
    const value = Number(numberText.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const suffix = suffixText ? SUFFIXES.find(([pattern]) => pattern.test(suffixText))?.[1] : undefined;
    if (!suffix && Number.isInteger(value) && !numberText.includes(",") && numberText.length === 4 && value >= 1900 && value <= 2100) continue;
    const dot = numberText.indexOf(".");
    figures.push({
      raw: `${numberText}${suffixText ? ` ${suffixText}` : ""}`,
      value,
      multiplier: suffix?.multiplier ?? 1,
      decimals: dot === -1 ? 0 : numberText.length - dot - 1,
      unit: suffix?.unit ?? "none",
    });
  }
  figures.push(...extractSpelledFigures(cleaned));
  return figures;
}

/**
 * True when `figure` is a faithful rendering of `evidence`. Rules (each is exercised in the table test):
 *  - thousands separators, currency symbols/codes and magnitude words are formatting: "$1.2m" == 1200000;
 *  - rounding is allowed only to the precision shown: the figure must be within half a unit of its last
 *    written digit ("1.2m" covers 1,150,000..1,250,000; "100" covers 99.5..100.5; "12.5%" covers 12.45..12.55);
 *  - "%" matches the stored value either as percentage points (12.5) or as a fraction (0.125);
 *  - "bps" matches basis points, percentage points or a fraction (250 bps == 2.5 == 0.025);
 *  - sign is ignored ("fell 5%" grounds against -5); direction is not verified here;
 *  - nothing else is derived: a difference or ratio the model computed itself is NOT grounded.
 */
export function figureMatchesEvidence(figure: NumericFigure, evidence: number): boolean {
  if (!Number.isFinite(evidence)) return false;
  const shown = Math.abs(figure.value * figure.multiplier);
  const tolerance = 0.5 * 10 ** -figure.decimals * figure.multiplier + 1e-9 * Math.max(1, shown);
  const target = Math.abs(evidence);
  const close = (candidate: number) => Math.abs(candidate - shown) <= tolerance;
  switch (figure.unit) {
    case "percent": return close(target) || close(target * 100);
    case "bps": return close(target) || close(target * 100) || close(target * 10000);
    default: return close(target);
  }
}

/** Numeric evidence a semantic row can legitimately ground: stored values, aggregate results and counts only. */
const EVIDENCE_KEYS = ["value_number", "result_value", "row_count", "value_string"] as const;

export function rowEvidenceNumbers(row: PostgresRow): number[] {
  const numbers: number[] = [];
  for (const key of EVIDENCE_KEYS) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) numbers.push(value);
    else if (typeof value === "bigint") numbers.push(Number(value));
    else if (typeof value === "string" && value.trim()) {
      // Postgres returns numeric/bigint as strings; a free-text value_string may embed figures ("12.5%", "$3m").
      const asNumber = Number(value.trim());
      if (Number.isFinite(asNumber)) numbers.push(asNumber);
      else for (const figure of extractNumericFigures(value)) numbers.push(figure.value * figure.multiplier);
    }
  }
  return numbers;
}

export type GroundingAssessment =
  | { grounded: true; figures: NumericFigure[] }
  | { grounded: false; reason: "no_cited_facts" | "ungrounded_figures"; figures: NumericFigure[]; ungrounded: NumericFigure[] };

/**
 * Decides whether `text` may be shown as grounded. Text without numeric claims is trivially grounded. Text with
 * figures needs (1) at least one cited fact id and (2) every figure to be a faithful rendering of a number in
 * the semantic rows those facts belong to (plus the row count, so "3 records" is checkable).
 * `citedFactIds === undefined` means "not applicable, ground against all rows" (used when re-checking a pin,
 * where the client payload carries no fact ids).
 */
export function assessNumericGrounding(text: string, rows: PostgresRow[], citedFactIds: string[] | undefined): GroundingAssessment {
  const figures = extractNumericFigures(text);
  if (figures.length === 0) return { grounded: true, figures };
  if (citedFactIds !== undefined && citedFactIds.length === 0) return { grounded: false, reason: "no_cited_facts", figures, ungrounded: figures };
  const cited = citedFactIds === undefined ? undefined : new Set(citedFactIds);
  const evidenceRows = cited ? rows.filter((row) => rowFactIds(row).some((id) => cited.has(id))) : rows;
  const evidence = [...evidenceRows.flatMap(rowEvidenceNumbers), evidenceRows.length];
  const ungrounded = figures.filter((figure) => !evidence.some((value) => figureMatchesEvidence(figure, value)));
  return ungrounded.length === 0 ? { grounded: true, figures } : { grounded: false, reason: "ungrounded_figures", figures, ungrounded };
}

/** Shown in place of any model answer that states figures the governed result does not support. */
export const NO_GROUNDED_FIGURES_ANSWER =
  "Corvis could not verify the figures in the generated answer against the governed data, so no answer is shown. " +
  "The governed query result below is the authoritative source; rephrase the question or open the cited data.";
export const NO_GROUNDED_FIGURES_UNCERTAINTY = "Generated figures were not grounded in the governed semantic result and were withheld.";

/* -------------------------------------------------------------------------- */
/* Citation entitlement (#233 d)                                              */
/* -------------------------------------------------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

/**
 * The `GET /source-references/[id]` rule, applied in bulk: the reference must exist in the caller's tenant
 * (`corvis_serving.source_references`, the same table `getSourceReference` reads), it must belong to the document
 * the citation claims, and `assertDocumentAccess(identity, documentId, true)` must pass. Returns the source
 * reference ids that are readable; anything missing, mismatched or not entitled is simply absent (a caller cannot
 * distinguish "does not exist" from "not yours"). Database errors propagate: entitlement fails closed.
 */
export async function entitledSourceReferenceIds(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  claims: Array<{ sourceReferenceId: string; documentId: string }>,
): Promise<Set<string>> {
  const readable = new Set<string>();
  const candidates = claims.filter((claim) => isUuid(claim.sourceReferenceId) && typeof claim.documentId === "string" && claim.documentId && documentReadable(identity, claim.documentId));
  const ids = [...new Set(candidates.map((claim) => claim.sourceReferenceId))];
  if (ids.length === 0) return readable;
  const rows = await db.query(
    `select source_reference_id,document_id
       from corvis_serving.source_references
      where tenant_id=$1 and source_reference_id in (select jsonb_array_elements_text($2::jsonb)::uuid)`,
    [identity.tenantId, JSON.stringify(ids)],
  );
  const documentBySource = new Map(rows.map((row) => [String(row.source_reference_id).toLowerCase(), String(row.document_id ?? "")]));
  for (const claim of candidates) {
    const actual = documentBySource.get(claim.sourceReferenceId.toLowerCase());
    if (actual && actual === claim.documentId && documentReadable(identity, actual)) readable.add(claim.sourceReferenceId);
  }
  return readable;
}

function documentReadable(identity: RequestIdentity, documentId: string): boolean {
  try {
    assertDocumentAccess(identity, documentId, true);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Computed-result digest (#245)                                              */
/* -------------------------------------------------------------------------- */

function canonicalCell(value: unknown): unknown {
  if (typeof value === "string") return rfc3339FromPostgres(value);
  if (Array.isArray(value)) return value.map(canonicalCell);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalCell((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON of a semantic result's rows: keys sorted and Postgres timestamp text normalised
 * exactly as the API emits it, so the rows a client received (and sends back when pinning) hash to the same value
 * the server logged when it computed them.
 */
export function computedRowsDigest(rows: ReadonlyArray<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(rows.map(canonicalCell))).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Strict ResearchAnswer payload validation (#233 e)                          */
/* -------------------------------------------------------------------------- */

export const MAX_ANSWER_TEXT_LENGTH = 20000;
const MAX_CITATIONS = 20;
const MAX_SEMANTIC_QUERY_IDS = 10;
const MAX_COMPUTED_RESULTS = 10;
const MAX_ROWS = 200;
const MAX_ROW_KEYS = 40;
const MAX_STRING = 2000;
const MAX_ID = 128;
const SEMANTIC_QUERY_ID = /^sq_[0-9a-f]{24}$/;
const STATUSES = ["executed", "unresolved", "unsupported"];
const OPERATIONS = ["values", "sum", "average", "minimum", "maximum", "count"];
const GROUNDING = ["grounded", "no_grounded_figures"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function str(value: unknown, max: number, min = 0): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
function optionalStr(value: unknown, max: number): boolean { return value === undefined || str(value, max); }

function parseCitation(value: unknown): SourceCitation | null {
  if (!isPlainObject(value) || !onlyKeys(value, ["sourceReferenceId", "documentId", "page", "label", "observationId", "hasOpenReconciliation"])) return null;
  if (!str(value.sourceReferenceId, MAX_ID, 1) || !str(value.documentId, MAX_ID, 1) || !str(value.label, MAX_RETRIEVAL_LABEL_LENGTH * 2)) return null;
  if (!optionalStr(value.observationId, MAX_ID)) return null;
  if (value.page !== undefined && sanitizePage(value.page) === undefined) return null;
  if (value.hasOpenReconciliation !== undefined && typeof value.hasOpenReconciliation !== "boolean") return null;
  return {
    sourceReferenceId: value.sourceReferenceId,
    documentId: value.documentId,
    label: value.label,
    ...(value.page !== undefined ? { page: value.page as number } : {}),
    ...(value.observationId !== undefined ? { observationId: value.observationId as string } : {}),
    ...(value.hasOpenReconciliation !== undefined ? { hasOpenReconciliation: value.hasOpenReconciliation as boolean } : {}),
  };
}

function parseCell(value: unknown): unknown | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= MAX_STRING ? value : undefined;
  if (Array.isArray(value)) {
    // e.g. source_observation_ids on aggregate rows
    if (value.length > 1000 || !value.every((item) => typeof item === "string" && item.length <= MAX_ID)) return undefined;
    return [...value];
  }
  return undefined;
}

function parseRow(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > MAX_ROW_KEYS) return null;
  const row: Record<string, unknown> = {};
  for (const key of keys) {
    if (key.length > 64) return null;
    const cell = parseCell(value[key]);
    if (cell === undefined) return null;
    row[key] = cell;
  }
  return row;
}

function parseComputed(value: unknown): SemanticComputedResult | null {
  if (!isPlainObject(value) || !onlyKeys(value, ["semanticQueryId", "status", "metricCode", "operation", "rows", "reason"])) return null;
  if (typeof value.semanticQueryId !== "string" || !SEMANTIC_QUERY_ID.test(value.semanticQueryId)) return null;
  if (typeof value.status !== "string" || !STATUSES.includes(value.status)) return null;
  if (typeof value.operation !== "string" || !OPERATIONS.includes(value.operation)) return null;
  if (!optionalStr(value.metricCode, MAX_ID) || !optionalStr(value.reason, MAX_STRING)) return null;
  if (!Array.isArray(value.rows) || value.rows.length > MAX_ROWS) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const item of value.rows) {
    const row = parseRow(item);
    if (!row) return null;
    rows.push(row);
  }
  return {
    semanticQueryId: value.semanticQueryId,
    status: value.status as SemanticComputedResult["status"],
    operation: value.operation as SemanticComputedResult["operation"],
    rows,
    ...(value.metricCode !== undefined ? { metricCode: value.metricCode as string } : {}),
    ...(value.reason !== undefined ? { reason: value.reason as string } : {}),
  };
}

/**
 * Strictly validates a client-supplied answer payload against `ResearchAnswer` and returns a fresh object built
 * only from validated fields (unknown keys are rejected, not silently kept). Returns null when anything is
 * malformed: wrong types, over-long strings, over-large arrays, non-finite numbers, computed results that
 * reference a query id the answer does not list, or a semantic query id that is not a server-issued `sq_` id.
 */
export function parseResearchAnswerPayload(value: unknown): ResearchAnswer | null {
  if (!isPlainObject(value) || !onlyKeys(value, ["answer", "citations", "semanticQueryIds", "computedResults", "modelVersion", "uncertainty", "grounding"])) return null;
  if (!str(value.answer, MAX_ANSWER_TEXT_LENGTH, 1)) return null;
  if (!optionalStr(value.modelVersion, MAX_ID) || !optionalStr(value.uncertainty, MAX_STRING)) return null;
  if (value.grounding !== undefined && (typeof value.grounding !== "string" || !GROUNDING.includes(value.grounding))) return null;
  if (!Array.isArray(value.citations) || value.citations.length > MAX_CITATIONS) return null;
  const citations: SourceCitation[] = [];
  for (const item of value.citations) {
    const citation = parseCitation(item);
    if (!citation) return null;
    citations.push(citation);
  }
  if (!Array.isArray(value.semanticQueryIds) || value.semanticQueryIds.length > MAX_SEMANTIC_QUERY_IDS) return null;
  if (!value.semanticQueryIds.every((id) => typeof id === "string" && SEMANTIC_QUERY_ID.test(id))) return null;
  const semanticQueryIds = [...new Set(value.semanticQueryIds as string[])];
  let computedResults: SemanticComputedResult[] | undefined;
  if (value.computedResults !== undefined) {
    if (!Array.isArray(value.computedResults) || value.computedResults.length > MAX_COMPUTED_RESULTS) return null;
    computedResults = [];
    for (const item of value.computedResults) {
      const computed = parseComputed(item);
      if (!computed || !semanticQueryIds.includes(computed.semanticQueryId)) return null;
      computedResults.push(computed);
    }
  }
  return {
    answer: value.answer,
    citations,
    semanticQueryIds,
    ...(computedResults ? { computedResults } : {}),
    ...(value.modelVersion !== undefined ? { modelVersion: value.modelVersion as string } : {}),
    ...(value.uncertainty !== undefined ? { uncertainty: value.uncertainty as string } : {}),
    ...(value.grounding !== undefined ? { grounding: value.grounding as ResearchAnswer["grounding"] } : {}),
  };
}
