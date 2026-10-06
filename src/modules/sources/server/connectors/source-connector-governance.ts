import { randomUUID } from "crypto";
import type { RequestIdentity } from "../../../../shared/domain/enterprise.ts";
import { getServerConfig } from "../../../../platform/config/config.ts";
import { PostgresOperationsRepository } from "../../../../platform/data/platform-repositories.ts";
import { OAuthCredentialExpiredError, freshOAuthCredential, type SourceOAuthClient } from "./source-oauth.ts";
import { isOAuthCredential } from "../../domain/source-connection-health.ts";
import { postgres, withTransaction, type PostgresRow, type PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import {
  ConnectorGovernanceError,
  getSourceConnection,
  pauseSourceConnection,
  resumeSourceConnection,
  statusAfterError,
  type ConnectionStatus,
  type ConnectionTestResult,
  type ConnectorDriver,
  type CreateConnectionInput,
  type SecretPayload,
  type SecretStore,
  type SourceConnection,
  type SourceScope,
} from "./source-connectors.ts";

const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const MAX_CONNECTION_LABEL_LENGTH = 200;

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().databaseDsn); }

function requiredText(row: PostgresRow, key: string): string {
  const value = row[key];
  if (value == null) throw new Error(`missing required column ${key}`);
  return value instanceof Date ? value.toISOString() : String(value);
}

function numberValue(row: PostgresRow, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function sourceScope(row: PostgresRow): SourceScope[] {
  const value = row.source_scope;
  if (Array.isArray(value)) return value as SourceScope[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as SourceScope[] : [];
  } catch {
    return [];
  }
}

async function writeAudit(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  correlationId: string,
  action: string,
  targetId: string,
  outcome: "success" | "failure" = "success",
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  await new PostgresOperationsRepository(db).audit({
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    tenantId: identity.tenantId,
    workspaceId: identity.workspaceId,
    actorSubject: identity.subject,
    sessionId: identity.sessionId,
    action,
    targetType: "source_connection",
    targetId,
    outcome,
    correlationId,
    metadata,
  });
}

/**
 * Records one customer-visible event of the connect flow that changes no connection row (an OAuth sign-in started or
 * declined) in the access audit. It stands alone, not inside another change's transaction, and a failure to write it
 * fails the request: the flow never proceeds without its evidence. `targetId` is the connection being renewed, or the
 * provider key for a connection that does not exist yet. Metadata holds the provider key only, never a credential.
 */
export async function auditSourceConnectionEvent(
  identity: RequestIdentity,
  correlationId: string,
  action: string,
  targetId: string,
  metadata: Record<string, string | number | boolean | null> = {},
  dependencies: { db?: PostgresSqlApi } = {},
): Promise<void> {
  await writeAudit(dependencies.db ?? controlDb(), identity, correlationId, action, targetId, "success", metadata);
}

async function loadRawConnection(db: PostgresSqlApi, identity: RequestIdentity, sourceConnectionId: string): Promise<PostgresRow> {
  const rows = await db.query(`select * from corvis_source.source_connection
    where tenant_id=$1 and source_connection_id=$2::uuid and workspace_id=$3::uuid limit 1`,
  [identity.tenantId, sourceConnectionId, identity.workspaceId]);
  const row = rows[0];
  if (!row || requiredText(row, "workspace_id") !== identity.workspaceId) {
    throw new ConnectorGovernanceError("connection_not_found");
  }
  return row;
}

async function getWorkspaceConnection(db: PostgresSqlApi, identity: RequestIdentity, sourceConnectionId: string): Promise<SourceConnection> {
  const connection = await getSourceConnection(identity, sourceConnectionId, db);
  if (connection.workspaceId !== identity.workspaceId) throw new ConnectorGovernanceError("connection_not_found");
  return connection;
}

function validateCreateInput(input: CreateConnectionInput): void {
  if (!PROVIDER_KEY_PATTERN.test(input.providerKey)) throw new ConnectorGovernanceError("invalid_provider_key");
  if (!input.connectionLabel.trim()) throw new ConnectorGovernanceError("connection_label_required");
  if (input.connectionLabel.length > MAX_CONNECTION_LABEL_LENGTH) throw new ConnectorGovernanceError("connection_label_too_long");
  if (input.sourceScope.length === 0) throw new ConnectorGovernanceError("source_scope_confirmation_required");
}

/**
 * Creates the managed secret before opening the database transaction, then
 * commits only the source-connection metadata row and required audit event in
 * one short transaction. If the insert or audit fails, the just-created secret
 * is compensatingly revoked so no unreferenced credential is left live.
 */
export async function createAuditedSourceConnection(
  identity: RequestIdentity,
  input: CreateConnectionInput,
  correlationId: string,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore },
): Promise<SourceConnection> {
  validateCreateInput(input);
  if (input.workspaceId !== identity.workspaceId) throw new ConnectorGovernanceError("connection_not_found");
  const db = dependencies.db ?? controlDb();
  const secretReference = await dependencies.secrets.write(identity.tenantId, input.providerKey, input.secret);

  try {
    return await withTransaction(db, async (tx) => {
      const inserted = await tx.query(`insert into corvis_source.source_connection
        (tenant_id, workspace_id, provider_key, connection_label, credential_type, source_scope,
         scope_confirmed_by, scope_confirmed_at, secret_reference, connector_version, created_by)
      values ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,now(),$8,$9,$7)
      returning source_connection_id`,
      [identity.tenantId, identity.workspaceId, input.providerKey, input.connectionLabel, input.credentialType,
        JSON.stringify(input.sourceScope), identity.subject, secretReference, input.connectorVersion]);
      const sourceConnectionId = requiredText(inserted[0]!, "source_connection_id");
      await writeAudit(tx, identity, correlationId, "source_connection.create", sourceConnectionId, "success", {
        providerKey: input.providerKey,
        // How many of the provider's folders the administrator confirmed (the scope itself is stored on the connection).
        scopeCount: input.sourceScope.length,
      });
      return getWorkspaceConnection(tx, identity, sourceConnectionId);
    });
  } catch (error) {
    await dependencies.secrets.revoke(secretReference).catch(() => undefined);
    throw error;
  }
}

export async function transitionAuditedSourceConnection(
  identity: RequestIdentity,
  sourceConnectionId: string,
  action: "pause" | "resume" | "revoke",
  correlationId: string,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore },
): Promise<SourceConnection> {
  const db = dependencies.db ?? controlDb();
  await loadRawConnection(db, identity, sourceConnectionId);
  if (action === "pause" || action === "resume") {
    return withTransaction(db, async (tx) => {
      if (action === "pause") await pauseSourceConnection(identity, sourceConnectionId, tx);
      else await resumeSourceConnection(identity, sourceConnectionId, tx);
      const connection = await getWorkspaceConnection(tx, identity, sourceConnectionId);
      await writeAudit(tx, identity, correlationId, `source_connection.${action}`, sourceConnectionId);
      return connection;
    });
  }

  let secretReference = "";
  const connection = await withTransaction(db, async (tx) => {
    const rows = await tx.query(`select status,secret_reference,workspace_id from corvis_source.source_connection
      where tenant_id=$1 and source_connection_id=$2::uuid and workspace_id=$3::uuid for update`,
    [identity.tenantId, sourceConnectionId, identity.workspaceId]);
    const row = rows[0];
    if (!row || requiredText(row, "workspace_id") !== identity.workspaceId) {
      throw new ConnectorGovernanceError("connection_not_found");
    }
    secretReference = requiredText(row, "secret_reference");
    const status = requiredText(row, "status") as ConnectionStatus;
    if (status !== "revoked") {
      await tx.execute(`update corvis_source.source_connection set status='revoked', revoked_at=now(), updated_at=now()
        where tenant_id=$1 and source_connection_id=$2::uuid and workspace_id=$3::uuid`,
      [identity.tenantId, sourceConnectionId, identity.workspaceId]);
      await writeAudit(tx, identity, correlationId, "source_connection.revoke", sourceConnectionId);
    }
    return getWorkspaceConnection(tx, identity, sourceConnectionId);
  });

  await dependencies.secrets.revoke(secretReference);
  return connection;
}

export async function reauthorizeAuditedSourceConnection(
  identity: RequestIdentity,
  sourceConnectionId: string,
  secret: SecretPayload,
  correlationId: string,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore },
): Promise<SourceConnection> {
  const db = dependencies.db ?? controlDb();
  const initial = await loadRawConnection(db, identity, sourceConnectionId);
  const status = requiredText(initial, "status") as ConnectionStatus;
  if (status === "revoked") throw new ConnectorGovernanceError("connection_revoked");
  const providerKey = requiredText(initial, "provider_key");
  const previousReference = requiredText(initial, "secret_reference");
  const newReference = await dependencies.secrets.write(identity.tenantId, providerKey, secret);

  try {
    const connection = await withTransaction(db, async (tx) => {
      const updated = await tx.query(`update corvis_source.source_connection set
          secret_reference=$3, status=case when status='paused' then 'paused' else 'active' end,
          consecutive_failures=0, last_error_class=null, last_authorized_at=now(), updated_at=now()
        where tenant_id=$1 and source_connection_id=$2::uuid and status<>'revoked' and secret_reference=$4 and workspace_id=$5::uuid
        returning source_connection_id`,
      [identity.tenantId, sourceConnectionId, newReference, previousReference, identity.workspaceId]);
      if (updated.length === 0) {
        const latest = await loadRawConnection(tx, identity, sourceConnectionId);
        throw new ConnectorGovernanceError(requiredText(latest, "status") === "revoked"
          ? "connection_revoked"
          : "invalid_transition_from_concurrent_change");
      }
      await writeAudit(tx, identity, correlationId, "source_connection.reauthorize", sourceConnectionId);
      return getWorkspaceConnection(tx, identity, sourceConnectionId);
    });
    await dependencies.secrets.revoke(previousReference).catch(() => undefined);
    return connection;
  } catch (error) {
    await dependencies.secrets.revoke(newReference).catch(() => undefined);
    throw error;
  }
}

/**
 * Provider connectivity runs outside a database transaction. Only the small
 * CAS state update plus its required audit record are transactional, so a slow
 * provider cannot hold database locks/connections open while still ensuring a
 * status mutation cannot commit without audit evidence.
 */
export type ConnectionCredentialRef = { sourceConnectionId: string; providerKey: string; credentialType: string; secretReference: string };

/**
 * Returns the credential to use for a connection right now. An OAuth credential that has expired, or is about to, is
 * refreshed through its provider's client (see `freshOAuthCredential`) and the replacement is stored as a new secret
 * and swapped in with a compare-and-set on the old reference, audited as `source_connection.token_refresh`; the old
 * secret is destroyed only afterwards. If another request already swapped the credential, the replacement made here is
 * destroyed and used for this call only. Any other credential type is returned untouched. Throws
 * `OAuthCredentialExpiredError` (connector error class `reauthorization`) when an expired credential cannot be renewed.
 * A scheduler passes this to `runConnectionSync` as its `resolveCredential`.
 */
export async function resolveConnectionCredential(
  identity: RequestIdentity,
  connection: ConnectionCredentialRef,
  credential: SecretPayload,
  correlationId: string,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore; oauthClient?: (providerKey: string) => SourceOAuthClient | undefined; now?: () => number },
): Promise<SecretPayload> {
  if (!isOAuthCredential(connection.credentialType)) return credential;
  const fresh = await freshOAuthCredential(credential, dependencies.oauthClient?.(connection.providerKey), dependencies.now);
  if (!fresh.refreshed) return fresh.credential;
  const db = dependencies.db ?? controlDb();
  const newReference = await dependencies.secrets.write(identity.tenantId, connection.providerKey, fresh.credential);
  try {
    const swapped = await withTransaction(db, async (tx) => {
      const updated = await tx.query(`update corvis_source.source_connection set secret_reference=$3, updated_at=now()
        where tenant_id=$1 and source_connection_id=$2::uuid and secret_reference=$4 and status<>'revoked' and workspace_id=$5::uuid
        returning source_connection_id`,
      [identity.tenantId, connection.sourceConnectionId, newReference, connection.secretReference, identity.workspaceId]);
      if (updated.length === 0) return false;
      await writeAudit(tx, identity, correlationId, "source_connection.token_refresh", connection.sourceConnectionId, "success", { providerKey: connection.providerKey });
      return true;
    });
    await dependencies.secrets.revoke(swapped ? connection.secretReference : newReference).catch(() => undefined);
  } catch (error) {
    await dependencies.secrets.revoke(newReference).catch(() => undefined);
    throw error;
  }
  return fresh.credential;
}

export async function testAuditedSourceConnection(
  identity: RequestIdentity,
  sourceConnectionId: string,
  correlationId: string,
  dependencies: {
    db?: PostgresSqlApi;
    secrets: SecretStore;
    drivers: Map<string, ConnectorDriver>;
    oauthClient?: (providerKey: string) => SourceOAuthClient | undefined;
    now?: () => number;
  },
): Promise<ConnectionTestResult> {
  const db = dependencies.db ?? controlDb();
  const row = await loadRawConnection(db, identity, sourceConnectionId);
  const status = requiredText(row, "status") as ConnectionStatus;
  if (status === "revoked") throw new ConnectorGovernanceError("connection_revoked");
  const providerKey = requiredText(row, "provider_key");
  const driver = dependencies.drivers.get(providerKey);
  if (!driver) throw new ConnectorGovernanceError("unregistered_provider");
  const secretReference = requiredText(row, "secret_reference");
  let result: ConnectionTestResult;
  try {
    const credential = await resolveConnectionCredential(identity, {
      sourceConnectionId, providerKey, credentialType: requiredText(row, "credential_type"), secretReference,
    }, await dependencies.secrets.read(secretReference), correlationId, dependencies);
    result = await driver.testConnection(credential, sourceScope(row));
  } catch (error) {
    // An expired credential that cannot be renewed is a failed test with the class that sends the connection to reauthorization.
    if (!(error instanceof OAuthCredentialExpiredError)) throw error;
    result = { ok: false, errorClass: error.connectorErrorClass };
  }

  await withTransaction(db, async (tx) => {
    if (result.ok && status === "pending_authorization") {
      await tx.execute(`update corvis_source.source_connection set status='active', last_authorized_at=now(), updated_at=now()
        where tenant_id=$1 and source_connection_id=$2::uuid and status='pending_authorization' and workspace_id=$3::uuid`,
      [identity.tenantId, sourceConnectionId, identity.workspaceId]);
    } else if (!result.ok && result.errorClass) {
      const nextStatus = statusAfterError(status, result.errorClass, numberValue(row, "consecutive_failures"));
      await tx.execute(`update corvis_source.source_connection set status=$3, last_error_class=$4, updated_at=now()
        where tenant_id=$1 and source_connection_id=$2::uuid and status=$5 and workspace_id=$6::uuid`,
      [identity.tenantId, sourceConnectionId, nextStatus, result.errorClass, status, identity.workspaceId]);
    }
    await writeAudit(tx, identity, correlationId, "source_connection.test", sourceConnectionId,
      result.ok ? "success" : "failure", { errorClass: result.errorClass ?? null });
  });

  return result;
}
