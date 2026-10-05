import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import {
  DATA_ISSUE_EXPORT_COLUMNS,
  DataIssueValidationError,
  dataIssueExportRow,
  isDataIssueStatus,
} from "../../domain/data-issue.ts";
import { toCsv } from "../../../../shared/lib/csv.ts";
import { dataIssueService } from "./data-issue-service.ts";
import { DataIssueRequestError, type DataIssueListQuery } from "./data-issue.ts";
import { apiError, json } from "../../../../platform/http/api/http.ts";
import { parseLimit } from "../../../../platform/http/api/pagination.ts";

/** Typed data-issue failures keep their stable code and status; everything else goes through the shared API error mapper. */
export function dataIssueErrorResponse(error: unknown, correlationId: string): Response {
  if (error instanceof DataIssueValidationError || error instanceof DataIssueRequestError) {
    return json({ error: error.code, correlationId }, { status: error.status });
  }
  return apiError(error, correlationId);
}

/**
 * `GET` of the case list, shared by the customer route (the caller's own reports, or the whole tenant for an
 * Organization Admin with `?scope=all`) and the Data Operations route (always the whole tenant). `?format=csv|json`
 * returns every matching case as a download for the customer's own records instead of one page.
 */
export async function listDataIssuesResponse(request: Request, identity: RequestIdentity, correlationId: string, forcedScope?: DataIssueListQuery["scope"]): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const scope = forcedScope ?? params.get("scope") ?? "mine";
  if (scope !== "mine" && scope !== "all") throw new DataIssueValidationError("invalid_scope");
  const rawStatus = params.get("status");
  if (rawStatus !== null && !isDataIssueStatus(rawStatus)) throw new DataIssueValidationError("invalid_status");
  const status = rawStatus ?? undefined;
  const format = params.get("format");
  if (format !== null && format !== "json" && format !== "csv") throw new DataIssueValidationError("invalid_format");
  const service = dataIssueService();

  if (format) {
    const exported = await service.exportAll(identity, scope);
    const items = status ? exported.items.filter((item) => item.status === status) : exported.items;
    const headers = { "content-disposition": `attachment; filename=corvis-data-issues.${format}`, "x-corvis-export-truncated": String(exported.truncated) };
    if (format === "csv") {
      return new Response(`${toCsv([[...DATA_ISSUE_EXPORT_COLUMNS], ...items.map(dataIssueExportRow)])}\n`, {
        status: 200, headers: { ...headers, "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
    return json({ data: items, truncated: exported.truncated, correlationId }, { headers });
  }

  const page = await service.list(identity, { scope, status, limit: parseLimit(params.get("limit")), cursor: params.get("cursor") });
  return json({ data: page.items, nextCursor: page.nextCursor, unseenUpdateCount: page.unseenUpdateCount, correlationId });
}
