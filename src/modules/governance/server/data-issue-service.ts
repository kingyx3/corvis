import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import type { DataIssueCase, DataIssueTransitionCommand, ReportDataIssueCommand } from "../domain/data-issue.ts";
import { demoDataIssueStore } from "../adapters/data-issue-store.ts";
import { runAuditedMutation } from "./audited-mutation.ts";
import { getServerConfig } from "../../../platform/config.ts";
import {
  PostgresDataIssueBackend,
  assertCanReport,
  assertCanViewAll,
  dataIssueAuditEvent,
  type DataIssueBackend,
  type DataIssueList,
  type DataIssueListQuery,
} from "./data-issue.ts";
import { MAX_PAGE_LIMIT } from "../../../platform/http/pagination.ts";
import { postgres } from "../../../platform/database/postgres.ts";

/**
 * The customer-facing data-issue operations behind `/api/v1/data-issues/**` and `/api/v1/admin/data-issues/**`, over
 * either backend (Postgres, or the in-memory demo store in demo mode). Authorization that does not depend on where cases
 * are stored lives here, once: who may report on a fund, who may list the whole tenant, who may move a case. Mutations
 * run through `runAuditedMutation`, so the command and its audit event commit together.
 */
export interface DataIssueService {
  report(identity: RequestIdentity, command: ReportDataIssueCommand, correlationId: string): Promise<{ item: DataIssueCase; created: boolean }>;
  list(identity: RequestIdentity, query: DataIssueListQuery): Promise<DataIssueList>;
  /** Every case the caller may list, for the customer's own records (CSV/JSON export). */
  exportAll(identity: RequestIdentity, scope: DataIssueListQuery["scope"]): Promise<{ items: DataIssueCase[]; truncated: boolean }>;
  get(identity: RequestIdentity, caseId: string): Promise<DataIssueCase>;
  /** The reporter has seen the case's current status: clears its "updated" indicator. */
  acknowledge(identity: RequestIdentity, caseId: string): Promise<DataIssueCase>;
  /** Data Operations moves a case (Organization Admins only). */
  transition(identity: RequestIdentity, caseId: string, command: DataIssueTransitionCommand, correlationId: string): Promise<DataIssueCase>;
}

/** 50 pages of 200: far beyond any realistic number of reports, and a ceiling on one export's memory. */
export const MAX_EXPORT_PAGES = 50;

export function createDataIssueService(backend: DataIssueBackend): DataIssueService {
  return {
    async report(identity, command, correlationId) {
      assertCanReport(identity, command.scope.fundId);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.report(identity, command, db),
        // A replayed report changed nothing, so it needs no second audit event.
        audit: (result) => result.created ? dataIssueAuditEvent(identity, correlationId, "data_issue.report", result.item) : undefined,
      });
    },
    async list(identity, query) {
      if (query.scope === "all") assertCanViewAll(identity);
      return backend.list(identity, query);
    },
    async exportAll(identity, scope) {
      if (scope === "all") assertCanViewAll(identity);
      const items: DataIssueCase[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
        const result: DataIssueList = await backend.list(identity, { scope, limit: MAX_PAGE_LIMIT, cursor });
        items.push(...result.items);
        cursor = result.nextCursor;
        if (cursor === null) return { items, truncated: false };
      }
      return { items, truncated: true };
    },
    async get(identity, caseId) { return backend.get(identity, caseId); },
    async acknowledge(identity, caseId) { return backend.acknowledge(identity, caseId); },
    async transition(identity, caseId, command, correlationId) {
      assertCanViewAll(identity);
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.transition(identity, caseId, command, db),
        audit: (item) => dataIssueAuditEvent(identity, correlationId, `data_issue.${command.action}`, item),
      });
    },
  };
}

export const postgresDataIssueService: DataIssueService = createDataIssueService(new PostgresDataIssueBackend(() => postgres(getServerConfig().postgresDsn)));
export const demoDataIssueService: DataIssueService = createDataIssueService(demoDataIssueStore());

let override: DataIssueService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideDataIssueService(service?: DataIssueService): void { override = service; }

export function dataIssueService(): DataIssueService {
  return override ?? (getServerConfig().demoMode ? demoDataIssueService : postgresDataIssueService);
}
