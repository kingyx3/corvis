/**
 * How an error presents itself over HTTP. Module errors (a webhook subscription that does not exist, a legal hold that blocks
 * a deletion, ...) implement `toApiProblem()` next to where they are defined, so `apiError` in http.ts can answer for them
 * without the platform importing any module. `apiError` adds the `correlationId` to the body and writes the log record.
 */
export type ApiProblem = {
  status: number;
  /** Response body fields, in order; `correlationId` is appended by `apiError`. */
  body: Record<string, unknown>;
  log: { level: "info" | "warn" | "error"; event: string; fields?: Record<string, unknown> };
};

export interface ApiProblemSource {
  toApiProblem(): ApiProblem;
}

export function isApiProblemSource(error: unknown): error is ApiProblemSource {
  return typeof error === "object" && error !== null && typeof (error as { toApiProblem?: unknown }).toApiProblem === "function";
}
