import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { ResearchPinError, unpinResearchAnswer } from "@/lib/server/research-pins";

export async function DELETE(request: Request, { params }: { params: Promise<{ pinId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "research:query");
    const { pinId } = await params;
    await unpinResearchAnswer(identity, pinId);
    return json({ data: { pinId }, correlationId: id });
  } catch (error) {
    if (error instanceof ResearchPinError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
