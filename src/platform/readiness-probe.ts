import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./database/postgres.ts";
import { logEvent } from "./telemetry.ts";

/**
 * Readiness for Cloud Run startup probes (#235): the production configuration must be complete and
 * Postgres must answer. A revision with a missing secret or a bad DSN then never receives traffic,
 * instead of going live and failing every request. The endpoint is unauthenticated, so the result
 * carries no detail (the cause is logged) and is cached briefly so probes cannot be used to load
 * the database.
 */
export type ReadinessResult = { ready: boolean };

const CACHE_MS = 10_000;
const DATABASE_TIMEOUT_MS = 3_000;
let cached: { at: number; result: ReadinessResult } | undefined;

export function resetReadinessCache(): void { cached = undefined; }

export async function checkReadiness(options: { now?: () => number; db?: () => PostgresSqlApi } = {}): Promise<ReadinessResult> {
  const now = options.now ?? Date.now;
  if (cached && now() - cached.at < CACHE_MS) return cached.result;
  const result = await evaluate(options.db);
  cached = { at: now(), result };
  return result;
}

async function evaluate(dbFactory?: () => PostgresSqlApi): Promise<ReadinessResult> {
  let stage = "configuration";
  try {
    const config = getServerConfig();
    if (config.demoMode) return { ready: true };
    stage = "database";
    const db = dbFactory ? dbFactory() : postgres(config.postgresDsn);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), DATABASE_TIMEOUT_MS); });
    const healthy = await Promise.race([db.health(), timeout]).finally(() => clearTimeout(timer));
    if (!healthy) throw new Error("database health check failed");
    return { ready: true };
  } catch (error) {
    logEvent("error", "runtime.readiness_failed", { correlationId: "readiness-probe" }, { stage, errorName: error instanceof Error ? error.name : typeof error });
    return { ready: false };
  }
}
