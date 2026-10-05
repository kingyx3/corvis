import { registerDatabaseDriver, type PostgresPrimitive, type PostgresRow, type PostgresSqlApi } from "../platform/database/postgres.ts";

// Importing this module lets `postgres("https://…")` return an in-process double whose requests go through
// the global `fetch`, which the importing test replaces. Nothing outside tests may import it.

type QueryResult = { rows: PostgresRow[] };

type PostgresClientOptions = {
  dsn: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Test double: speaks "SQL over HTTP" to a fetch the test controls, so route and service tests can
 * observe every statement without a database. It has no transactions, so it is never a production transport.
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
    return result.rows;
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
      const payload = (await response.json()) as Partial<QueryResult> | null;
      if (!payload || !Array.isArray(payload.rows)) return { rows: [] };
      return { rows: payload.rows };
    } finally {
      clearTimeout(timeout);
    }
  }
}

registerDatabaseDriver({
  accepts: (dsn) => /^https:\/\//i.test(dsn),
  connect: (dsn) => new PostgresHttpSqlApi({ dsn }),
});
