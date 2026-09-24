import test from "node:test";
import assert from "node:assert/strict";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { AuthorizationError } from "../../core/enterprise.ts";
import { assertTenantAdminRequestScope, isTenantAdminOnlyPath } from "./authorized-request.ts";

const identity = (isTenantAdmin: boolean): RequestIdentity => ({
  subject: "idp|admin",
  tenantId: "11111111-1111-1111-1111-111111111111",
  workspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  roles: ["admin"],
  entitlements: { workspaceIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], sourceDocumentAccessAllowed: false },
  authMethod: "oidc",
  sessionId: "session-1",
  isTenantAdmin,
});

test("all admin route families and tenant-scoped processing recovery commands require tenant_admin", () => {
  for (const path of [
    "/api/v1/admin/audit",
    "/api/v1/admin/feature-flags",
    "/api/v1/admin/webhooks/subscriptions/abc",
    "/api/v1/jobs/job-1/retry",
    "/api/v1/jobs/job-1/recover",
  ]) {
    assert.equal(isTenantAdminOnlyPath(path), true, path);
    assert.throws(
      () => assertTenantAdminRequestScope(new Request(`https://corvis.example${path}`), identity(false)),
      (error: unknown) => error instanceof AuthorizationError && error.requiredPermission === "admin:tenant_manage",
    );
    assert.doesNotThrow(() => assertTenantAdminRequestScope(new Request(`https://corvis.example${path}`), identity(true)));
  }
});

test("workspace/product routes do not accidentally become tenant-admin-only", () => {
  for (const path of [
    "/api/v1/documents",
    "/api/v1/review",
    "/api/v1/source-connections",
    "/api/v1/snapshots/publish",
  ]) {
    assert.equal(isTenantAdminOnlyPath(path), false, path);
    assert.doesNotThrow(() => assertTenantAdminRequestScope(new Request(`https://corvis.example${path}`), identity(false)));
  }
});
