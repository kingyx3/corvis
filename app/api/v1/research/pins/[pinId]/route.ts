import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { ResearchPinError, unpinResearchAnswer } from "@/lib/server/research-pins";
import { isUuid } from "@/lib/server/uuid";

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
