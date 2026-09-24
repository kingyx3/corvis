import { randomUUID } from "crypto";
import { assertPermission, type RequestIdentity } from "@/core/enterprise";
import { sessionRevocationRepository } from "@/lib/server/authorization";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { readJsonObject } from "@/lib/server/admin-request";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";

function revocableAuthMethod(value: unknown): Exclude<RequestIdentity["authMethod"], "demo"> | undefined {
  return value === "oidc" || value === "saml" || value === "service_account" ? value : undefined;
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");

    const body = await readJsonObject(request) as {
      subject?: unknown;
      sessionId?: unknown;
      authMethod?: unknown;
      reason?: unknown;
    } | undefined;

    if (!body) return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const authMethod = revocableAuthMethod(body.authMethod);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!subject || subject.length > 1024 || !sessionId || sessionId.length > 1024 || !authMethod || !reason || reason.length > 1000) {
      return json({ error: "invalid_request", correlationId: id }, { status: 400 });
    }

    await sessionRevocationRepository().revoke({
      tenantId: identity.tenantId,
      authMethod,
      subject,
      sessionId,
      revokedBySubject: identity.subject,
      reason,
    });
    await platform().audit({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      tenantId: identity.tenantId,
      workspaceId: identity.workspaceId,
      actorSubject: identity.subject,
      sessionId: identity.sessionId,
      action: "identity.session.revoke",
      targetType: "session",
      targetId: sessionId,
      outcome: "success",
      correlationId: id,
      metadata: { targetSubject: subject, authMethod },
    });
    return json({ data: { revoked: true, subject, sessionId, authMethod }, correlationId: id }, { status: 201 });
  } catch (error) {
    return apiError(error, id);
  }
}
