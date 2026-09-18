import { assertPermission } from "@/core/enterprise";
import { platform } from "@/lib/server/platform";
import { resolveRequestIdentity } from "@/lib/server/request-context";
import { apiError, correlationId, json } from "@/lib/server/http";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = resolveRequestIdentity(request);
    assertPermission(identity, "research:query");
    const body = await request.json() as { question?: string };
    const question = body.question?.trim();
    if (!question || question.length > 4000) return json({ error: "invalid_question", correlationId: id }, { status: 400 });
    const data = await platform().research(identity, question);
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
