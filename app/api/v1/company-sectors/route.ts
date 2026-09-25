import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { isSectorCode, type CompanySectorAssignment } from "@/core/sector-taxonomy";
import { runAuditedMutation } from "@/lib/server/audited-mutation";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { companySectors, PostgresCompanySectorRepository } from "@/lib/server/company-sectors";
import { apiError, correlationId, json } from "@/lib/server/http";
import { withIdempotency } from "@/lib/server/idempotency";

/** Versions are Postgres `integer` columns; anything above 2^31-1 is malformed input, not a conflict. */
const MAX_VERSION = 2_147_483_647;
const MAX_REASON_LENGTH = 1000;

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return json({ data: await companySectors().list(identity), nextCursor: null, correlationId: id });
  } catch (error) { return apiError(error, id); }
}

/**
 * Classify (or reclassify) one entitled portfolio company. A Review Analyst
 * command: governed, audited in the same transaction, idempotent, and
 * optimistic on the company's current classification version.
 */
export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const body = await request.json().catch(() => null) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_company_sector_assignment", correlationId: id }, { status: 400 });
    }
    const input = body as Partial<CompanySectorAssignment> & { idempotencyKey?: unknown };
    if (
      typeof input.companyId !== "string" || !input.companyId.trim() ||
      !isSectorCode(input.sectorCode) ||
      !Number.isInteger(input.expectedVersion) || (input.expectedVersion as number) < 0 || (input.expectedVersion as number) > MAX_VERSION ||
      typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > MAX_REASON_LENGTH ||
      (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== "string")
    ) {
      return json({ error: "invalid_company_sector_assignment", correlationId: id }, { status: 400 });
    }
    const command: CompanySectorAssignment = {
      companyId: input.companyId,
      sectorCode: input.sectorCode,
      expectedVersion: input.expectedVersion as number,
      reason: input.reason.trim(),
    };
    const clientKey = (input.idempotencyKey as string | undefined) || request.headers.get("idempotency-key") || undefined;
    const { status, body: data } = await withIdempotency(identity, "company_sectors.assign", clientKey, async () => {
      const outcome = await runAuditedMutation({
        mutate: (db) => db ? new PostgresCompanySectorRepository(db).assign(identity, command, db) : companySectors().assign(identity, command),
        audit: (result) => ({
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          tenantId: identity.tenantId,
          workspaceId: identity.workspaceId,
          actorSubject: identity.subject,
          sessionId: identity.sessionId,
          action: "company_sector.assign",
          targetType: "company",
          targetId: command.companyId,
          outcome: "success",
          correlationId: id,
          metadata: { sectorCode: command.sectorCode, expectedVersion: command.expectedVersion, newVersion: result.newVersion, reason: command.reason },
        }),
      });
      return { status: 200, body: outcome };
    });
    return json({ data, correlationId: id }, { status });
  } catch (error) { return apiError(error, id); }
}
