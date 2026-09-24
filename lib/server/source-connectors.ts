import { createHash } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

/**
 * Customer-authorized source acquisition connectors.
 *
 * Postgres holds only non-secret connection metadata, run state and
 * acquisition lineage; credential material lives in a tenant-scoped managed
 * secret store and is referenced here by resource name only. A successful
 * login at connect-time is never treated as proof that every visible file is
 * authorized: the confirmed source scope is an independent, persisted
 * control that every discovery/download call is re-checked against.
 */

export type ConnectionStatus =
  | "pending_authorization"
  | "active"
  | "paused"
  | "reauthorization_required"
  | "suspended"
  | "revoked";

export type CredentialType =
  | "oauth_authorization_code"
  | "oauth_client_credentials"
  | "scoped_api_token"
  | "service_account"
  | "browser_session";

export type ConnectorErrorClass =
  | "auth"
  | "reauthorization"
  | "permission"
  | "provider_change"
  | "network"
  | "download"
  | "validation"
  | "rate_limit";

export type RunTrigger = "scheduled" | "on_demand" | "webhook" | "backfill";
export type RunState = "running" | "succeeded" | "failed" | "retryable" | "dead_letter" | "refused";
export type AcquisitionDisposition = "accepted" | "duplicate" | "rejected" | "quarantined";

export type SourceScope = { label: string; path?: string };

export type SourceConnection = {
  sourceConnectionId: string;
  tenantId: string;
  workspaceId: string;
  providerKey: string;
  connectionLabel: string;
  credentialType: CredentialType;
  sourceScope: SourceScope[];
  scopeConfirmedBy: string;
  scopeConfirmedAt: string;
  secretReference: string;
  connectorVersion: string;
  status: ConnectionStatus;
  consecutiveFailures: number;
  lastErrorClass?: ConnectorErrorClass;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  revokedAt?: string;
};

export class ConnectorGovernanceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ConnectorGovernanceError";
    this.code = code;
  }
}

const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mirrors the connection_label check constraint in migration 018 so an over-long label is a 400, not a 500. */
const MAX_CONNECTION_LABEL_LENGTH = 200;

/**
 * A customer-supplied connection id that is not a UUID can never name a
 * connection; refusing it as not-found keeps it from reaching a `::uuid`
 * cast (a Postgres error, surfaced as a 500).
 */
export function assertSourceConnectionId(sourceConnectionId: string): void {
  if (!UUID_PATTERN.test(sourceConnectionId)) throw new ConnectorGovernanceError("connection_not_found");
}
const RETRYABLE_ERROR_CLASSES: readonly ConnectorErrorClass[] = ["network", "download", "rate_limit"];
const FAIL_CLOSED_ERROR_CLASSES: readonly ConnectorErrorClass[] = ["auth", "reauthorization", "permission", "provider_change", "validation"];

/**
 * The stable idempotency key for one remote document version. Discovering
 * the same remote id/version/content twice — across retries or scheduled
 * runs — must always resolve to the same key so it is treated as a
 * duplicate rather than re-ingested; a genuine remote replacement (new
 * content behind the same remote id) produces a different key and is
 * retained as a new acquisition rather than overwriting the prior one.
 */
export function acquisitionKey(remoteDocumentId: string, remoteVersion: string, contentSha256: string): string {
  return createHash("sha256").update(remoteDocumentId).update("\u0000").update(remoteVersion).update("\u0000").update(contentSha256).digest("hex");
}

/** Bounded exponential backoff with full jitter, capped so a stuck connector cannot silently poll forever without operator visibility. */
export function nextAttemptDelayMs(attempt: number, baseMs = 60_000, maxMs = 60 * 60_000): number {
  const bounded = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(bounded * (0.5 + Math.random() * 0.5));
}

/** An error in one of these classes can never be resolved by retrying the same call; the connection must fail closed instead. */
export function isFailClosedErrorClass(errorClass: ConnectorErrorClass): boolean {
  return FAIL_CLOSED_ERROR_CLASSES.includes(errorClass);
}

export function isRetryableErrorClass(errorClass: ConnectorErrorClass): boolean {
  return RETRYABLE_ERROR_CLASSES.includes(errorClass);
}

/** The connection status an error class drives a connection to, on top of whatever status it already had. */
export function statusAfterError(current: ConnectionStatus, errorClass: ConnectorErrorClass, consecutiveFailures: number): ConnectionStatus {
  if (current === "revoked") return "revoked";
  if (errorClass === "auth" || errorClass === "reauthorization") return "reauthorization_required";
  if (errorClass === "permission" || errorClass === "provider_change") return "suspended";
  if (consecutiveFailures >= 5) return "suspended";
  return current;
}

export type SecretPayload = Record<string, unknown>;

/** Never logs or returns raw secret material; callers only ever see the reference. */
export interface SecretStore {
  write(tenantId: string, providerKey: string, secret: SecretPayload): Promise<string>;
  read(secretReference: string): Promise<SecretPayload>;
  revoke(secretReference: string): Promise<void>;
}

export type RemoteDocumentRef = {
  remoteDocumentId: string;
  remoteVersion: string;
  remotePath: string;
  remoteModifiedAt?: string;
};

export type DownloadedDocument = { bytes: Buffer; contentType: string };

export type ConnectionTestResult = { ok: boolean; detail?: string; errorClass?: ConnectorErrorClass };

/**
 * Provider-neutral acquisition contract. A real driver never bypasses MFA,
 * CAPTCHA, rate limits or source permissions; a failure it cannot classify
 * as retryable must surface as a fail-closed error class instead of being
 * silently swallowed.
 */
export interface ConnectorDriver {
  readonly providerKey: string;
  readonly connectorVersion: string;
  testConnection(credential: SecretPayload, scope: SourceScope[]): Promise<ConnectionTestResult>;
  discover(credential: SecretPayload, scope: SourceScope[], sinceIso: string | undefined): Promise<RemoteDocumentRef[]>;
  download(credential: SecretPayload, ref: RemoteDocumentRef): Promise<DownloadedDocument>;
}

export type IngestResult =
  | { accepted: true; documentId: string; documentArtifactVersionId: string }
  | { accepted: false; reason: string; quarantined: boolean };

/**
 * The seam into the existing immutable ingestion pipeline. A real
 * implementation performs the same GCS integrity/quarantine/document-
 * registration steps the direct customer-upload path performs; this module
 * never re-implements that pipeline.
 */
export interface IngestSink {
  ingest(input: { tenantId: string; workspaceId: string; providerKey: string; fileName: string; bytes: Buffer; contentType: string; contentSha256: string }): Promise<IngestResult>;
}

function text(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

function requiredText(row: PostgresRow, key: string): string {
  const value = text(row, key);
  if (value === undefined) throw new Error(`missing required column ${key}`);
  return value;
}

function num(row: PostgresRow, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function jsonArray(value: unknown): SourceScope[] {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed as SourceScope[] : [];
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function rowToConnection(row: PostgresRow): SourceConnection {
  return {
    sourceConnectionId: requiredText(row, "source_connection_id"),
    tenantId: requiredText(row, "tenant_id"),
    workspaceId: requiredText(row, "workspace_id"),
    providerKey: requiredText(row, "provider_key"),
    connectionLabel: requiredText(row, "connection_label"),
    credentialType: requiredText(row, "credential_type") as CredentialType,
    sourceScope: jsonArray(row.source_scope),
    scopeConfirmedBy: requiredText(row, "scope_confirmed_by"),
    scopeConfirmedAt: requiredText(row, "scope_confirmed_at"),
    secretReference: requiredText(row, "secret_reference"),
    connectorVersion: requiredText(row, "connector_version"),
    status: requiredText(row, "status") as ConnectionStatus,
    consecutiveFailures: num(row, "consecutive_failures"),
    lastErrorClass: text(row, "last_error_class") as ConnectorErrorClass | undefined,
    lastSuccessAt: text(row, "last_success_at"),
    lastAttemptAt: text(row, "last_attempt_at"),
    revokedAt: text(row, "revoked_at"),
  };
}

function controlDb(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

export type CreateConnectionInput = {
  workspaceId: string;
  providerKey: string;
  connectionLabel: string;
  credentialType: CredentialType;
  sourceScope: SourceScope[];
  secret: SecretPayload;
  connectorVersion: string;
};

/**
 * Registers a connection with an explicit, persisted scope confirmation.
 * Credential material is written to the secret store first and only the
 * returned reference ever reaches Postgres.
 */
export async function createSourceConnection(
  identity: RequestIdentity,
  input: CreateConnectionInput,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore },
): Promise<SourceConnection> {
  if (!PROVIDER_KEY_PATTERN.test(input.providerKey)) throw new ConnectorGovernanceError("invalid_provider_key");
  if (!input.connectionLabel.trim()) throw new ConnectorGovernanceError("connection_label_required");
  if (input.connectionLabel.length > MAX_CONNECTION_LABEL_LENGTH) throw new ConnectorGovernanceError("connection_label_too_long");
  if (input.sourceScope.length === 0) throw new ConnectorGovernanceError("source_scope_confirmation_required");

  const db = dependencies.db ?? controlDb();
  const secretReference = await dependencies.secrets.write(identity.tenantId, input.providerKey, input.secret);

  let rows: PostgresRow[];
  try {
    rows = await db.query(`insert into corvis_source.source_connection
      (tenant_id, workspace_id, provider_key, connection_label, credential_type, source_scope,
       scope_confirmed_by, scope_confirmed_at, secret_reference, connector_version, created_by)
    values ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,now(),$8,$9,$7)
    returning *`,
    [identity.tenantId, input.workspaceId, input.providerKey, input.connectionLabel, input.credentialType,
      JSON.stringify(input.sourceScope), identity.subject, secretReference, input.connectorVersion]);
  } catch (error) {
    // No connection row references the credential just written, so it must
    // not outlive this failed request as an orphaned live secret.
    await dependencies.secrets.revoke(secretReference).catch(() => undefined);
    throw error;
  }
  return rowToConnection(rows[0]!);
}

export async function listSourceConnections(identity: RequestIdentity, db: PostgresSqlApi = controlDb()): Promise<SourceConnection[]> {
  const rows = await db.query(`select source_connection_id, tenant_id, workspace_id, provider_key, connection_label,
      credential_type, source_scope, scope_confirmed_by, scope_confirmed_at, connector_version, status,
      consecutive_failures, last_error_class, last_success_at, last_attempt_at, revoked_at,
      -- never select secret_reference for a customer-facing listing
      'redacted' as secret_reference
    from corvis_source.source_connection where tenant_id=$1 order by created_at desc`, [identity.tenantId]);
  return rows.map(rowToConnection);
}

/**
 * Customer-facing single-connection read: one tenant-scoped row (instead of
 * loading the tenant's whole listing to find one id), with the secret
 * reference redacted exactly as in the listing.
 */
export async function getSourceConnection(identity: RequestIdentity, sourceConnectionId: string, db: PostgresSqlApi = controlDb()): Promise<SourceConnection> {
  assertSourceConnectionId(sourceConnectionId);
  const rows = await db.query(`select source_connection_id, tenant_id, workspace_id, provider_key, connection_label,
      credential_type, source_scope, scope_confirmed_by, scope_confirmed_at, connector_version, status,
      consecutive_failures, last_error_class, last_success_at, last_attempt_at, revoked_at,
      -- never select secret_reference for a customer-facing read
      'redacted' as secret_reference
    from corvis_source.source_connection where tenant_id=$1 and source_connection_id=$2::uuid limit 1`,
  [identity.tenantId, sourceConnectionId]);
  const row = rows[0];
  if (!row) throw new ConnectorGovernanceError("connection_not_found");
  return rowToConnection(row);
}

async function loadConnection(db: PostgresSqlApi, tenantId: string, sourceConnectionId: string): Promise<PostgresRow> {
  const rows = await db.query(`select * from corvis_source.source_connection
    where tenant_id=$1 and source_connection_id=$2::uuid limit 1`, [tenantId, sourceConnectionId]);
  const row = rows[0];
  if (!row) throw new ConnectorGovernanceError("connection_not_found");
  return row;
}

async function transitionStatus(
  db: PostgresSqlApi,
  identity: RequestIdentity,
  sourceConnectionId: string,
  allowedFrom: ConnectionStatus[],
  to: ConnectionStatus,
  extra: { revokedAt?: boolean } = {},
): Promise<void> {
  const row = await loadConnection(db, identity.tenantId, sourceConnectionId);
  const current = requiredText(row, "status") as ConnectionStatus;
  if (!allowedFrom.includes(current)) throw new ConnectorGovernanceError(`invalid_transition_from_${current}`);
  // Compare-and-set on the status just read, so a concurrent transition (for
  // example a sync suspending the connection while it is being resumed) is
  // never silently overwritten by this stale decision.
  const updated = await db.query(`update corvis_source.source_connection set status=$3, updated_at=now()${extra.revokedAt ? ", revoked_at=now()" : ""}
    where tenant_id=$1 and source_connection_id=$2::uuid and status=$4 returning status`,
  [identity.tenantId, sourceConnectionId, to, current]);
  if (updated.length === 0) throw new ConnectorGovernanceError("invalid_transition_from_concurrent_change");
}

export async function pauseSourceConnection(identity: RequestIdentity, sourceConnectionId: string, db: PostgresSqlApi = controlDb()): Promise<void> {
  await transitionStatus(db, identity, sourceConnectionId, ["active", "reauthorization_required"], "paused");
}

export async function resumeSourceConnection(identity: RequestIdentity, sourceConnectionId: string, db: PostgresSqlApi = controlDb()): Promise<void> {
  await transitionStatus(db, identity, sourceConnectionId, ["paused"], "active");
}

/** Terminal: a revoked connection can never be reactivated under the same row and its secret is destroyed. */
export async function revokeSourceConnection(
  identity: RequestIdentity,
  sourceConnectionId: string,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore },
): Promise<void> {
  const db = dependencies.db ?? controlDb();
  const row = await loadConnection(db, identity.tenantId, sourceConnectionId);
  const current = requiredText(row, "status") as ConnectionStatus;
  if (current === "revoked") return;
  await dependencies.secrets.revoke(requiredText(row, "secret_reference"));
  await db.execute(`update corvis_source.source_connection set status='revoked', revoked_at=now(), updated_at=now()
    where tenant_id=$1 and source_connection_id=$2::uuid`, [identity.tenantId, sourceConnectionId]);
}

/**
 * Reauthorization replaces the secret behind an existing connection (for
 * example after token rotation) without losing its run/acquisition history,
 * and clears the failure streak that led to `reauthorization_required`.
 */
export async function reauthorizeSourceConnection(
  identity: RequestIdentity,
  sourceConnectionId: string,
  secret: SecretPayload,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore },
): Promise<void> {
  const db = dependencies.db ?? controlDb();
  const row = await loadConnection(db, identity.tenantId, sourceConnectionId);
  const current = requiredText(row, "status") as ConnectionStatus;
  if (current === "revoked") throw new ConnectorGovernanceError("connection_revoked");
  const providerKey = requiredText(row, "provider_key");
  const previousReference = requiredText(row, "secret_reference");
  const secretReference = await dependencies.secrets.write(identity.tenantId, providerKey, secret);
  // Rotating a credential is not a resume: a paused connection stays paused.
  // The status/secret predicates make this a compare-and-set, so a revoke (or
  // a second rotation) landing between the read above and this write is not
  // overwritten, and the credential just written is destroyed, not orphaned.
  let updated: PostgresRow[];
  try {
    updated = await db.query(`update corvis_source.source_connection set
        secret_reference=$3, status=case when status='paused' then 'paused' else 'active' end,
        consecutive_failures=0, last_error_class=null, last_authorized_at=now(), updated_at=now()
      where tenant_id=$1 and source_connection_id=$2::uuid and status<>'revoked' and secret_reference=$4
      returning status`, [identity.tenantId, sourceConnectionId, secretReference, previousReference]);
  } catch (error) {
    await dependencies.secrets.revoke(secretReference).catch(() => undefined);
    throw error;
  }
  if (updated.length === 0) {
    await dependencies.secrets.revoke(secretReference).catch(() => undefined);
    const latest = await loadConnection(db, identity.tenantId, sourceConnectionId);
    throw new ConnectorGovernanceError(requiredText(latest, "status") === "revoked" ? "connection_revoked" : "invalid_transition_from_concurrent_change");
  }
  await dependencies.secrets.revoke(previousReference).catch(() => undefined);
}

export async function testSourceConnection(
  identity: RequestIdentity,
  sourceConnectionId: string,
  dependencies: { db?: PostgresSqlApi; secrets: SecretStore; drivers: Map<string, ConnectorDriver> },
): Promise<ConnectionTestResult> {
  const db = dependencies.db ?? controlDb();
  const row = await loadConnection(db, identity.tenantId, sourceConnectionId);
  const connection = rowToConnection(row);
  if (connection.status === "revoked") throw new ConnectorGovernanceError("connection_revoked");
  const driver = dependencies.drivers.get(connection.providerKey);
  if (!driver) throw new ConnectorGovernanceError("unregistered_provider");
  const credential = await dependencies.secrets.read(connection.secretReference);
  const result = await driver.testConnection(credential, connection.sourceScope);
  // Both writes are conditioned on the status observed before the (possibly
  // slow) driver call, so a revoke or pause issued meanwhile is never
  // overwritten by this now-stale test outcome.
  if (result.ok && connection.status === "pending_authorization") {
    await db.execute(`update corvis_source.source_connection set status='active', last_authorized_at=now(), updated_at=now()
      where tenant_id=$1 and source_connection_id=$2::uuid and status='pending_authorization'`, [identity.tenantId, sourceConnectionId]);
  } else if (!result.ok && result.errorClass) {
    const nextStatus = statusAfterError(connection.status, result.errorClass, connection.consecutiveFailures);
    await db.execute(`update corvis_source.source_connection set status=$3, last_error_class=$4, updated_at=now()
      where tenant_id=$1 and source_connection_id=$2::uuid and status=$5`,
    [identity.tenantId, sourceConnectionId, nextStatus, result.errorClass, connection.status]);
  }
  return result;
}
