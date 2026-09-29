import assert from "node:assert/strict";
import test from "node:test";
import { canAccessUpload } from "./upload-access.ts";

test("the uploader can access their own upload whatever their roles", () => {
  assert.equal(canAccessUpload({ subject: "u1", roles: ["reviewer"] }, "u1"), true);
  assert.equal(canAccessUpload({ subject: "u1", roles: [] }, "u1"), true);
});

test("another non-admin caller cannot access an upload", () => {
  for (const roles of [["reviewer"], ["analyst"], ["read_only"], ["api_client"], []] as const) {
    assert.equal(canAccessUpload({ subject: "u2", roles: [...roles] }, "u1"), false, roles.join(","));
  }
});

test("an admin role can access another user's upload (rule unchanged)", () => {
  assert.equal(canAccessUpload({ subject: "u2", roles: ["reviewer", "admin"] }, "u1"), true);
});

test("subjects are compared exactly, not by prefix or case", () => {
  assert.equal(canAccessUpload({ subject: "U1", roles: ["reviewer"] }, "u1"), false);
  assert.equal(canAccessUpload({ subject: "u", roles: ["reviewer"] }, "u1"), false);
  assert.equal(canAccessUpload({ subject: "", roles: ["reviewer"] }, "u1"), false);
});
