import {
  POSTGRES_BASELINE_CAPABILITIES,
  requireTransaction,
  type DatabaseApi,
  type DatabasePrimitive,
  type DatabaseProvider,
  type DatabaseRow,
  type DatabaseRuntime,
} from "./database.ts";
import { isProductionEnvironment } from "../config/config.ts";
import { NativePostgresSqlApi } from "./postgres-native.ts";

/** Backwards-compatible aliases while callers migrate to the provider-neutral names. */
export type PostgresPrimitive = DatabasePrimitive;
export type PostgresRow = DatabaseRow;
export type PostgresSqlApi = DatabaseApi;

/**
 * Compatibility helper for existing callers. New mutation code should prefer
 * requireTransaction from database.ts so a non-transactional transport cannot
 * silently weaken atomicity.
 */
export const withTransaction = requireTransaction;

const nativeClients = new Map<string, NativePostgresSqlApi>();
const NATIVE_POSTGRES_DSN = /^postgres(?:ql)?:\/\//i;

/** A transport for a DSN scheme the native PostgreSQL client does not handle. */
export type DatabaseDriver = {
  accepts(dsn: string): boolean;
  connect(dsn: string): PostgresSqlApi;
};

const additionalDrivers: DatabaseDriver[] = [];

/**
 * Extension point for tests that need an in-process database double behind a non-native DSN.
 * It refuses to run in production, where `getServerConfig()` already requires a native
 * `postgres://` or `postgresql://` DSN, so a deployed process can only ever speak the PostgreSQL
 * wire protocol to its database.
 */
export function registerDatabaseDriver(driver: DatabaseDriver, nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (isProductionEnvironment(nodeEnv)) throw new Error("Database drivers other than native PostgreSQL cannot be registered in production");
  additionalDrivers.push(driver);
}

/**
 * Native provider DSNs use the PostgreSQL wire protocol. Any other scheme is rejected unless a test
 * registered a driver for it; a failed native connection never falls back to another transport.
 * URI schemes are case-insensitive by RFC, so selection uses the same normalization as production config.
 */
export function postgres(dsn?: string): PostgresSqlApi {
  if (!dsn) {
    throw new Error(
      "A PostgreSQL database DSN is required for persistence. Set CORVIS_DATABASE_DSN.",
    );
  }
  if (NATIVE_POSTGRES_DSN.test(dsn)) {
    let client = nativeClients.get(dsn);
    if (!client) {
      client = new NativePostgresSqlApi(dsn);
      nativeClients.set(dsn, client);
    }
    return client;
  }
  const driver = additionalDrivers.find((candidate) => candidate.accepts(dsn));
  if (!driver) throw new Error("Unsupported PostgreSQL transport");
  return driver.connect(dsn);
}

/**
 * Provider-neutral runtime descriptor used by readiness checks and future
 * adapters. Moving between managed PostgreSQL providers should change only
 * configuration and provider-specific connection plumbing, not domain code.
 */
export function postgresRuntime(dsn: string, provider: DatabaseProvider = "unknown"): DatabaseRuntime {
  const api = postgres(dsn);
  return {
    api,
    provider,
    capabilities: {
      ...POSTGRES_BASELINE_CAPABILITIES,
      nativeTransactions: Boolean(api.transaction),
      // Only a transport with real sessions (the native client) can hold session-scoped
      // PostgreSQL features such as advisory locks.
      advisoryLocks: Boolean(api.transaction),
      logicalReplication: NATIVE_POSTGRES_DSN.test(dsn),
    },
  };
}
