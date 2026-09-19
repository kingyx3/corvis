import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { generateControlEvidence, listControlEvidence } from "@/lib/server/operations";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";

export async function GET(request: Request) {
  const id=correlationId(request);
  try {
    const identity=resolveRequestIdentity(request);
    assertPermission(identity,"admin:manage");
    const rows=await listControlEvidence(identity);
    return json({data:rows,correlationId:id});
  } catch(error){ return apiError(error,id); }
}

export async function POST(request: Request) {
  const id=correlationId(request);
  try {
    const identity=resolveRequestIdentity(request); assertPermission(identity,"admin:manage"); const evidence=await generateControlEvidence(identity);
    await platform().audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"control_evidence.generate",targetType:"control_evidence",targetId:evidence.evidenceId,outcome:"success",correlationId:id});
    return json({data:evidence,correlationId:id},{status:201});
  } catch(error){ return apiError(error,id); }
}
