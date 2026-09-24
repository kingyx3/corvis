import { randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { PostgresOperationsRepository } from "./platform-repositories.ts";
import { postgres, withTransaction, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";
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

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

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

async function loadRawConnection(db: PostgresSqlApi, identity: RequestIdentity, sourceConnectionId: string): Promise<PostgresRow> {
  const rows = await db.query(`select * from corvis_source.source_connection
    where tenant_id=$1 and workspace_id=$2::uuid and source_connection_id=$3::uuid limit 1`,
  [identity.tenantId, identity.workspaceId, sourceConnectionId]);
  const row = rows[0];
  if (!row) throw new ConnectorGovernanceError("connection_not_found");
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
    const rows = await tx.query(`select status,secret_reference from corvis_source.source_connection
      where tenant_id=$1 and workspace_id=$2::uuid and source_connection_id=$3::uuid for update`,
    [identity.tenantId, identity.workspaceId, sourceConnectionId]);
    const row = rows[0];
    if (!row) throw new ConnectorGovernanceError("connection_not_found");
    secretReference = requiredText(row, "secret_reference");
    const status = requiredText(row, "status") as ConnectionStatus;
    if (status !== "revoked") {
      await tx.execute(`update corvis_source.source_connection set status='revoked', revoked_at=now(), updated_at=now()
        where tenant_id=$1 and workspace_id=$2::uuid and source_connection_id=$3::uuid`,
      [identity.tenantId, identity.workspaceId, sourceConnectionId]);
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
          secret_reference=$4, status=case when status='paused' then 'paused' else 'active' end,
          consecutive_failures=0, last_error_class=null, last_authorized_at=now(), updated_at=now()
        where tenant_id=$1 and workspace_id=$2::uuid and source_connection_id=$3::uuid and status<>'revoked' and secret_reference=$5
        returning source_connection_id`,
      [identity.tenantId, identity.workspaceId, sourceConnectionId, newReference, previousReference]);
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
export async function testAuditedSourceConnection(
  identity: RequestIdentity,
  sourceConnectionId: string,
  correlationId: string,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore; drivers: Map<string, ConnectorDriver> },
): Promise<ConnectionTestResult> {
  const db = dependencies.db ?? controlDb();
  const row = await loadRawConnection(db, identity, sourceConnectionId);
  const status = requiredText(row, "status") as ConnectionStatus;
  if (status === "revoked") throw new ConnectorGovernanceError("connection_revoked");
  const providerKey = requiredText(row, "provider_key");
  const driver = dependencies.drivers.get(providerKey);
  if (!driver) throw new ConnectorGovernanceError("unregistered_provider");
  const credential = await dependencies.secrets.read(requiredText(row, "secret_reference"));
  const result = await driver.testConnection(credential, sourceScope(row));

  await withTransaction(db, async (tx) => {
    if (result.ok && status === "pending_authorization") {
      await tx.execute(`update corvis_source.source_connection set status='active', last_authorized_at=now(), updated_at=now()
        where tenant_id=$1 and workspace_id=$2::uuid and source_connection_id=$3::uuid and status='pending_authorization'`,
      [identity.tenantId, identity.workspaceId, sourceConnectionId]);
    } else if (!result.ok && result.errorClass) {
      const nextStatus = statusAfterError(status, result.errorClass, numberValue(row, "consecutive_failures"));
      await tx.execute(`update corvis_source.source_connection set status=$4, last_error_class=$5, updated_at=now()
        where tenant_id=$1 and workspace_id=$2::uuid and source_connection_id=$3::uuid and status=$6`,
      [identity.tenantId, identity.workspaceId, sourceConnectionId, nextStatus, result.errorClass, status]);
    }
    await writeAudit(tx, identity, correlationId, "source_connection.test", sourceConnectionId,
      result.ok ? "success" : "failure", { errorClass: result.errorClass ?? null });
  });

  return result;
}
