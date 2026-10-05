import assert from "node:assert/strict";
import test from "node:test";
import { latestRequestCorrelationId, recordRequestCorrelationId, recordResponseCorrelation, subscribeRequestCorrelation } from "./request-correlation.ts";

test("no request id is known before any response is recorded", () => {
  assert.equal(latestRequestCorrelationId(), undefined);
});

test("the most recent log-safe id wins and listeners are told only about real changes", () => {
  let notified = 0;
  const unsubscribe = subscribeRequestCorrelation(() => { notified += 1; });
  recordRequestCorrelationId("req-1");
  assert.equal(latestRequestCorrelationId(), "req-1");
  recordRequestCorrelationId("req-1");
  assert.equal(notified, 1, "recording the same id again is not a change");
  recordRequestCorrelationId("3f2a9c1e-77b0-4d52-9f6e-0c1d2e3f4a5b");
  assert.equal(latestRequestCorrelationId(), "3f2a9c1e-77b0-4d52-9f6e-0c1d2e3f4a5b");
  assert.equal(notified, 2);
  unsubscribe();
  recordRequestCorrelationId("req-after-unsubscribe");
  assert.equal(notified, 2, "an unsubscribed listener is never called again");
  assert.equal(latestRequestCorrelationId(), "req-after-unsubscribe");
});

test("values that are not log-safe tokens never replace the latest id", () => {
  recordRequestCorrelationId("req-safe");
  for (const bad of [undefined, null, 42, {}, "", "has space", "line\nbreak", "<script>", "a".repeat(129), "Fund Alpha, IRR 14.2%"]) recordRequestCorrelationId(bad);
  assert.equal(latestRequestCorrelationId(), "req-safe");
  recordRequestCorrelationId("a".repeat(128));
  assert.equal(latestRequestCorrelationId(), "a".repeat(128));
});

test("a response contributes its body correlationId, falling back to the x-correlation-id header", () => {
  const headers = new Headers({ "x-correlation-id": "from-header" });
  recordResponseCorrelation(headers, { data: [], correlationId: "from-body" });
  assert.equal(latestRequestCorrelationId(), "from-body");
  recordResponseCorrelation(headers, { data: [] });
  assert.equal(latestRequestCorrelationId(), "from-header");
  recordResponseCorrelation(new Headers({ "x-correlation-id": "second-header" }), null);
  assert.equal(latestRequestCorrelationId(), "second-header");
  recordResponseCorrelation(new Headers({ "x-correlation-id": "third-header" }), "not an object");
  assert.equal(latestRequestCorrelationId(), "third-header");
  recordResponseCorrelation(new Headers({ "x-correlation-id": "fourth-header" }));
  assert.equal(latestRequestCorrelationId(), "fourth-header");
  recordResponseCorrelation(new Headers(), { correlationId: 7 });
  assert.equal(latestRequestCorrelationId(), "fourth-header", "a malformed body id with no header changes nothing");
});
