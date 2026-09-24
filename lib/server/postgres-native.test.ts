import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { nativePostgresConfig, NativePostgresSqlApi, PostgresDriverError, postgresCaCertificates, postgresDiagnosticCode } from "./postgres-native.ts";
import { postgres } from "./postgres.ts";

const LOCAL_TEST_DSN = "postgres://postgres:ci-disposable-only@localhost:5432/postgres?sslmode=disable";

test("provider URLs always verify TLS even when sslmode=require is supplied", () => {
  for (const suffix of ["", "?sslmode=require", "?sslmode=verify-full"]) {
    const config = nativePostgresConfig(`postgresql://user:dummy@database.example.test/db${suffix}`, true);
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.equal(new URL(config.connectionString!).search, "");
    assert.equal(config.max, 5);
  }
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

test("transaction() commits a mutation and its audit insert together, and rolls back the mutation when the callback throws", async () => {
  const api = new NativePostgresSqlApi(LOCAL_TEST_DSN);
  const table = `txn_probe_${randomUUID().replace(/-/g, "_")}`;
  try {
    await api.execute(`create table ${table} (id text primary key, kind text not null)`);

    // The mutation and the "audit" write run on the same transaction and both commit.
    await api.transaction(async (tx) => {
      await tx.execute(`insert into ${table} (id, kind) values ($1, 'mutation')`, ["row-1"]);
      await tx.execute(`insert into ${table} (id, kind) values ($1, 'audit')`, ["row-1-audit"]);
    });
    const committed = await api.query(`select kind from ${table} order by kind`);
    assert.deepEqual(committed.map((row) => row.kind), ["audit", "mutation"]);

    // An error thrown after the mutation (standing in for a failing audit insert)
    // rolls the mutation back too: nothing from this attempt is visible afterward.
    await assert.rejects(
      api.transaction(async (tx) => {
        await tx.execute(`insert into ${table} (id, kind) values ($1, 'mutation')`, ["row-2"]);
        throw new Error("audit insert failed");
      }),
      /audit insert failed/,
    );
    const afterRollback = await api.query(`select id from ${table} where id=$1`, ["row-2"]);
    assert.deepEqual(afterRollback, []);
  } finally {
    await api.execute(`drop table if exists ${table}`).catch(() => {});
    await api.close();
  }
});

test("native clients are shared across repository factories", () => {
  const dsn = "postgres://user:dummy@database.example.test/db";
  const first = postgres(dsn);
  assert.ok(first instanceof NativePostgresSqlApi);
  assert.equal(first, postgres(dsn));
  assert.throws(() => postgres("http://example.test/sql"));
});
