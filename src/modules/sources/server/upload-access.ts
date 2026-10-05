import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";

/**
 * Who may read, complete, abort or fetch the resumable URL of an upload
 * session: the uploader; a tenant administrator; or a caller holding the
 * application `admin` role *in the workspace the upload was made from* (#238).
 * An `accountadmin` of one workspace maps to the application `admin` role too,
 * so without the workspace check it could act on uploads made in workspaces it
 * is not entitled to. Sessions created before the workspace was recorded carry
 * no `workspaceId`; only the uploader or a tenant administrator may act on them.
 * Tenant scoping is enforced separately when the session is loaded
 * (`session.tenantId === identity.tenantId`).
 *
 * This is the single definition of the rule; the status/abort route, the
 * completion route and `UploadService.assertUploader` all call it.
 */
export function canAccessUpload(
  identity: Pick<RequestIdentity, "subject" | "roles" | "workspaceId" | "isTenantAdmin">,
  session: { actorSubject: string; workspaceId?: string },
): boolean {
  if (session.actorSubject === identity.subject) return true;
  if (identity.isTenantAdmin === true) return true;
  return identity.roles.includes("admin") && session.workspaceId !== undefined && session.workspaceId === identity.workspaceId;
}
