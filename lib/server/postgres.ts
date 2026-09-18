export type PostgresPrimitive = string | number | boolean | null;
export type PostgresRow = Record<string, unknown>;

export interface PostgresSqlApi {
  query(sql: string, parameters?: PostgresPrimitive[]): Promise<PostgresRow[]>;
  execute(sql: string, parameters?: PostgresPrimitive[]): Promise<void>;
  health(): Promise<boolean>;
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

/** Compose this provider adapter from an explicit runtime binding. */
export function postgres(dsn?: string): PostgresSqlApi {
  if (!dsn) throw new Error("CORVIS_POSTGRES_DSN is required for Postgres persistence");
  return new PostgresHttpSqlApi({ dsn });
}
