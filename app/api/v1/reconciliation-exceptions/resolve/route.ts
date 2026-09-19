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

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:review");
    const command = await request.json() as ReconciliationResolutionCommand & { idempotencyKey?: string };
    if (
      !command.exceptionId ||
      !Number.isInteger(command.expectedVersion) || command.expectedVersion <= 0 ||
      !actions.includes(command.action) ||
      !command.reasonCode ||
      (command.action === "select_source" && !command.selectedSourceReferenceId)
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
