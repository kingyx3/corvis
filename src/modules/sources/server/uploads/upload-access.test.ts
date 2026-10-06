import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { canAccessUpload } from "./upload-access.ts";

const session = { actorSubject: "u1", workspaceId: "w1" };
type Role = RequestIdentity["roles"][number];
const caller = (subject: string, roles: Role[], extra: { workspaceId?: string; isTenantAdmin?: boolean } = {}) => ({ subject, roles, workspaceId: extra.workspaceId ?? "w1", isTenantAdmin: extra.isTenantAdmin });

test("the uploader can access their own upload whatever their roles", () => {
  assert.equal(canAccessUpload(caller("u1", ["reviewer"]), session), true);
  assert.equal(canAccessUpload(caller("u1", [], { workspaceId: "w2" }), session), true);
});

test("another non-admin caller cannot access an upload", () => {
  for (const roles of [["reviewer"], ["analyst"], ["read_only"], ["api_client"], []] as Role[][]) {
    assert.equal(canAccessUpload(caller("u2", roles), session), false, roles.join(","));
  }
});

test("an admin can access another user's upload only in the workspace it was made from (#238)", () => {
  assert.equal(canAccessUpload(caller("u2", ["reviewer", "admin"]), session), true);
  assert.equal(canAccessUpload(caller("u2", ["admin"], { workspaceId: "w2" }), session), false, "an admin of another workspace");
  assert.equal(canAccessUpload(caller("u2", ["admin"]), { actorSubject: "u1" }), false, "a legacy session without a recorded workspace");
});

test("a tenant administrator can access any upload in the tenant", () => {
  assert.equal(canAccessUpload(caller("u2", ["admin"], { workspaceId: "w2", isTenantAdmin: true }), session), true);
  assert.equal(canAccessUpload(caller("u2", [], { isTenantAdmin: true }), { actorSubject: "u1" }), true);
});

test("subjects are compared exactly, not by prefix or case", () => {
  assert.equal(canAccessUpload(caller("U1", ["reviewer"]), session), false);
  assert.equal(canAccessUpload(caller("u", ["reviewer"]), session), false);
  assert.equal(canAccessUpload(caller("", ["reviewer"]), session), false);
});
