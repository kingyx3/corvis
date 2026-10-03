import assert from "node:assert/strict";
import test from "node:test";
import { PostgresHttpSqlApi, postgres, postgresRuntime } from "./postgres.ts";

test("query sends parameterized SQL and returns rows", async () => {
  let request: RequestInit | undefined;
  const db = new PostgresHttpSqlApi({
    dsn: "https://postgres.example.test/sql",
    fetchImpl: (async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({ rows: [{ observation_id: "obs-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const rows = await db.query("select * from observation where tenant_id = $1", ["tenant-a"]);
  assert.deepEqual(rows, [{ observation_id: "obs-1" }]);
  assert.equal(request?.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.body)), {
    sql: "select * from observation where tenant_id = $1",
    parameters: ["tenant-a"],
  });
});

test("default fetch binding and empty provider payload normalize safely", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  try {
    const db = new PostgresHttpSqlApi({ dsn: "https://postgres.example.test/sql" });
    assert.deepEqual(await db.query("select 1"), []);
    await db.execute("select 1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-array or null provider rows normalize to an empty result", async () => {
  for (const payload of [null, { rows: null }]) {
    const db = new PostgresHttpSqlApi({
      dsn: "https://postgres.example.test/sql",
      fetchImpl: (async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    });
    assert.deepEqual(await db.query("select 1"), []);
  }
});

test("provider errors fail locally without retries", async () => {
  let calls = 0;
  const db = new PostgresHttpSqlApi({
    dsn: "https://postgres.example.test/sql",
    fetchImpl: (async () => {
      calls += 1;
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch,
  });

  await assert.rejects(() => db.query("select 1"), /status 503/);
  assert.equal(calls, 1);
});

test("health converts provider failure to scoped unhealthy state", async () => {
  const db = new PostgresHttpSqlApi({
    dsn: "https://postgres.example.test/sql",
    fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
  });

  assert.equal(await db.health(), false);
});

test("requests are cancelled after the configured timeout", async () => {
  const db = new PostgresHttpSqlApi({
    dsn: "https://postgres.example.test/sql",
    timeoutMs: 5,
    fetchImpl: ((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch,
  });

  await assert.rejects(() => db.query("select pg_sleep(10)"), (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError",
  );
});

test("database factory fails closed for missing and unsupported bindings", () => {
  assert.throws(
    () => postgres(),
    (error: unknown) => error instanceof Error
      && error.message.includes("CORVIS_DATABASE_DSN")
      && error.message.includes("CORVIS_POSTGRES_DSN"),
  );
  assert.throws(() => postgres("http://postgres.example.test/sql"), /Unsupported PostgreSQL transport/);
});

test("compatibility HTTP runtime advertises only capabilities it can safely provide", () => {
  const runtime = postgresRuntime("https://postgres.example.test/sql", "supabase");
  assert.equal(runtime.provider, "supabase");
  assert.ok(runtime.api instanceof PostgresHttpSqlApi);
  assert.equal(runtime.capabilities.nativeTransactions, false);
  assert.equal(runtime.capabilities.advisoryLocks, false);
  assert.equal(runtime.capabilities.logicalReplication, false);
});

test("native PostgreSQL runtime advertises transaction and PostgreSQL session capabilities", () => {
  const dsn = "postgresql://corvis:secret@localhost:5432/postgres?sslmode=disable";
  const runtime = postgresRuntime(dsn);
  const cachedRuntime = postgresRuntime(dsn, "gcp-cloud-sql");
  assert.equal(runtime.provider, "unknown");
  assert.equal(runtime.capabilities.nativeTransactions, true);
  assert.equal(runtime.capabilities.advisoryLocks, true);
  assert.equal(runtime.capabilities.logicalReplication, true);
  assert.equal(cachedRuntime.provider, "gcp-cloud-sql");
  assert.equal(cachedRuntime.api, runtime.api);
});