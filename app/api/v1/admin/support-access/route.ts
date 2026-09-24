import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { getServerConfig } from "@/lib/server/config";
import { readJsonObject } from "@/lib/server/admin-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { postgres } from "@/lib/server/postgres";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = new Set(["tenant_admin", "workspace_admin", "reviewer", "analyst", "viewer"]);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function iso(value: unknown, fallback?: string): string | undefined {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await readJsonObject(request) as Record<string, unknown> | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const operation = body.operation === "grant" || body.operation === "revoke" ? body.operation : undefined;
    const reason = text(body.reason, 1000);
    if (!operation || !reason) return json({ error: "invalid_request", correlationId: id }, { status: 400 });

    const supportGrantId = text(body.supportGrantId, 64);
    const db = postgres(getServerConfig().postgresDsn);
    if (operation === "revoke") {
      if (!supportGrantId || !UUID.test(supportGrantId)) {
        return json({ error: "invalid_request", correlationId: id }, { status: 400 });
      }
      const rows = await db.query(`select corvis_control.apply_support_access_admin(
        $1::uuid,$2,$3::uuid,$4,'revoke',$5::uuid,null,null,null,null,null,null,null,null,null,$6
      ) as result`, [identity.tenantId, identity.subject, identity.workspaceId, id, supportGrantId, reason]);
      return json({ data: rows[0]?.result ?? null, correlationId: id });
    }

    const authMethod = body.authMethod === "oidc" || body.authMethod === "saml" ? body.authMethod : undefined;
    const subject = text(body.subject, 1024);
    const userId = text(body.userId, 64);
    const workspaceId = text(body.workspaceId, 64);
    const roleName = text(body.roleName, 64);
    const purpose = text(body.purpose, 1000);
    const approvalReference = text(body.approvalReference, 1000);
    const validFrom = iso(body.validFrom, new Date().toISOString());
    const validUntil = iso(body.validUntil);
    if (!authMethod || !subject || !userId || !workspaceId || !UUID.test(userId) || !UUID.test(workspaceId)
      || !roleName || !ROLES.has(roleName) || !purpose || !approvalReference || !validFrom || !validUntil
      || Date.parse(validUntil) <= Date.parse(validFrom)) {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }
    // Separation of duties (also enforced in apply_support_access_admin, which
    // additionally refuses another subject mapped to the approver's user).
    if (subject === identity.subject) {
      return json({ error: "support_access_self_approval_denied", correlationId: id }, { status: 403 });
    }

    const requestedId = supportGrantId && UUID.test(supportGrantId) ? supportGrantId : null;
    const rows = await db.query(`select corvis_control.apply_support_access_admin(
      $1::uuid,$2,$3::uuid,$4,'grant',$5::uuid,$6,$7,$8::uuid,$9::uuid,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15
    ) as result`, [identity.tenantId, identity.subject, identity.workspaceId, id, requestedId, authMethod, subject, userId,
      workspaceId, roleName, purpose, approvalReference, validFrom, validUntil, reason]);
    return json({ data: rows[0]?.result ?? null, correlationId: id });
  } catch (error) {
    return apiError(error, id);
  }
}
