import assert from "node:assert/strict";
import test from "node:test";
import { PostgresHttpSqlApi } from "./postgres.ts";

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
