import type { RequestIdentity } from "../../core/enterprise.ts";

/**
 * Who may read, complete, abort or fetch the resumable URL of an upload
 * session: the uploader, or any caller holding the application `admin` role.
 * Tenant scoping is enforced separately when the session is loaded
 * (`session.tenantId === identity.tenantId`).
 *
 * This is the single definition of the rule; the status/abort route, the
 * completion route and `UploadService.assertUploader` all call it.
 *
 * TODO(product decision): the `admin` role here is the application role, which
 * an `accountadmin` of *any* workspace in the tenant also maps to, so such an
 * admin can act on uploads made in workspaces they are not entitled to. Whether
 * to narrow this to admins entitled to the upload's workspace (or to tenant
 * admins) is a product decision; behaviour is intentionally unchanged here.
 */
export function canAccessUpload(identity: Pick<RequestIdentity, "subject" | "roles">, uploaderSubject: string): boolean {
  return uploaderSubject === identity.subject || identity.roles.includes("admin");
}
