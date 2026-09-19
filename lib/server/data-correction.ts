import { createHash, randomUUID } from "crypto";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresRow, type PostgresSqlApi } from "./postgres.ts";

export type OpenDataCorrectionCommand = {
  idempotencyKey: string;
  fundId: string;
  reportPeriod: string;
  metricCode?: string;
  snapshotId?: string;
  snapshotVersion?: number;
  documentId?: string;
  rootCause: string;
  correctionIntent: string;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function requestHash(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
function required(value: string, name: string, max = 2000): string {
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error(`${name} is required and must be at most ${max} characters`);
  return clean;
}

export class PostgresDataCorrectionRepository {
  constructor(private readonly db: PostgresSqlApi) {}

  list(identity: RequestIdentity): Promise<PostgresRow[]> {
    return this.db.query(`select incident_id,idempotency_key,fund_id,report_period,metric_code,snapshot_id,snapshot_version,
      document_id,state,root_cause,correction_intent,opened_by,opened_at,replay_job_id,replacement_snapshot_id,
      replacement_snapshot_version,resolved_by,resolved_at,resolution_evidence
      from corvis_control.data_correction_incident where tenant_id=$1 order by opened_at desc limit 500`, [identity.tenantId]);
  }

  async open(identity: RequestIdentity, command: OpenDataCorrectionCommand): Promise<{ incidentId: string; state: string }> {
    const normalized = {
      idempotencyKey: required(command.idempotencyKey, "idempotencyKey", 256),
      fundId: required(command.fundId, "fundId", 512),
      reportPeriod: required(command.reportPeriod, "reportPeriod", 128),
      metricCode: command.metricCode?.trim() || null,
      snapshotId: command.snapshotId?.trim() || null,
      snapshotVersion: command.snapshotVersion ?? null,
      documentId: command.documentId?.trim() || null,
      rootCause: required(command.rootCause, "rootCause"),
      correctionIntent: required(command.correctionIntent, "correctionIntent"),
    };
    const incidentId = randomUUID();
    const rows = await this.db.query(`select * from corvis_control.open_data_correction_incident(
      $1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::uuid,$9,$10::uuid,$11,$12,$13)`, [
      identity.tenantId,incidentId,normalized.idempotencyKey,requestHash(normalized),normalized.fundId,normalized.reportPeriod,
      normalized.metricCode,normalized.snapshotId,normalized.snapshotVersion,normalized.documentId,normalized.rootCause,
      normalized.correctionIntent,identity.subject,
    ]);
    const row = rows[0];
    if (!row) throw new Error("correction incident was not created");
    return { incidentId: String(row.incident_id), state: String(row.state) };
  }

  async replay(identity: RequestIdentity, incidentId: string): Promise<{ jobId: string }> {
    const rows = await this.db.query(`select corvis_control.request_data_correction_replay($1::uuid,$2::uuid,$3) as job_id`,
      [identity.tenantId,incidentId,identity.subject]);
    const jobId = String(rows[0]?.job_id ?? "");
    if (!jobId) throw new Error("correction incident not found");
    return { jobId };
  }

  async resolve(identity: RequestIdentity, input: { incidentId: string; replacementSnapshotId: string; replacementSnapshotVersion: number; evidence?: Record<string, unknown> }): Promise<void> {
    const rows = await this.db.query(`select corvis_control.resolve_data_correction_incident(
      $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb) as resolved`, [identity.tenantId,input.incidentId,
      input.replacementSnapshotId,input.replacementSnapshotVersion,identity.subject,JSON.stringify(input.evidence ?? {})]);
    if (rows[0]?.resolved !== true && rows[0]?.resolved !== "true") throw new Error("correction incident not found");
  }
}

let singleton: PostgresDataCorrectionRepository | undefined;
export function dataCorrectionRepository(dsn = getServerConfig().postgresDsn): PostgresDataCorrectionRepository {
  if (!singleton) singleton = new PostgresDataCorrectionRepository(postgres(dsn));
  return singleton;
}
