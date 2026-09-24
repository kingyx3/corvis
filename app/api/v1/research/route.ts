import { assertPermission } from "@/core/enterprise";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { parseResearchQuestion } from "@/lib/server/research";

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "research:query");
    const question = parseResearchQuestion(await request.json().catch(() => null));
    if (!question) return json({ error: "invalid_question", correlationId: id }, { status: 400 });
    const data = await platform().research(identity, question, { signal: request.signal });
    return json({ data, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
