import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { researchService } from "@/lib/server/research";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "research:query");
    const body = await request.json() as { question?: string };
    const question = body.question?.trim();
    if (!question || question.length > 4000) return json({ error: "invalid_question", correlationId: id }, { status: 400 });
    const data = await researchService().answer(identity, question, { signal: request.signal });
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
