import {
  POSTGRES_BASELINE_CAPABILITIES,
  withOptionalTransaction,
  type DatabaseApi,
  type DatabasePrimitive,
  type DatabaseProvider,
  type DatabaseRow,
  type DatabaseRuntime,
} from "./database.ts";
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
export const withTransaction = withOptionalTransaction;

type QueryResult = { rows?: PostgresRow[] };

type PostgresClientOptions = {
  dsn: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Minimal HTTP SQL adapter retained for non-production compatibility.
 *
 * Product/domain modules must depend on their own repository ports rather than
 * this shared transport primitive. Provider SDK semantics must not leak through
 * this interface.
 */
export class PostgresHttpSqlApi implements PostgresSqlApi {
  private readonly dsn: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: PostgresClientOptions) {
    this.dsn = options.dsn;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    const result = await this.request(sql, parameters);
    return result.rows ?? [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    await this.request(sql, parameters);
  }

  async health(): Promise<boolean> {
    try {
      await this.query("select 1 as ok");
      return true;
    } catch {
      return false;
    }
  }

  private async request(sql: string, parameters: PostgresPrimitive[]): Promise<QueryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.dsn, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql, parameters }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Postgres SQL request failed with status ${response.status}`);
      }
      const payload = (await response.json()) as QueryResult;
      if (!payload || !Array.isArray(payload.rows)) return { rows: [] };
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const nativeClients = new Map<string, NativePostgresSqlApi>();

/** Native provider DSNs use the PostgreSQL wire protocol; explicit HTTPS SQL
 * gateway bindings remain supported for compatibility and are never inferred
 * from a failed native connection.
 */
export function postgres(dsn?: string): PostgresSqlApi {
  if (!dsn) {
    throw new Error(
      "A PostgreSQL database DSN is required for persistence. Set CORVIS_DATABASE_DSN (preferred); CORVIS_POSTGRES_DSN is required only for the legacy binding.",
    );
  }
  if (/^postgres(?:ql)?:\/\//.test(dsn)) {
    let client = nativeClients.get(dsn);
    if (!client) {
      client = new NativePostgresSqlApi(dsn);
      nativeClients.set(dsn, client);
    }
    return client;
  }
  if (!dsn.startsWith("https://")) throw new Error("Unsupported PostgreSQL transport");
  return new PostgresHttpSqlApi({ dsn });
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
      // The legacy HTTPS SQL compatibility transport cannot safely advertise
      // session-scoped PostgreSQL features even if the backend is PostgreSQL.
      advisoryLocks: Boolean(api.transaction),
      logicalReplication: /^postgres(?:ql)?:\/\//.test(dsn),
    },
  };
}
