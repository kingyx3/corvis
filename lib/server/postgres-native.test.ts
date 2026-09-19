import assert from "node:assert/strict";
import test from "node:test";
import { nativePostgresConfig, NativePostgresSqlApi } from "./postgres-native.ts";
import { postgres } from "./postgres.ts";

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

test("native clients are shared across repository factories", () => {
  const dsn = "postgres://user:dummy@database.example.test/db";
  const first = postgres(dsn);
  assert.ok(first instanceof NativePostgresSqlApi);
  assert.equal(first, postgres(dsn));
  assert.throws(() => postgres("http://example.test/sql"));
});
