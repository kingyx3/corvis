import { randomUUID } from "crypto";
import { assertPermission } from "@/core/enterprise";
import { apiError, correlationId, json } from "@/lib/server/http";
import { platform } from "@/lib/server/platform";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { sourceConnectorSecretStore } from "@/lib/server/source-connector-runtime";
import {
  ConnectorGovernanceError,
  createSourceConnection,
  listSourceConnections,
  type CredentialType,
  type SourceConnection,
  type SourceScope,
} from "@/lib/server/source-connectors";

const CREDENTIAL_TYPES = new Set<CredentialType>([
  "oauth_authorization_code", "oauth_client_credentials", "scoped_api_token", "service_account", "browser_session",
]);

/** Never returns the secret reference; it is an internal resource pointer, not customer-facing state. */
function toResponse(connection: SourceConnection): Omit<SourceConnection, "secretReference"> {
  const { secretReference, ...rest } = connection;
  void secretReference;
  return rest;
}

function parseSourceScope(value: unknown): SourceScope[] {
  if (!Array.isArray(value)) throw new ConnectorGovernanceError("source_scope_confirmation_required");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { label?: unknown }).label !== "string" || !(entry as { label: string }).label.trim()) {
      throw new ConnectorGovernanceError("source_scope_confirmation_required");
    }
    const path = (entry as { path?: unknown }).path;
    return { label: (entry as { label: string }).label, ...(typeof path === "string" ? { path } : {}) };
  });
}

export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const connections = await listSourceConnections(identity);
    return json({ data: connections.map(toResponse), correlationId: id });
  } catch (error) { return apiError(error, id); }
}

export async function POST(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "admin:manage");
    const body = await request.json() as {
      providerKey?: unknown; connectionLabel?: unknown; credentialType?: unknown;
      sourceScope?: unknown; secret?: unknown; connectorVersion?: unknown;
    };

    if (typeof body.providerKey !== "string" || !body.providerKey) return json({ error: "provider_key_required", correlationId: id }, { status: 400 });
    if (typeof body.connectionLabel !== "string" || !body.connectionLabel.trim()) return json({ error: "connection_label_required", correlationId: id }, { status: 400 });
    if (typeof body.credentialType !== "string" || !CREDENTIAL_TYPES.has(body.credentialType as CredentialType)) return json({ error: "invalid_credential_type", correlationId: id }, { status: 400 });
    if (!body.secret || typeof body.secret !== "object" || Array.isArray(body.secret)) return json({ error: "secret_required", correlationId: id }, { status: 400 });
    if (typeof body.connectorVersion !== "string" || !body.connectorVersion.trim()) return json({ error: "connector_version_required", correlationId: id }, { status: 400 });

    const sourceScope = parseSourceScope(body.sourceScope);

    const created = await createSourceConnection(identity, {
      workspaceId: identity.workspaceId,
      providerKey: body.providerKey,
      connectionLabel: body.connectionLabel,
      credentialType: body.credentialType as CredentialType,
      sourceScope,
      secret: body.secret as Record<string, unknown>,
      connectorVersion: body.connectorVersion,
    }, { secrets: sourceConnectorSecretStore() });

    await platform().audit({
      id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
      actorSubject: identity.subject, sessionId: identity.sessionId, action: "source_connection.create",
      targetType: "source_connection", targetId: created.sourceConnectionId, outcome: "success", correlationId: id,
      metadata: { providerKey: created.providerKey },
    });
    return json({ data: toResponse(created), correlationId: id }, { status: 201 });
  } catch (error) { return apiError(error, id); }
}
