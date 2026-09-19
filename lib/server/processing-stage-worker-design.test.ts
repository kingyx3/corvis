import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("stage worker documentation requires downstream idempotency on crash recovery", async () => {
  const doc = (await readFile("docs/STAGE_WORKER_IDEMPOTENCY.md", "utf8")).toLowerCase();
  assert.match(doc, /same key is reused for every redelivery/);
  assert.match(doc, /crashes after a downstream write/);
  assert.match(doc, /identical idempotency key/);
  assert.match(doc, /must not create a second logical side effect/);
  assert.match(doc, /service_account/);
  assert.match(doc, /document entitlement/);
});
