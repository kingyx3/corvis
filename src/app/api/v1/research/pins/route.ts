import { assertPermission } from "@/core/enterprise";
import { readJsonObject } from "@/lib/server/admin-request";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { listResearchPins, pinResearchAnswer, ResearchPinError } from "@/lib/server/research-pins";

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "research:query");
    return json({ data: await listResearchPins(identity), correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "research:query");
    const body = await readJsonObject(request);
    if (!body || typeof body.question !== "string" || typeof body.askedAt !== "string" || typeof body.answer !== "object" || body.answer === null) {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }
    const data = await pinResearchAnswer(identity, { question: body.question, askedAt: body.askedAt, answer: body.answer as never });
    return json({ data, correlationId: id }, { status: 201 });
  } catch (error) {
    if (error instanceof ResearchPinError) return json({ error: error.code, correlationId: id }, { status: error.status });
    return apiError(error, id);
  }
}
