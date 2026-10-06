import type { ApiProblem, ApiProblemSource } from "./api-problem.ts";

/** The caller could not be authenticated: answered `401 authentication_required` without saying why. */
export class AuthenticationError extends Error implements ApiProblemSource {
  constructor(message: string) { super(message); this.name = "AuthenticationError"; }
  toApiProblem(): ApiProblem {
    return { status: 401, body: { error: "authentication_required" }, log: { level: "warn", event: "api.authentication_denied" } };
  }
}
