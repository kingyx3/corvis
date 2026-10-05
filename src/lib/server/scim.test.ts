import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { listScimUsers, type ScimConfiguration } from "./scim.ts";

const config: ScimConfiguration = {
  tenantId: "00000000-0000-0000-0000-000000000010",
  authMethod: "oidc",
  defaultWorkspaceId: "00000000-0000-0000-0000-000000000020",
  defaultRoleName: "viewer",
};

class FakeDb implements PostgresSqlApi {
  calls: Array<{ sql: string; parameters: PostgresPrimitive[] }> = [];
  queryQueue: PostgresRow[][] = [];
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    return this.queryQueue.shift() ?? [];
  }
  async execute(): Promise<void> {}
  async health(): Promise<boolean> { return true; }
}

test("listScimUsers reports the true total across pages, not just the page size", async () => {
  const db = new FakeDb();
  db.queryQueue = [
    [{ count: 350 }],
    [{ scim_user_id: "u-1", external_id: "ext-1", user_name: "a@example.com", active: true }],
  ];
  const page = await listScimUsers(config, "https://x/scim/v2/Users", null, db, 1, 200);
  assert.equal(page.totalResults, 350);
  assert.equal(page.startIndex, 1);
  assert.equal(page.resources.length, 1);
});

test("listScimUsers honors startIndex/count and caps the page size", async () => {
  const db = new FakeDb();
  db.queryQueue = [[{ count: 350 }], []];
  await listScimUsers(config, "https://x/scim/v2/Users", null, db, 201, 10_000);
  const pageCall = db.calls[1]!;
  assert.match(pageCall.sql, /limit \$\d+::int offset \$\d+::int/);
  assert.equal(pageCall.parameters.at(-2), "200", "count must be capped at the max SCIM page size");
  assert.equal(pageCall.parameters.at(-1), "200", "offset must be startIndex-1");
});

test("listScimUsers falls back to startIndex 1 for an invalid startIndex", async () => {
  const db = new FakeDb();
  db.queryQueue = [[{ count: 1 }], []];
  const page = await listScimUsers(config, "https://x/scim/v2/Users", null, db, Number.NaN, 50);
  assert.equal(page.startIndex, 1);
});

test("listScimUsers matches userName filters case-insensitively against the lower-cased stored value", async () => {
  const db = new FakeDb();
  db.queryQueue = [[{ count: 1 }], []];
  await listScimUsers(config, "https://x/scim/v2/Users", 'userName eq "  New.User@Example.COM "', db);
  assert.match(db.calls[0]!.sql, /user_name=\$2/);
  assert.equal(db.calls[0]!.parameters[1], "new.user@example.com");
  // externalId is an opaque identifier and keeps its case.
  const other = new FakeDb();
  other.queryQueue = [[{ count: 0 }], []];
  await listScimUsers(config, "https://x/scim/v2/Users", 'externalId eq "Ext-ABC"', other);
  assert.equal(other.calls[0]!.parameters[1], "Ext-ABC");
});

test("listScimUsers clamps an out-of-range startIndex so the int offset cannot overflow", async () => {
  const db = new FakeDb();
  db.queryQueue = [[{ count: 3 }], []];
  const page = await listScimUsers(config, "https://x/scim/v2/Users", null, db, 9_999_999_999_999, 10);
  assert.equal(page.startIndex, 2147483647);
  assert.deepEqual(page.resources, []);
  assert.equal(page.totalResults, 3);
  const offset = Number(db.calls[1]!.parameters.at(-1));
  assert.ok(Number.isSafeInteger(offset) && offset <= 2147483647, "offset must fit in int4");
});
