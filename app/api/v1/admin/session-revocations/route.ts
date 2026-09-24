import { randomUUID } from "crypto";
import { assertPermission, type RequestIdentity } from "@/core/enterprise";
import { PostgresSessionRevocationRepository } from "@/lib/server/authorization";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { readJsonObject } from "@/lib/server/admin-request";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { PostgresOperationsRepository } from "@/lib/server/platform-repositories";
import { postgres, withTransaction } from "@/lib/server/postgres";

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

    // The revocation write and its audit event must commit or roll back
    // together, so a failed audit insert never leaves an unaudited
    // revocation in place (and a client retry cannot land on a state where
    // the revocation appears not to have happened when it in fact did).
    await withTransaction(postgres(getServerConfig().postgresDsn), async (tx) => {
      await new PostgresSessionRevocationRepository(tx).revoke({
        tenantId: identity.tenantId,
        authMethod,
        subject,
        sessionId,
        revokedBySubject: identity.subject,
        reason,
      });
      await new PostgresOperationsRepository(tx).audit({
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
    });
    return json({ data: { revoked: true, subject, sessionId, authMethod }, correlationId: id }, { status: 201 });
  } catch (error) {
    return apiError(error, id);
  }
}
