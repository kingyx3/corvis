import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("stage worker enforces service identity and deterministic idempotency key before handler execution", async () => {
  const source = (await readFile("lib/server/processing-stage-worker.ts", "utf8")).toLowerCase();
  assert.match(source, /identity\.authmethod !== "service_account"/);
  assert.match(source, /identity\.tenantid !== delivery\.tenantid/);
  assert.match(source, /assertdocumentaccess\(identity, delivery\.documentid\)/);
  assert.match(source, /createhash\("sha256"\)/);
  assert.match(source, /delivery\.tenantid.*delivery\.jobid.*delivery\.expectedstage.*delivery\.documentid/);
  assert.match(source, /idempotencykey/);
  assert.match(source, /effects\.begin/);
  assert.match(source, /effects\.complete/);
  assert.match(source, /stages\.complete/);
  assert.match(source, /stages\.fail/);
});
