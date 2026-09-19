import { Pool, types, type PoolConfig } from "pg";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

/** No URL options may override verified TLS or load files from the container. */
export function nativePostgresConfig(dsn: string, production = process.env.NODE_ENV === "production"): PoolConfig {
  let url: URL;
  try { url = new URL(dsn); } catch { throw new Error("Invalid Postgres connection URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Expected a native Postgres connection URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  for (const key of url.searchParams.keys()) {
    if (key !== "sslmode") throw new Error("Unsupported Postgres connection URL option");
  }
  const mode = url.searchParams.get("sslmode");
  if (mode && !["require", "verify-full"].includes(mode) && !(mode === "disable" && local && !production)) {
    throw new Error("Postgres connections require verified TLS");
  }
  url.search = "";
  return {
    connectionString: url.toString(),
    ssl: local && !production && mode !== "require" && mode !== "verify-full" ? false : { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 300,
    statement_timeout: 30_000,
    query_timeout: 35_000,
    allowExitOnIdle: true,
    // Keep the existing SQL API's JSON timestamp contract across transports.
    types: { getTypeParser: (oid, format) => [1082, 1114, 1184].includes(oid)
      ? (value: string) => value : types.getTypeParser(oid, format) },
  };
}

export class NativePostgresSqlApi implements PostgresSqlApi {
  private readonly pool: Pool;
  constructor(dsn: string) {
    this.pool = new Pool(nativePostgresConfig(dsn));
    // An idle socket error must not crash the API process. The pool discards
    // that socket; subsequent requests reconnect under the bounded timeout.
    this.pool.on("error", () => {});
  }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    const client = await this.pool.connect().catch(() => { throw new Error("Postgres connection failed"); });
    try {
      const result = await client.query(sql, parameters);
      const results = Array.isArray(result) ? result : [result];
      client.release();
      return results.at(-1)?.rows ?? [];
    } catch {
      // A failed multi-statement migration can leave a transaction aborted.
      // Destroy that connection instead of returning it to the shared pool.
      client.release(true);
      // Driver errors can contain SQL values and provider credentials.
      throw new Error("Postgres query failed");
    }
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    await this.query(sql, parameters);
  }
  async health(): Promise<boolean> {
    try { await this.query("select 1 as ok"); return true; } catch { return false; }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
