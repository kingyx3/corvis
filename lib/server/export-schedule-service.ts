import type { RequestIdentity } from "../../core/enterprise.ts";
import type { CreateExportScheduleCommand, ExportSchedule, ExportScheduleAction } from "../../core/export-schedule.ts";
import { demoExportScheduleStore } from "../../adapters/demo/export-schedule-store.ts";
import { runAuditedMutation } from "./audited-mutation.ts";
import { getServerConfig } from "./config.ts";
import {
  PostgresExportScheduleBackend,
  assertCanViewAll,
  type DeletedExportSchedule,
  exportScheduleAuditEvent,
  type ExportScheduleBackend,
  type ExportSchedulePage,
  type ExportScheduleListQuery,
  type ExportScheduleRunListQuery,
  type ExportScheduleRunPage,
} from "./export-schedule.ts";
import { postgres } from "./postgres.ts";

/**
 * The customer-facing scheduled-export operations behind `/api/v1/export-schedules/**`, over either backend (Postgres, or
 * the in-memory demo store in demo mode). Authorization that does not depend on where schedules are stored lives here,
 * once: who may list the whole tenant. Mutations run through `runAuditedMutation`, so the command and its audit event
 * commit together. Only a schedule's owner can pause, resume or delete it; the backend finds nothing for anyone else.
 */
export interface ExportScheduleService {
  create(identity: RequestIdentity, command: CreateExportScheduleCommand, correlationId: string): Promise<{ item: ExportSchedule; created: boolean }>;
  list(identity: RequestIdentity, query: ExportScheduleListQuery): Promise<ExportSchedulePage>;
  get(identity: RequestIdentity, scheduleId: string): Promise<ExportSchedule>;
  setStatus(identity: RequestIdentity, scheduleId: string, action: ExportScheduleAction, correlationId: string): Promise<ExportSchedule>;
  /** The owner switches the emails about their schedule on or off (F4b). Audited with the new value. */
  setNotification(identity: RequestIdentity, scheduleId: string, notifyOnCompletion: boolean, correlationId: string): Promise<ExportSchedule>;
  remove(identity: RequestIdentity, scheduleId: string, correlationId: string): Promise<DeletedExportSchedule>;
  /** Every run (including refused ones) of the schedules the caller may list: the scheduled part of delivery history. */
  listRuns(identity: RequestIdentity, query: ExportScheduleRunListQuery): Promise<ExportScheduleRunPage>;
}

export function createExportScheduleService(backend: ExportScheduleBackend): ExportScheduleService {
  return {
    async create(identity, command, correlationId) {
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.create(identity, command, db),
        // A replayed request changed nothing, so it needs no second audit event.
        audit: (result) => result.created ? exportScheduleAuditEvent(identity, correlationId, "export_schedule.create", result.item) : undefined,
      });
    },
    async list(identity, query) {
      if (query.scope === "all") assertCanViewAll(identity);
      return backend.list(identity, query);
    },
    async get(identity, scheduleId) { return backend.get(identity, scheduleId); },
    async setStatus(identity, scheduleId, action, correlationId) {
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.setStatus(identity, scheduleId, action, db),
        audit: (item) => exportScheduleAuditEvent(identity, correlationId, `export_schedule.${action}`, item),
      });
    },
    async setNotification(identity, scheduleId, notifyOnCompletion, correlationId) {
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.setNotification(identity, scheduleId, notifyOnCompletion, db),
        audit: (item) => exportScheduleAuditEvent(identity, correlationId, "export_schedule.notify", item, { notifyOnCompletion: item.notifyOnCompletion }),
      });
    },
    async remove(identity, scheduleId, correlationId) {
      return runAuditedMutation({
        demoMode: backend.demo,
        mutate: (db) => backend.remove(identity, scheduleId, db),
        audit: (item) => exportScheduleAuditEvent(identity, correlationId, "export_schedule.delete", { ...item, status: "deleted" }),
      });
    },
    async listRuns(identity, query) {
      if (query.scope === "all") assertCanViewAll(identity);
      return backend.listRuns(identity, query);
    },
  };
}

export const postgresExportScheduleService: ExportScheduleService = createExportScheduleService(new PostgresExportScheduleBackend(() => postgres(getServerConfig().postgresDsn)));
export const demoExportScheduleService: ExportScheduleService = createExportScheduleService(demoExportScheduleStore());

let override: ExportScheduleService | undefined;

/** Pins the implementation (or, with no argument, restores config-based selection). Used by tests that drive the Postgres path under a demo identity. */
export function overrideExportScheduleService(service?: ExportScheduleService): void { override = service; }

export function exportScheduleService(): ExportScheduleService {
  return override ?? (getServerConfig().demoMode ? demoExportScheduleService : postgresExportScheduleService);
}
