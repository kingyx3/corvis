import { Pool, types, type PoolConfig } from "pg";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Optional reviewed CA bundle for providers whose server certificates chain to
 * a private root that is not in Node's trust store (for example Supabase's
 * own root CA). The value is PEM text (one or more certificates); literal `\n`
 * escapes are accepted for single-line configuration stores. When set, the
 * bundle *replaces* the default trust store for Postgres connections only, and
 * certificate plus hostname verification remain mandatory.
 */
export function postgresCaCertificates(value: string | undefined): string[] | undefined {
  const normalized = (value ?? "").replace(/\\n/g, "\n").trim();
  if (!normalized) return undefined;
  const certificates = normalized.match(PEM_CERTIFICATE);
  if (!certificates?.length) throw new Error("CORVIS_POSTGRES_CA_CERT must contain PEM-encoded certificates");
  return certificates.map((certificate) => `${certificate}\n`);
}

/** No URL options may override verified TLS or load files from the container. */
export function nativePostgresConfig(
  dsn: string,
  production = process.env.NODE_ENV === "production",
  caCertificate: string | undefined = process.env.CORVIS_POSTGRES_CA_CERT,
): PoolConfig {
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
  const ca = postgresCaCertificates(caCertificate);
  const plaintext = local && !production && mode !== "require" && mode !== "verify-full";
  return {
    connectionString: url.toString(),
    // rejectUnauthorized is never configurable: a custom CA narrows trust, it
    // never disables verification.
    ssl: plaintext ? false : ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true },
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

const SQLSTATE = /^[0-9A-Z]{5}$/;
const NODE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * Driver errors can contain SQL values, row data and provider credentials, so
 * only a closed diagnostic code is surfaced: the Postgres SQLSTATE for server
 * errors, or the Node/OpenSSL error code (ECONNREFUSED,
 * SELF_SIGNED_CERT_IN_CHAIN, ...) for transport failures. The original
 * message, DSN and SQL are never included.
 */
export function postgresDiagnosticCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && (SQLSTATE.test(code) || NODE_ERROR_CODE.test(code))) return code;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      if (/timeout exceeded when trying to connect|connection timeout/i.test(message)) return "CONNECT_TIMEOUT";
      if (/query read timeout/i.test(message)) return "QUERY_TIMEOUT";
      if (/connection terminated/i.test(message)) return "CONNECTION_TERMINATED";
    }
  }
  return "UNKNOWN";
}

export class PostgresDriverError extends Error {
  readonly phase: "connection" | "query";
  /** SQLSTATE (e.g. 42P01) or Node error code (e.g. ECONNREFUSED); never free text. */
  readonly code: string;
  constructor(phase: "connection" | "query", code: string) {
    super(`Postgres ${phase} failed (${SQLSTATE.test(code) ? "SQLSTATE " : ""}${code})`);
    this.name = "PostgresDriverError";
    this.phase = phase;
    this.code = code;
  }
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
    const client = await this.pool.connect().catch((error: unknown) => {
      throw new PostgresDriverError("connection", postgresDiagnosticCode(error));
    });
    try {
      const result = await client.query(sql, parameters);
      const results = Array.isArray(result) ? result : [result];
      client.release();
      return results.at(-1)?.rows ?? [];
    } catch (error) {
      // A failed multi-statement migration can leave a transaction aborted.
      // Destroy that connection instead of returning it to the shared pool.
      client.release(true);
      throw new PostgresDriverError("query", postgresDiagnosticCode(error));
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
