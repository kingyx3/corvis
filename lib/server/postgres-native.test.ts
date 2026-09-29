import assert from "node:assert/strict";
import test from "node:test";
import { nativePostgresConfig, NativePostgresSqlApi, PostgresDriverError, postgresCaCertificates, postgresDiagnosticCode, postgresPoolMax } from "./postgres-native.ts";
import { postgres } from "./postgres.ts";

test("provider URLs always verify TLS even when sslmode=require is supplied", () => {
  for (const suffix of ["", "?sslmode=require", "?sslmode=verify-full"]) {
    const config = nativePostgresConfig(`postgresql://user:dummy@database.example.test/db${suffix}`, true);
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.equal(new URL(config.connectionString!).search, "");
    assert.equal(config.max, 5);
  }
});

test("the pool size defaults to 5 and CORVIS_POSTGRES_POOL_MAX tunes it within 1-50 (#229)", () => {
  assert.equal(postgresPoolMax(undefined), 5);
  assert.equal(postgresPoolMax("12"), 12);
  for (const invalid of ["0", "51", "2.5", "lots", ""]) assert.equal(postgresPoolMax(invalid), 5, invalid);
});

test("a driver error keeps Postgres's numeric position but never its message", () => {
  const error = new PostgresDriverError("query", "42P01", undefined, 17);
  assert.equal(error.position, 17);
  assert.equal(error.message, "Postgres query failed (SQLSTATE 42P01)");
  assert.equal(new PostgresDriverError("query", "42P01").position, undefined);
});

test("the pool bounds statements, queries and idle-in-transaction sessions", () => {
  const config = nativePostgresConfig("postgresql://user:dummy@database.example.test/db", true);
  assert.equal(config.statement_timeout, 30_000);
  assert.equal(config.idle_in_transaction_session_timeout, 60_000);
  assert.ok(config.query_timeout! > config.statement_timeout!, "the client-side timeout must outlast the server-side one");
});

test("TLS downgrades and connection-string option overrides are rejected", () => {
  for (const option of ["sslmode=disable", "sslmode=no-verify", "sslmode=prefer", "sslrootcert=/secret", "host=localhost", "options=-c%20statement_timeout=0"]) {
    assert.throws(() => nativePostgresConfig(`postgres://user:dummy@database.example.test/db?${option}`, true));
  }
  assert.throws(() => nativePostgresConfig("not a URL"));
  assert.throws(() => nativePostgresConfig("https://example.test/db"));
});

test("plaintext is limited to non-production loopback", () => {
  assert.equal(nativePostgresConfig("postgres://localhost/db?sslmode=disable", false).ssl, false);
  assert.throws(() => nativePostgresConfig("postgres://localhost/db?sslmode=disable", true));
  assert.deepEqual(nativePostgresConfig("postgres://localhost/db", true).ssl, { rejectUnauthorized: true });
});

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ29ydmlzVGVzdA==\n-----END CERTIFICATE-----";

test("an optional provider CA narrows trust but never disables verification", () => {
  const config = nativePostgresConfig("postgresql://user:dummy@db.example.supabase.co:5432/postgres?sslmode=require", true, `${PEM}\n${PEM}`);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: [`${PEM}\n`, `${PEM}\n`] });
  // Single-line configuration stores may carry escaped newlines.
  const escaped = nativePostgresConfig("postgresql://user:dummy@db.example.test/db", true, PEM.replace(/\n/g, "\\n"));
  assert.deepEqual(escaped.ssl, { rejectUnauthorized: true, ca: [`${PEM}\n`] });
  assert.deepEqual(nativePostgresConfig("postgresql://user:dummy@db.example.test/db", true, "  ").ssl, { rejectUnauthorized: true });
  assert.throws(() => nativePostgresConfig("postgresql://user:dummy@db.example.test/db", true, "/etc/ssl/ca.pem"), /PEM/);
  assert.equal(postgresCaCertificates(undefined), undefined);
  // A CA never re-enables plaintext in production.
  assert.throws(() => nativePostgresConfig("postgres://localhost/db?sslmode=disable", true, PEM));
});

test("driver errors surface only a closed diagnostic code, never the message, DSN or SQL", () => {
  assert.equal(postgresDiagnosticCode({ code: "42P01", message: "relation \"secret\" does not exist" }), "42P01");
  assert.equal(postgresDiagnosticCode({ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self-signed certificate in certificate chain" }), "SELF_SIGNED_CERT_IN_CHAIN");
  assert.equal(postgresDiagnosticCode({ code: "ECONNREFUSED" }), "ECONNREFUSED");
  assert.equal(postgresDiagnosticCode(new Error("timeout exceeded when trying to connect")), "CONNECT_TIMEOUT");
  assert.equal(postgresDiagnosticCode({ code: "postgres://user:password@host/db" }), "UNKNOWN");
  assert.equal(postgresDiagnosticCode(new Error("password=hunter2")), "UNKNOWN");
  const query = new PostgresDriverError("query", "42601");
  assert.equal(query.message, "Postgres query failed (SQLSTATE 42601)");
  assert.equal(query.code, "42601");
  assert.equal(new PostgresDriverError("connection", "ECONNREFUSED").message, "Postgres connection failed (ECONNREFUSED)");
});

test("connection failures report the Node error code without leaking the DSN", async () => {
  const api = new NativePostgresSqlApi("postgres://corvis:dsn-secret-value@127.0.0.1:1/db?sslmode=disable");
  try {
    await assert.rejects(api.query("select 1"), (error: unknown) => {
      assert.ok(error instanceof PostgresDriverError);
      assert.equal(error.phase, "connection");
      assert.equal(error.code, "ECONNREFUSED");
      assert.equal(error.message.includes("dsn-secret-value"), false);
      return true;
    });
  } finally {
    await api.close();
  }
});

// transaction()'s commit/rollback behavior needs a real Postgres connection
// to verify, and `npm test` (the "frontend" CI job) has no Postgres service
// available -- only the "rate-limit-postgres" job does. That coverage lives
// in db/postgres/tests/native-adapter.mjs instead (see "transaction()
// commits a mutation..." there), which that job already runs against a live
// database, the same place this codebase's other live-connection checks
// (its own commit/rollback/concurrency assertions) already live.

test("native clients are shared across repository factories", () => {
  const dsn = "postgres://user:dummy@database.example.test/db";
  const first = postgres(dsn);
  assert.ok(first instanceof NativePostgresSqlApi);
  assert.equal(first, postgres(dsn));
  assert.throws(() => postgres("http://example.test/sql"));
});

test("transaction-pooler mode sends no timeout startup parameters and applies them with SET LOCAL instead (#229)", async () => {
  const { postgresPoolerMode, transactionLocalSettings } = await import("./postgres-native.ts");
  assert.equal(postgresPoolerMode(undefined), "session");
  assert.equal(postgresPoolerMode("Transaction"), "transaction");
  const session = nativePostgresConfig("postgresql://user:dummy@database.example.test/db", true, undefined, "session");
  assert.equal(session.statement_timeout, 30_000);
  const pooled = nativePostgresConfig("postgresql://user:dummy@database.example.test/db", true, undefined, "transaction");
  assert.equal(pooled.statement_timeout, undefined);
  assert.equal(pooled.idle_in_transaction_session_timeout, undefined);
  assert.ok(pooled.query_timeout! > 30_000, "the client-side bound still applies");
  assert.equal(transactionLocalSettings(), "set local statement_timeout = 30000; set local idle_in_transaction_session_timeout = 60000");
  assert.equal(transactionLocalSettings({ statement_timeout: 900_000, lock_timeout: 30_000 }), "set local statement_timeout = 900000; set local lock_timeout = 30000; set local idle_in_transaction_session_timeout = 60000");
});
