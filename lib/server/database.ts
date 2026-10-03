export type DatabasePrimitive = string | number | boolean | null;
export type DatabaseRow = Record<string, unknown>;

/**
 * Lowest-level relational persistence contract used by Corvis adapters.
 *
 * This interface is intentionally provider-neutral. Domain code should depend
 * on repository ports; repository implementations may depend on this contract.
 * Provider SDKs (Supabase, Cloud SQL connectors, RDS helpers, etc.) must stay
 * behind an adapter that implements DatabaseApi.
 *
 * SQL remains PostgreSQL-dialect today. That gives Corvis practical portability
 * between managed PostgreSQL providers without pretending that PostgreSQL and a
 * different database engine are interchangeable.
 */
export interface DatabaseApi {
  query(sql: string, parameters?: DatabasePrimitive[]): Promise<DatabaseRow[]>;
  execute(sql: string, parameters?: DatabasePrimitive[]): Promise<void>;
  health(): Promise<boolean>;
  transaction?<T>(fn: (tx: DatabaseApi) => Promise<T>): Promise<T>;
}

export type DatabaseProvider =
  | "supabase"
  | "gcp-cloud-sql"
  | "aws-rds"
  | "azure-postgresql"
  | "self-hosted"
  | "unknown";

export type DatabaseCapabilities = {
  dialect: "postgresql";
  nativeTransactions: boolean;
  rowLevelSecurity: boolean;
  advisoryLocks: boolean;
  extensions: boolean;
  logicalReplication: boolean;
};

export type DatabaseRuntime = {
  api: DatabaseApi;
  provider: DatabaseProvider;
  capabilities: DatabaseCapabilities;
};

export const POSTGRES_BASELINE_CAPABILITIES: DatabaseCapabilities = Object.freeze({
  dialect: "postgresql",
  nativeTransactions: true,
  rowLevelSecurity: true,
  advisoryLocks: true,
  extensions: true,
  logicalReplication: true,
});

/**
 * Atomic mutations must use this helper. A provider/transport that cannot hold
 * a real transaction is rejected instead of silently degrading to a sequence
 * of individually committed statements.
 *
 * This follows the same correctness principle Convex applies to mutations:
 * callers should observe an all-or-nothing state transition, not a partial one.
 */
export function requireTransaction<T>(db: DatabaseApi, fn: (tx: DatabaseApi) => Promise<T>): Promise<T> {
  if (!db.transaction) {
    throw new Error("Database transport does not provide native transactions");
  }
  return db.transaction(fn);
}

/**
 * Non-critical/read-only compatibility helper. New mutation code should prefer
 * requireTransaction so portability failures are caught at the adapter boundary.
 */
export function withOptionalTransaction<T>(db: DatabaseApi, fn: (tx: DatabaseApi) => Promise<T>): Promise<T> {
  return db.transaction ? db.transaction(fn) : fn(db);
}
