import { getServerConfig } from "@/platform/config/config";
import { readJsonObject, resolveAdminRequestIdentity } from "@/modules/identity-access/server/request/admin-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { postgres } from "@/platform/database/postgres";
import { assertOperationsTenant } from "@/modules/identity-access/server/tenants/tenant-provisioning";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_TYPES = new Set(["fund", "document"]);
const RIGHT_RESOURCE_TYPES = new Set(["workspace", "fund", "document"]);
const PERMISSIONS = new Set(["read", "review", "publish", "admin"]);

function timestamp(value: unknown, fallback?: string): string | undefined {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function requiredString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function boolean(value: unknown, fallback = false): boolean | undefined {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : undefined;
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAdminRequestIdentity(request);
    const body = await readJsonObject(request) as Record<string, unknown> | undefined;
    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const kind = body.kind;
    const reason = requiredString(body.reason, 1000);
    if (!reason) return json({ error: "invalid_request", correlationId: id }, { status: 400 });

    const config = getServerConfig();
    const db = postgres(config.databaseDsn);
    if (kind === "resource_entitlement") {
      const operation = body.operation === "grant" || body.operation === "revoke" ? body.operation : undefined;
      const subjectUserId = requiredString(body.subjectUserId, 64);
      const workspaceId = requiredString(body.workspaceId, 64);
      const resourceType = requiredString(body.resourceType, 32);
      const resourceId = requiredString(body.resourceId, 512);
      const permission = requiredString(body.permission, 32);
      const validFrom = timestamp(body.validFrom, new Date().toISOString());
      const validUntil = timestamp(body.validUntil);
      if (!operation || !subjectUserId || !workspaceId || !UUID.test(subjectUserId) || !UUID.test(workspaceId)
        || !resourceType || !RESOURCE_TYPES.has(resourceType) || !resourceId
        || !permission || !PERMISSIONS.has(permission) || !validFrom
        || (body.validUntil != null && body.validUntil !== "" && !validUntil)) {
        return json({ error: "invalid_request", correlationId: id }, { status: 400 });
      }
      const rows = await db.query(`select corvis_control.apply_resource_entitlement_admin(
        $1::uuid,$2,$3::uuid,$4,$5,$6::uuid,$7::uuid,$8,$9,$10,$11::timestamptz,$12::timestamptz,$13
      ) as result`, [identity.tenantId, identity.subject, identity.workspaceId, id, operation, subjectUserId, workspaceId,
        resourceType, resourceId, permission, validFrom, validUntil ?? null, reason]);
      return json({ data: rows[0]?.result ?? null, correlationId: id });
    }

    if (kind === "data_right") {
      // Contractual rights control licensed/provider-governed uses (including
      // redistribution and model training). They are not customer-admin
      // self-service: only the configured Corvis Operations tenant may mutate
      // them, and it must name the customer tenant whose rights are changing.
      assertOperationsTenant(identity, config);
      const operation = body.operation === "set" || body.operation === "revoke" ? body.operation : undefined;
      const targetTenantId = requiredString(body.tenantId, 64);
      const resourceType = requiredString(body.resourceType, 32);
      const resourceId = requiredString(body.resourceId, 512);
      const clientVisible = boolean(body.clientVisible, true);
      const internalAnalyticsAllowed = boolean(body.internalAnalyticsAllowed);
      const modelTrainingAllowed = boolean(body.modelTrainingAllowed);
      const redistributionAllowed = boolean(body.redistributionAllowed);
      const sourceDocumentAccessAllowed = boolean(body.sourceDocumentAccessAllowed);
      const effectiveFrom = timestamp(body.effectiveFrom, new Date().toISOString());
      const effectiveTo = timestamp(body.effectiveTo);
      const contractReference = typeof body.contractReference === "string" ? body.contractReference.trim().slice(0, 1000) : "";
      if (!operation || !targetTenantId || !UUID.test(targetTenantId)
        || !resourceType || !RIGHT_RESOURCE_TYPES.has(resourceType) || !resourceId || !effectiveFrom
        || clientVisible === undefined || internalAnalyticsAllowed === undefined || modelTrainingAllowed === undefined
        || redistributionAllowed === undefined || sourceDocumentAccessAllowed === undefined
        || (operation === "set" && !contractReference)
        || (body.effectiveTo != null && body.effectiveTo !== "" && !effectiveTo)) {
        return json({ error: "invalid_request", correlationId: id }, { status: 400 });
      }
      const rows = await db.query(`select corvis_control.apply_data_right_admin_authorized(
        $1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15::timestamptz,$16,$17
      ) as result`, [targetTenantId, identity.tenantId, identity.subject, identity.workspaceId, id, operation, resourceType, resourceId,
        clientVisible, internalAnalyticsAllowed, modelTrainingAllowed, redistributionAllowed, sourceDocumentAccessAllowed,
        effectiveFrom, effectiveTo ?? null, contractReference, reason]);
      return json({ data: rows[0]?.result ?? null, correlationId: id });
    }

    return json({ error: "invalid_request", correlationId: id }, { status: 400 });
  } catch (error) {
    return apiError(error, id);
  }
}
