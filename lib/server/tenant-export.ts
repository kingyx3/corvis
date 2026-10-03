import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuditEvent, RequestIdentity } from "../../core/enterprise.ts";
import {
  TENANT_EXPORT_APPROVAL_WINDOW_HOURS,
  tenantExportActions,
  tenantExportStatus,
  type TenantExportArtifact,
  type TenantExportCommand,
  type TenantExportDownload,
  type TenantExportEvent,
  type TenantExportManifest,
  type TenantExportRequest,
  type TenantExportState,
} from "../../core/tenant-export.ts";
import { DataGovernanceError } from "./data-governance.ts";
import type { GcsControlClient } from "./gcs.ts";
import { exportObjectKey } from "./physical-exports.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";

/**
 * Full tenant data export (F10, #266), Postgres side. A request, its decisions and its build live in
 * `corvis_control.tenant_export_request` and its history (migration 084). Independence of the approver is enforced in
 * the SQL function `decide_tenant_export` and again by CHECK constraints on the table, so nothing here can approve a
 * request on behalf of its requester. The build itself is `tenant-export-worker.ts`.
 */

/** What a redeemed download link resolves to: where the artifact is and what it must hash to. */
export type RedeemedTenantExport = { objectUri: string; checksumSha256: string; sizeBytes: number };

/** The bytes of an artifact, streamed from the object store (or held in memory in demo mode). */
export type TenantExportStream = { body: BodyInit; contentType: string; contentLength?: string };

export type DecisionCommand = Exclude<TenantExportCommand, { action: "prepare_download" }>;

/** Where requests live. Postgres in production, an in-memory store in demo mode; both enforce the same rules. */
export interface TenantExportBackend {
  readonly demo: boolean;
  request(identity: RequestIdentity, command: { reason: string }, db?: PostgresSqlApi): Promise<TenantExportRequest>;
  list(identity: RequestIdentity, db?: PostgresSqlApi): Promise<TenantExportRequest[]>;
  get(identity: RequestIdentity, requestId: string, db?: PostgresSqlApi): Promise<TenantExportRequest>;
  decide(identity: RequestIdentity, requestId: string, command: DecisionCommand, db?: PostgresSqlApi): Promise<TenantExportRequest>;
  /** Issues a fresh single-use, short-lived link for a complete export. */
  issueDownload(identity: RequestIdentity, requestId: string, db?: PostgresSqlApi): Promise<{ request: TenantExportRequest; download: TenantExportDownload }>;
  /** Consumes a link. Null when it is unknown, expired, already used or belongs to someone else. */
  redeemDownload(identity: RequestIdentity, requestId: string, token: string, db?: PostgresSqlApi): Promise<RedeemedTenantExport | null>;
  /** Reads the artifact for a link that was just redeemed; gives the link back when no byte could be read. */
  openArtifact(identity: RequestIdentity, requestId: string, token: string, redeemed: RedeemedTenantExport, db?: PostgresSqlApi): Promise<TenantExportStream | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean { return UUID.test(value); }

/** How long one download link works, at most (it never outlives the artifact). */
export const TENANT_EXPORT_LINK_MINUTES = 10;
/** The most recent requests listed. Requests are rare (one open at a time), so this is a ceiling, not a page size. */
export const TENANT_EXPORT_LIST_LIMIT = 50;

export function tenantExportAuditEvent(
  identity: RequestIdentity,
  correlationId: string,
  action: string,
  item: Pick<TenantExportRequest, "requestId" | "status">,
  detail: Record<string, string | number | boolean | null> = {},
): AuditEvent {
  return {
    id: randomUUID(), occurredAt: new Date().toISOString(), tenantId: identity.tenantId, workspaceId: identity.workspaceId,
    actorSubject: identity.subject, sessionId: identity.sessionId, action, targetType: "tenant_export_request", targetId: item.requestId,
    outcome: "success", correlationId, metadata: { status: item.status, ...detail },
  };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function str(row: PostgresRow, key: string): string { return String(row[key]); }
function optionalStr(row: PostgresRow, key: string): string | null { return row[key] == null ? null : String(row[key]); }
function flag(row: PostgresRow, key: string): boolean { return row[key] === true || row[key] === "true"; }

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return jsonObject(JSON.parse(value)); } catch { return {}; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The funds and documents the delivered archive holds data for, recorded at build time (never sent to clients). */
export type ArtifactScope = { fundIds: string[]; documentIds: string[] };

export function artifactScope(manifest: unknown): ArtifactScope {
  const artifact = jsonObject(jsonObject(manifest).artifact);
  const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
  return { fundIds: list(artifact.fundIds), documentIds: list(artifact.documentIds) };
}

/** The manifest a client may see: the stored one without the internal artifact scope. */
function publicManifest(manifest: unknown): TenantExportManifest {
  const copy = { ...jsonObject(manifest) };
  delete copy.artifact;
  return copy as TenantExportManifest;
}

export const REQUEST_COLUMNS = `r.request_id::text as request_id, r.state, r.reason, r.requested_by_auth_method, r.requested_by_subject,
  r.requested_at, r.approval_expires_at, r.decided_by_subject, r.decided_at, r.decision_note, r.cancelled_at, r.state_changed_at,
  r.checksum_sha256, r.size_bytes, r.artifact_expires_at, r.manifest,
  (r.state = 'pending_approval' and r.approval_expires_at <= now()) as approval_lapsed,
  (r.state = 'complete' and r.artifact_expires_at > now()) as download_available`;

export function toTenantExportRequest(row: PostgresRow, identity: RequestIdentity, history?: TenantExportEvent[]): TenantExportRequest {
  const downloadAvailable = flag(row, "download_available");
  const status = tenantExportStatus(str(row, "state"), flag(row, "approval_lapsed"), downloadAvailable);
  const requestedByMe = str(row, "requested_by_auth_method") === identity.authMethod && str(row, "requested_by_subject") === identity.subject;
  const artifact: TenantExportArtifact | null = row.checksum_sha256 == null ? null : {
    checksumSha256: str(row, "checksum_sha256"),
    sizeBytes: Number(row.size_bytes),
    expiresAt: str(row, "artifact_expires_at"),
    manifest: publicManifest(row.manifest),
  };
  const item: TenantExportRequest = {
    requestId: str(row, "request_id"),
    status,
    reason: str(row, "reason"),
    requestedBy: str(row, "requested_by_subject"),
    requestedByMe,
    requestedAt: str(row, "requested_at"),
    approvalExpiresAt: str(row, "approval_expires_at"),
    decidedBy: optionalStr(row, "decided_by_subject"),
    decidedAt: optionalStr(row, "decided_at"),
    decisionNote: optionalStr(row, "decision_note"),
    cancelledAt: optionalStr(row, "cancelled_at"),
    statusChangedAt: str(row, "state_changed_at"),
    artifact,
    actions: tenantExportActions(status, requestedByMe, downloadAvailable),
  };
  if (history) item.history = history;
  return item;
}

function toEvent(row: PostgresRow): TenantExportEvent {
  return {
    eventType: str(row, "event_type"),
    fromState: row.from_state == null ? null : str(row, "from_state") as TenantExportState,
    toState: str(row, "to_state") as TenantExportState,
    actor: str(row, "actor_subject"),
    note: optionalStr(row, "note"),
    at: str(row, "occurred_at"),
  };
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

export class PostgresTenantExportBackend implements TenantExportBackend {
  readonly demo = false;
  private readonly defaultDb: () => PostgresSqlApi;
  private readonly objectStore: () => Pick<GcsControlClient, "getObjectStream">;

  constructor(defaultDb: () => PostgresSqlApi, objectStore: () => Pick<GcsControlClient, "getObjectStream">) {
    this.defaultDb = defaultDb;
    this.objectStore = objectStore;
  }

  async request(identity: RequestIdentity, command: { reason: string }, db: PostgresSqlApi = this.defaultDb()): Promise<TenantExportRequest> {
    if (!isUuid(identity.workspaceId)) throw new DataGovernanceError("invalid_request", 400);
    let rows: PostgresRow[];
    try {
      rows = await db.query(`select ${REQUEST_COLUMNS} from corvis_control.request_tenant_export($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7) r`, [
        identity.tenantId, randomUUID(), identity.workspaceId, identity.authMethod, identity.subject, command.reason, TENANT_EXPORT_APPROVAL_WINDOW_HOURS,
      ]);
    } catch (error) {
      // Two concurrent first requests both pass the function's check and the loser hits the one-open-request index.
      // That is the same refusal as finding the other request open, not a server failure.
      if ((error as { code?: unknown } | null)?.code === "23505") throw new DataGovernanceError("data_export_already_active", 409);
      throw error;
    }
    return toTenantExportRequest(rows[0]!, identity);
  }

  async list(identity: RequestIdentity, db: PostgresSqlApi = this.defaultDb()): Promise<TenantExportRequest[]> {
    const rows = await db.query(`select ${REQUEST_COLUMNS} from corvis_control.tenant_export_request r
      where r.tenant_id = $1::uuid order by r.requested_at desc, r.request_id desc limit ${TENANT_EXPORT_LIST_LIMIT}`, [identity.tenantId]);
    return rows.map((row) => toTenantExportRequest(row, identity));
  }

  /** The request row if it exists in the caller's tenant. A missing or malformed id is the same 404. */
  private async row(identity: RequestIdentity, requestId: string, db: PostgresSqlApi): Promise<PostgresRow> {
    if (!isUuid(requestId)) throw new DataGovernanceError("data_export_not_found", 404);
    const row = (await db.query(`select ${REQUEST_COLUMNS} from corvis_control.tenant_export_request r
      where r.tenant_id = $1::uuid and r.request_id = $2::uuid`, [identity.tenantId, requestId]))[0];
    if (!row) throw new DataGovernanceError("data_export_not_found", 404);
    return row;
  }

  async get(identity: RequestIdentity, requestId: string, db: PostgresSqlApi = this.defaultDb()): Promise<TenantExportRequest> {
    const row = await this.row(identity, requestId, db);
    const events = await db.query(`select event_type, from_state, to_state, actor_subject, note, occurred_at
      from corvis_control.tenant_export_request_event where tenant_id = $1::uuid and request_id = $2::uuid order by event_seq`, [identity.tenantId, requestId]);
    return toTenantExportRequest(row, identity, events.map(toEvent));
  }

  async decide(identity: RequestIdentity, requestId: string, command: DecisionCommand, db: PostgresSqlApi = this.defaultDb()): Promise<TenantExportRequest> {
    if (!isUuid(requestId)) throw new DataGovernanceError("data_export_not_found", 404);
    const row = (await db.query(`select ${REQUEST_COLUMNS} from corvis_control.decide_tenant_export($1::uuid,$2::uuid,$3,$4,$5,$6,$7) r`, [
      identity.tenantId, requestId, command.action, identity.authMethod, identity.subject, command.note ?? null, command.expectedStatus ?? null,
    ]))[0];
    if (!row) throw new DataGovernanceError("data_export_not_found", 404);
    return toTenantExportRequest(row, identity);
  }

  /** A link is only issued while the data it covers is still redistributable, and never outlives the artifact. */
  async issueDownload(identity: RequestIdentity, requestId: string, db: PostgresSqlApi = this.defaultDb()): Promise<{ request: TenantExportRequest; download: TenantExportDownload }> {
    const row = await this.row(identity, requestId, db);
    const request = toTenantExportRequest(row, identity);
    if (!request.actions.canDownload) throw new DataGovernanceError("data_export_not_available", 409);
    await this.assertRightsStillCover(db, identity.tenantId, artifactScope(row.manifest));
    const token = randomBytes(32).toString("base64url");
    await db.execute(`delete from corvis_control.tenant_export_download_grant
      where tenant_id = $1::uuid and request_id = $2::uuid and expires_at < now() - interval '1 day'`, [identity.tenantId, requestId]);
    const grant = (await db.query(`insert into corvis_control.tenant_export_download_grant (tenant_id, request_id, subject, token_sha256, expires_at)
      select $1::uuid, $2::uuid, $3, $4, least(r.artifact_expires_at, now() + make_interval(mins => $5))
      from corvis_control.tenant_export_request r where r.tenant_id = $1::uuid and r.request_id = $2::uuid
      returning expires_at`, [identity.tenantId, requestId, identity.subject, sha256(token), TENANT_EXPORT_LINK_MINUTES]))[0]!;
    return {
      request,
      download: { downloadUrl: `/api/v1/access/data-exports/${encodeURIComponent(requestId)}/download?grant=${encodeURIComponent(token)}`, downloadExpiresAt: str(grant, "expires_at") },
    };
  }

  async redeemDownload(identity: RequestIdentity, requestId: string, token: string, db: PostgresSqlApi = this.defaultDb()): Promise<RedeemedTenantExport | null> {
    if (!isUuid(requestId) || !token || token.length > 256) return null;
    // Single use: the grant is consumed by the statement that validates it, so a replayed or concurrent redemption of
    // one token matches no row. It is bound to the subject that was issued it, the request and the artifact's life.
    const row = (await db.query(`update corvis_control.tenant_export_download_grant g set consumed_at = now()
      from corvis_control.tenant_export_request r
      where r.tenant_id = g.tenant_id and r.request_id = g.request_id
        and g.tenant_id = $1::uuid and g.request_id = $2::uuid and g.subject = $3 and g.token_sha256 = $4
        and g.expires_at > now() and g.consumed_at is null
        and r.state = 'complete' and r.artifact_expires_at > now()
      returning r.object_uri, r.checksum_sha256, r.size_bytes, r.manifest`, [identity.tenantId, requestId, identity.subject, sha256(token)]))[0];
    if (!row) return null;
    // Rights are re-checked at download, not only at build: the artifact's bytes outlive the contract terms they were built under.
    await this.assertRightsStillCover(db, identity.tenantId, artifactScope(row.manifest));
    return { objectUri: str(row, "object_uri"), checksumSha256: str(row, "checksum_sha256"), sizeBytes: Number(row.size_bytes) };
  }

  async openArtifact(identity: RequestIdentity, requestId: string, token: string, redeemed: RedeemedTenantExport, db: PostgresSqlApi = this.defaultDb()): Promise<TenantExportStream | null> {
    let object: Awaited<ReturnType<Pick<GcsControlClient, "getObjectStream">["getObjectStream"]>>;
    try {
      object = await this.objectStore().getObjectStream(exportObjectKey(redeemed.objectUri));
    } catch (error) {
      await this.restoreDownload(identity, requestId, token, db).catch(() => undefined);
      throw error;
    }
    if (!object) {
      await this.restoreDownload(identity, requestId, token, db).catch(() => undefined);
      return null;
    }
    return { body: object.body, contentType: object.contentType ?? "application/zip", ...(object.contentLength ? { contentLength: object.contentLength } : {}) };
  }

  /** Gives a consumed link back when no byte was handed over, so a transient storage fault does not force a new one. Never revives an expired link. */
  private async restoreDownload(identity: RequestIdentity, requestId: string, token: string, db: PostgresSqlApi): Promise<void> {
    await db.execute(`update corvis_control.tenant_export_download_grant set consumed_at = null
      where tenant_id = $1::uuid and request_id = $2::uuid and subject = $3 and token_sha256 = $4
        and consumed_at is not null and expires_at > now()`, [identity.tenantId, requestId, identity.subject, sha256(token)]);
  }

  /** Every fund and document the archive holds data for must still be redistributable. */
  private async assertRightsStillCover(db: PostgresSqlApi, tenantId: string, scope: ArtifactScope): Promise<void> {
    const rows = await db.query(`select resource_type, resource_id from corvis_control.tenant_export_rights($1::uuid)`, [tenantId]);
    const held = new Set(rows.map((row) => `${str(row, "resource_type")}:${str(row, "resource_id")}`));
    const required = [...scope.fundIds.map((id) => `fund:${id}`), ...scope.documentIds.map((id) => `document:${id}`)];
    if (required.some((key) => !held.has(key))) throw new DataGovernanceError("data_export_rights_changed", 409);
  }
}
