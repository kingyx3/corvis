import { randomUUID } from "crypto";
import {
  assertPermission,
  type ReconciliationResolutionCommand,
  type ReconciliationResolutionAction,
} from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { withIdempotency } from "@/lib/server/idempotency";
import { platform } from "@/lib/server/platform";

const actions: ReconciliationResolutionAction[] = ["select_source", "mark_immaterial", "accept_reconciliation"];
/** Versions are Postgres `integer` columns; anything above 2^31-1 is malformed input, not a conflict. */
const MAX_VERSION = 2_147_483_647;

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_reconciliation_resolution", correlationId: id }, { status: 400 });
    }
    const command = body as ReconciliationResolutionCommand & { idempotencyKey?: string };
    if (
      typeof command.exceptionId !== "string" || !command.exceptionId ||
      !Number.isInteger(command.expectedVersion) || command.expectedVersion <= 0 || command.expectedVersion > MAX_VERSION ||
      !actions.includes(command.action) ||
      typeof command.reasonCode !== "string" || !command.reasonCode.trim() ||
      (command.action === "select_source" && (typeof command.selectedSourceReferenceId !== "string" || !command.selectedSourceReferenceId)) ||
      (command.note !== undefined && command.note !== null && typeof command.note !== "string") ||
      (command.idempotencyKey !== undefined && typeof command.idempotencyKey !== "string")
    ) {
      return json({ error: "invalid_reconciliation_resolution", correlationId: id }, { status: 400 });
    }
    if (command.action === "select_source") assertPermission(identity, "sources:read");
    // Idempotency-Key convention (issue #11): a retried request carrying the
    // same key replays the original resolution outcome (and does not emit a
    // second audit event) instead of re-attempting the resolution, which
    // would otherwise surface a spurious version_conflict indistinguishable
    // from a real concurrent conflict. Omitting the key behaves exactly as
    // before, including the optimistic-concurrency expectedVersion check.
    const clientKey = command.idempotencyKey || request.headers.get("idempotency-key") || undefined;
    const { status, body: data } = await withIdempotency(identity, "reconciliation_exceptions.resolve", clientKey, async () => {
      const outcome = await platform().resolveReconciliation(identity, command);
      await platform().audit({
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        actorSubject: identity.subject,
        sessionId: identity.sessionId,
        action: `reconciliation.${command.action}`,
        targetType: "reconciliation_exception",
        targetId: command.exceptionId,
        outcome: "success",
        correlationId: id,
        metadata: { expectedVersion: command.expectedVersion, reasonCode: command.reasonCode },
      });
      return { status: 202, body: outcome };
    });
    return json({ data, correlationId: id }, { status });
  } catch (error) { return apiError(error, id); }
}
