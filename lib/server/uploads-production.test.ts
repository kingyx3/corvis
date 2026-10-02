import assert from "node:assert/strict";
import test from "node:test";
import { ProductionUploadSessions, uploads } from "./uploads.ts";

// The session store is chosen once per process, so this file owns the non-demo choice.
delete process.env.CORVIS_DEMO_MODE;
process.env.CORVIS_OBJECT_STORE_BUCKET = "corvis-source-test";
process.env.CORVIS_POSTGRES_DSN = "postgres://user:secret@127.0.0.1:5432/corvis";

test("outside demo mode the object-store and Postgres backed sessions are shared", () => {
  const first = uploads();
  assert.ok(first instanceof ProductionUploadSessions);
  assert.equal(uploads(), first);
});
