import { Pool, types, type PoolConfig } from "pg";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { matchSqlApplicationError, type SqlApplicationError } from "./sql-application-errors.ts";

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
/**
 * `CORVIS_POSTGRES_POOLER=transaction` declares a transaction-mode pooler (PgBouncer, Supavisor
 * port 6543) in front of Postgres (#229). node-postgres sends `statement_timeout` and
 * `idle_in_transaction_session_timeout` as startup parameters, which such poolers may reject and
 * cannot pin to a server session, so in that mode they are applied with `SET LOCAL` at the start
 * of every transaction instead; single statements outside a transaction are then bounded by the
 * client-side `query_timeout` and by the role's own defaults (`alter role ... set statement_timeout`).
 */
export type PostgresPoolerMode = "session" | "transaction";
export function postgresPoolerMode(value: string | undefined = process.env.CORVIS_POSTGRES_POOLER): PostgresPoolerMode {
  return value?.trim().toLowerCase() === "transaction" ? "transaction" : "session";
}

export function nativePostgresConfig(
  dsn: string,
  production = process.env.NODE_ENV === "production",
  caCertificate: string | undefined = process.env.CORVIS_POSTGRES_CA_CERT,
  pooler: PostgresPoolerMode = postgresPoolerMode(),
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
    max: postgresPoolMax(process.env.CORVIS_POSTGRES_POOL_MAX),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 300,
    ...(pooler === "transaction" ? {} : { statement_timeout: 30_000 }),
    // A request that dies (or a handler that awaits something slow) between
    // `begin` and `commit` would otherwise pin a pooled connection, its row
    // locks and the shared 5-slot pool indefinitely. The server terminates
    // such a session after this idle period.
    ...(pooler === "transaction" ? {} : { idle_in_transaction_session_timeout: 60_000 }),
    query_timeout: 35_000,
    allowExitOnIdle: true,
    // Keep the existing SQL API's JSON timestamp contract across transports.
    types: { getTypeParser: (oid, format) => [1082, 1114, 1184].includes(oid)
      ? (value: string) => value : types.getTypeParser(oid, format) },
  };
}

/**
 * Per-instance pool size. Default 5; CORVIS_POSTGRES_POOL_MAX (1-50) tunes it against the
 * provider's connection limit, which must cover max instances x pool size for every service.
 */
export function postgresPoolMax(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : 5;
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
  /** Allowlisted business-outcome fragment from a SQL `RAISE`, when the message contained one. */
  readonly applicationError?: SqlApplicationError;
  /** 1-based character offset of the failing token in the submitted SQL, when Postgres reported one; a number, never text. */
  readonly position?: number;
  constructor(phase: "connection" | "query", code: string, applicationError?: SqlApplicationError, position?: number) {
    super(`Postgres ${phase} failed (${SQLSTATE.test(code) ? "SQLSTATE " : ""}${code})`);
    this.name = "PostgresDriverError";
    this.phase = phase;
    this.code = code;
    if (applicationError) this.applicationError = applicationError;
    if (position !== undefined) this.position = position;
  }
}

/** The `position` field of a node-postgres error, when it is a positive integer. */
function postgresErrorPosition(error: unknown): number | undefined {
  const raw = (error as { position?: unknown } | null)?.position;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

const TRANSIENT_POSTGRES_CODES = new Set(["CONNECT_TIMEOUT", "QUERY_TIMEOUT"]);

/**
 * A database that is unreachable, out of pool connections or timing out: a
 * transient, retryable condition rather than a defect in the request or code.
 * Callers map it to 503 + Retry-After instead of an opaque 500.
 */
export function isTransientPostgresError(error: unknown): error is PostgresDriverError {
  return error instanceof PostgresDriverError && (error.phase === "connection" || TRANSIENT_POSTGRES_CODES.has(error.code));
}

/** `SET LOCAL` statements carrying the server-side timeouts into one transaction (transaction-pooler mode). */
export function transactionLocalSettings(limits: Pick<PoolConfig, "statement_timeout" | "lock_timeout" | "idle_in_transaction_session_timeout"> = {}): string {
  const millis = (value: unknown, fallback?: number) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback);
  const settings: Array<[string, number | undefined]> = [
    ["statement_timeout", millis(limits.statement_timeout, 30_000)],
    ["lock_timeout", millis(limits.lock_timeout)],
    ["idle_in_transaction_session_timeout", millis(limits.idle_in_transaction_session_timeout, 60_000)],
  ];
  return settings.filter(([, value]) => value !== undefined).map(([name, value]) => `set local ${name} = ${value}`).join("; ");
}

export class NativePostgresSqlApi implements PostgresSqlApi {
  private readonly pool: Pool;
  private readonly transactionSettings: string | undefined;
  /** `limits` may only tune pool size and timeouts (the migration CLI); TLS and connection settings always come from the DSN policy. */
  constructor(dsn: string, limits: Pick<PoolConfig, "max" | "statement_timeout" | "lock_timeout" | "query_timeout" | "idle_in_transaction_session_timeout"> = {}, pooler: PostgresPoolerMode = postgresPoolerMode()) {
    // In transaction-pooler mode the server-side timeouts travel as SET LOCAL, never as startup parameters.
    const clientLimits = pooler === "transaction" ? { ...(limits.max !== undefined ? { max: limits.max } : {}), ...(limits.query_timeout !== undefined ? { query_timeout: limits.query_timeout } : {}) } : limits;
    this.pool = new Pool({ ...nativePostgresConfig(dsn, undefined, undefined, pooler), ...clientLimits });
    this.transactionSettings = pooler === "transaction" ? transactionLocalSettings(limits) : undefined;
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
      throw new PostgresDriverError("query", postgresDiagnosticCode(error), matchSqlApplicationError(error), postgresErrorPosition(error));
    }
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    await this.query(sql, parameters);
  }
  async health(): Promise<boolean> {
    try { await this.query("select 1 as ok"); return true; } catch { return false; }
  }
  async transaction<T>(fn: (tx: PostgresSqlApi) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch((error: unknown) => {
      throw new PostgresDriverError("connection", postgresDiagnosticCode(error));
    });
    const tx: PostgresSqlApi = {
      query: async (sql: string, parameters: PostgresPrimitive[] = []) => {
        try {
          const result = await client.query(sql, parameters);
          const results = Array.isArray(result) ? result : [result];
          return results.at(-1)?.rows ?? [];
        } catch (error) {
          throw new PostgresDriverError("query", postgresDiagnosticCode(error), matchSqlApplicationError(error), postgresErrorPosition(error));
        }
      },
      execute: async (sql: string, parameters: PostgresPrimitive[] = []) => { await tx.query(sql, parameters); },
      health: async () => true,
    };
    try {
      await client.query("begin");
      if (this.transactionSettings) await client.query(this.transactionSettings);
      const result = await fn(tx);
      await client.query("commit");
      client.release();
      return result;
    } catch (error) {
      // Roll back whatever the callback already did before releasing the
      // connection. A rollback attempt on an already-broken connection is
      // discarded (not surfaced): the original error is what callers need,
      // and the connection is destroyed either way so it never returns to
      // the pool half-transacted.
      try { await client.query("rollback"); } catch { /* connection is already unusable */ }
      client.release(true);
      throw error;
    }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
