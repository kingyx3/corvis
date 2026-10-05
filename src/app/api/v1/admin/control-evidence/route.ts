import { randomUUID } from "crypto";
import { resolveAdminRequestIdentity } from "@/platform/http/identity/admin-request";
import { getServerConfig } from "@/platform/config/config";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { generateControlEvidence, listControlEvidence } from "@/platform/data/operations";
import { PostgresOperationsRepository } from "@/platform/data/platform-repositories";
import { postgres, withTransaction } from "@/platform/database/postgres";

export async function GET(request: Request) {
  const id=correlationId(request);
  try {
    const identity=await resolveAdminRequestIdentity(request);
    const rows=await listControlEvidence(identity);
    return json({data:rows,correlationId:id});
  } catch(error){ return apiError(error,id); }
}

export async function POST(request: Request) {
  const id=correlationId(request);
  try {
    const identity=await resolveAdminRequestIdentity(request);
    // The evidence write and its audit event must commit or roll back
    // together, so a failed audit insert never leaves an unaudited evidence
    // record (and its irreversible audit_events/… counts) in place.
    const evidence=await withTransaction(postgres(getServerConfig().databaseDsn), async (tx) => {
      const generated=await generateControlEvidence(identity,{db:tx});
      await new PostgresOperationsRepository(tx).audit({id:randomUUID(),occurredAt:new Date().toISOString(),tenantId:identity.tenantId,workspaceId:identity.workspaceId,actorSubject:identity.subject,sessionId:identity.sessionId,action:"control_evidence.generate",targetType:"control_evidence",targetId:generated.evidenceId,outcome:"success",correlationId:id});
      return generated;
    });
    return json({data:evidence,correlationId:id},{status:201});
  } catch(error){ return apiError(error,id); }
}
