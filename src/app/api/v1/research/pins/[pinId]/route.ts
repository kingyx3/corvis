import { assertPermission } from "@/shared/domain/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/identity/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/api/http";
import { ResearchPinError, unpinResearchAnswer } from "@/modules/research/server/research-pins";
import { isUuid } from "@/platform/database/uuid";

export async function DELETE(request: Request, { params }: { params: Promise<{ pinId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "research:query");
    const { pinId } = await params;
    if (!isUuid(pinId)) return json({ error: "invalid_pin_id", correlationId: id }, { status: 400 });
    await unpinResearchAnswer(identity, pinId);
    return json({ data: { pinId }, correlationId: id });
  } catch (error) {
    if (error instanceof ResearchPinError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
