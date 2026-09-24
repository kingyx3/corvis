import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { executeDeletionRequest } from "@/lib/server/data-lifecycle";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { logEvent } from "@/lib/server/telemetry";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";

export async function POST(request: Request, context: {params: Promise<{requestId:string}>}) {
  const id=correlationId(request);
  try {
    const identity=await resolveAuthorizedRequestIdentity(request); assertPermission(identity,"admin:manage");
    const {requestId}=await context.params; const result=await executeDeletionRequest(identity,requestId);
    // The deletion itself is irreversible and already committed by this point
    // (executeDeletionRequest calls an external retention adapter mid-flow, so
    // this audit write deliberately is not in the same transaction -- see
    // lib/server/data-lifecycle.ts). If the audit insert fails, that must
    // never present a genuinely successful, irreversible deletion to the
    // caller as a request failure: log it loudly for reconciliation instead
    // of letting apiError() turn it into a 500 for a call that succeeded.
    try {
      await platform().audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"deletion_request.execute",targetType:"deletion_request",targetId:requestId,outcome:"success",correlationId:id,metadata:{replayed:result.replayed,attempt:result.attempt}});
    } catch (auditError) {
      logEvent("error", "deletion_request.audit_write_failed", { correlationId: id }, {
        requestId, tenantId: identity.tenantId, replayed: result.replayed,
        message: auditError instanceof Error ? auditError.message : "unknown",
      });
    }
    return json({data:result,correlationId:id});
  } catch(error){ return apiError(error,id); }
}
