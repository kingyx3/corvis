import { NativePostgresSqlApi } from "./postgres-native.ts";

export type PostgresPrimitive = string | number | boolean | null;
export type PostgresRow = Record<string, unknown>;

export interface PostgresSqlApi {
  query(sql: string, parameters?: PostgresPrimitive[]): Promise<PostgresRow[]>;
  execute(sql: string, parameters?: PostgresPrimitive[]): Promise<void>;
  health(): Promise<boolean>;
  /**
   * Runs `fn` against a single connection wrapped in `begin`/`commit`: every
   * query or execute the callback issues through the `tx` handle it receives
   * runs on that one connection, so they all commit together, and any error
   * the callback throws (or that one of those queries throws) rolls the
   * whole transaction back before the error propagates. The connection is
   * always released back to the pool afterwards, success or failure.
   *
   * Optional: the stateless HTTP transport (`PostgresHttpSqlApi`) has no
   * single connection to hold a transaction open on, so it does not implement
   * this. Route code should go through `withTransaction` below rather than
   * calling `db.transaction` directly, so it degrades safely on a transport
   * that lacks it instead of throwing.
   */
  transaction?<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T>;
}

/**
 * Runs `fn` inside `db.transaction` when the underlying transport supports
 * one (the native Postgres client does), so a mutation and its audit-event
 * insert commit or roll back together. Falls back to calling `fn(db)`
 * directly when the transport has no `transaction` method, so callers never
 * have to special-case the transport themselves.
 */
export function withTransaction<T>(db: PostgresSqlApi, fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
  return db.transaction ? db.transaction(fn) : fn(db);
}

type QueryResult = { rows?: PostgresRow[] };

type PostgresClientOptions = {
  dsn: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Minimal provider adapter for Supabase/Postgres HTTP SQL execution.
 *
 * Product/domain modules must depend on their own repository ports rather than
 * this client. This adapter exists only as a shared transport primitive while
 * legacy Snowflake persistence is migrated one bounded module at a time.
 * Keep runtime syntax erasable because Node 24 executes these TypeScript tests directly.
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

/** Native provider DSNs use the Postgres wire protocol; legacy HTTPS gateways
 * remain supported explicitly, never inferred from a failed native connection.
 */
export function postgres(dsn?: string): PostgresSqlApi {
  if (!dsn) throw new Error("CORVIS_POSTGRES_DSN is required for Postgres persistence");
  if (/^postgres(?:ql)?:\/\//.test(dsn)) {
    let client = nativeClients.get(dsn);
    if (!client) {
      client = new NativePostgresSqlApi(dsn);
      nativeClients.set(dsn, client);
    }
    return client;
  }
  if (!dsn.startsWith("https://")) throw new Error("Unsupported Postgres transport");
  return new PostgresHttpSqlApi({ dsn });
}
