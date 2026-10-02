import assert from "node:assert/strict";
import test from "node:test";
import { currentSupportScope, setSupportScope, subscribeSupportScope } from "./support-scope.ts";

test("the scope starts empty and is stable until it really changes", () => {
  const initial = currentSupportScope();
  assert.deepEqual(initial, {});
  setSupportScope({});
  assert.equal(currentSupportScope(), initial, "an unchanged scope keeps the same snapshot");
});

test("listeners hear about changes only, and stop after unsubscribing", () => {
  let notified = 0;
  const unsubscribe = subscribeSupportScope(() => { notified += 1; });
  setSupportScope({ tenantId: "t1", workspaceId: "w1" });
  assert.deepEqual(currentSupportScope(), { tenantId: "t1", workspaceId: "w1" });
  setSupportScope({ tenantId: "t1", workspaceId: "w1" });
  assert.equal(notified, 1);
  setSupportScope({ tenantId: "t1", workspaceId: "w2" });
  assert.equal(notified, 2);
  setSupportScope({ tenantId: "t2", workspaceId: "w2" });
  assert.equal(notified, 3);
  unsubscribe();
  setSupportScope({});
  assert.equal(notified, 3);
  assert.deepEqual(currentSupportScope(), { tenantId: undefined, workspaceId: undefined });
});

test("only the two ids are kept, whatever else the caller passes", () => {
  setSupportScope({ tenantId: "t9", workspaceId: "w9", subject: "someone@example.org" } as { tenantId: string; workspaceId: string });
  assert.deepEqual(currentSupportScope(), { tenantId: "t9", workspaceId: "w9" });
});
