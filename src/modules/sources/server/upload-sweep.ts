import { getServerConfig } from "../../../platform/config.ts";
import { gcs, type UploadObjectStore } from "../../../platform/gcp/gcs.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { logEvent } from "../../../platform/telemetry.ts";
import { uploads, type UploadLifecycleSweep, type UploadSessionPort } from "./uploads.ts";

export type ScheduledUploadSweepSummary = Omit<UploadLifecycleSweep, "nextCursor"> & { tenants: number; errors: number };

export type ScheduledUploadSweepOptions = {
  store?: UploadObjectStore;
  db?: PostgresSqlApi;
  sessions?: UploadSessionPort;
  /** Session objects visited per tenant per tick. */
  pageSize?: number;
  /** Stop starting new tenants after this long so overlapping scheduler ticks stay bounded. */
  budgetMs?: number;
  now?: () => number;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_BUDGET_MS = 60_000;

/** Where each tenant's sweep resumes; kept beside the session objects it pages through. */
export function uploadSweepCursorKey(tenantId: string): string {
  return `_corvis/upload-sweep-cursors/tenant=${encodeURIComponent(tenantId)}.json`;
}

/** The last tenant a tick reached, so the next tick resumes after it. */
export const UPLOAD_SWEEP_ROTATION_KEY = "_corvis/upload-sweep-cursors/_rotation.json";

/**
 * Runs `UploadSessionPort.sweep` from the private worker's scheduler tick (#232, #245), which
 * nothing called before: abandoned resumable sessions and quarantined bytes without a clean
 * disposition were never purged. Each tick sweeps one page per active tenant and stores the
 * page cursor, so successive ticks walk every session and wrap around; a tenant whose sweep
 * fails is counted and retried from the same cursor on the next tick without blocking the rest.
 * Tenants are visited in rotation, resuming after the last one the previous tick started, so a tick
 * cut short by its time budget never starves the tenants at the end of the list.
 */
export async function sweepUploadSessions(options: ScheduledUploadSweepOptions = {}): Promise<ScheduledUploadSweepSummary> {
  const summary: ScheduledUploadSweepSummary = { tenants: 0, scanned: 0, abandoned: 0, quarantinePurged: 0, retained: 0, skipped: 0, errors: 0 };
  const config = getServerConfig();
  if (config.demoMode && !options.sessions) return summary;
  const store = options.store ?? gcs();
  const db = options.db ?? postgres(config.postgresDsn);
  const sessions = options.sessions ?? uploads();
  const now = options.now ?? Date.now;
  const started = now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  const rows = await db.query(`select tenant_id::text as tenant_id from corvis_control.tenant where status='active' order by tenant_id`);
  // The budget can end a tick before the last tenants: always starting at the first would starve the tail
  // forever, so each tick resumes after the tenant the previous one reached.
  const tenantIds = rows.map((row) => String(row.tenant_id));
  const tenants = rotateAfter(tenantIds, await readRotation(store));
  let reached: string | undefined;
  for (const tenantId of tenants) {
    if (now() - started > budgetMs) break;
    reached = tenantId;
    const cursorKey = uploadSweepCursorKey(tenantId);
    try {
      const saved = await store.getJson<{ cursor?: string | null }>(cursorKey);
      const cursor = typeof saved?.cursor === "string" && saved.cursor ? saved.cursor : undefined;
      const result = await sessions.sweep(tenantId, { limit: pageSize, cursor });
      await store.putJson(cursorKey, { cursor: result.nextCursor ?? null, sweptAt: new Date(now()).toISOString() });
      summary.tenants += 1;
      summary.scanned += result.scanned;
      summary.abandoned += result.abandoned;
      summary.quarantinePurged += result.quarantinePurged;
      summary.retained += result.retained;
      summary.skipped += result.skipped;
    } catch (error) {
      summary.errors += 1;
      logEvent("error", "upload.sweep_failed", { correlationId: `upload-sweep:${started}`, tenantId }, { errorName: error instanceof Error ? error.name : typeof error });
    }
  }
  if (reached !== undefined) {
    // Best effort: without the record the next tick just restarts from the first tenant.
    await store.putJson(UPLOAD_SWEEP_ROTATION_KEY, { lastTenantId: reached }).catch((error: unknown) => {
      logEvent("warn", "upload.sweep_rotation_unsaved", { correlationId: `upload-sweep:${started}` }, { errorName: error instanceof Error ? error.name : typeof error });
    });
  }
  return summary;
}

async function readRotation(store: UploadObjectStore): Promise<string | undefined> {
  const saved = await store.getJson<{ lastTenantId?: unknown }>(UPLOAD_SWEEP_ROTATION_KEY).catch(() => null);
  return typeof saved?.lastTenantId === "string" ? saved.lastTenantId : undefined;
}

/** `tenantIds` (sorted) starting at the first id after `lastTenantId`, wrapping around; unchanged without one. */
function rotateAfter(tenantIds: string[], lastTenantId: string | undefined): string[] {
  if (lastTenantId === undefined) return tenantIds;
  const start = tenantIds.findIndex((tenantId) => tenantId > lastTenantId);
  return start <= 0 ? tenantIds : [...tenantIds.slice(start), ...tenantIds.slice(0, start)];
}
