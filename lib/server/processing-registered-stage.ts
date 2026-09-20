import type { ProcessingStageEffectInput } from "./processing-stage-worker.ts";
import {
  BoundedProcessingStageEffectRouter,
  type ProcessingStageHandler,
} from "./processing-stage-effects.ts";
import type { PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { createConfiguredRepresentedStageHandler } from "./processing-represented-stage.ts";

export type RegisteredArtifactRecord = {
  artifactVersionId: string;
  ingestionId: string;
  objectUri: string;
  storageGeneration: string;
  sha256: string;
  sizeBytes: number;
  malwareScanStatus: string;
  quarantineStatus: string;
};

export interface RegisteredArtifactRepository {
  findReleasedArtifact(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
    ingestionId: string;
  }): Promise<RegisteredArtifactRecord | undefined>;
}

function text(row: PostgresRow, key: string): string {
  return row[key] == null ? "" : String(row[key]);
}

function requiredPayloadText(input: ProcessingStageEffectInput, key: string): string {
  const value = input.payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`registered stage requires ${key}`);
  return value.trim();
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("registered stage execution aborted");
}

export class PostgresRegisteredArtifactRepository implements RegisteredArtifactRepository {
  private readonly db: PostgresSqlApi;

  constructor(db: PostgresSqlApi) {
    this.db = db;
  }

  async findReleasedArtifact(input: {
    tenantId: string;
    documentId: string;
    artifactVersionId: string;
    ingestionId: string;
  }): Promise<RegisteredArtifactRecord | undefined> {
    const rows = await this.db.query(`select
        document_artifact_version_id, ingestion_id, object_uri, storage_generation,
        sha256, size_bytes, malware_scan_status, quarantine_status
      from corvis_source.document_artifact_version
      where tenant_id=$1::uuid
        and document_id=$2::uuid
        and document_artifact_version_id=$3::uuid
        and ingestion_id=$4
      limit 1`, [
      input.tenantId,
      input.documentId,
      input.artifactVersionId,
      input.ingestionId,
    ]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      artifactVersionId: text(row, "document_artifact_version_id"),
      ingestionId: text(row, "ingestion_id"),
      objectUri: text(row, "object_uri"),
      storageGeneration: text(row, "storage_generation"),
      sha256: text(row, "sha256"),
      sizeBytes: Number(row.size_bytes ?? -1),
      malwareScanStatus: text(row, "malware_scan_status"),
      quarantineStatus: text(row, "quarantine_status"),
    };
  }
}

export function createRegisteredArtifactStageHandler(repository: RegisteredArtifactRepository): ProcessingStageHandler {
  return async (input, signal) => {
    if (input.stage !== "registered") throw new Error(`registered artifact handler cannot execute stage ${input.stage}`);
    assertNotAborted(signal);

    const artifactVersionId = requiredPayloadText(input, "artifactVersionId");
    const ingestionId = requiredPayloadText(input, "ingestionId");
    const artifact = await repository.findReleasedArtifact({
      tenantId: input.tenantId,
      documentId: input.documentId,
      artifactVersionId,
      ingestionId,
    });

    assertNotAborted(signal);
    if (!artifact) throw new Error("registered source artifact was not found");
    if (artifact.malwareScanStatus !== "clean" || artifact.quarantineStatus !== "released") {
      throw new Error("registered source artifact is not clean and released");
    }
    if (!artifact.objectUri.startsWith("gs://")) {
      throw new Error("registered source artifact is not stored in authoritative GCS evidence");
    }
    if (!artifact.storageGeneration) throw new Error("registered source artifact is missing immutable GCS generation");
    if (!artifact.sha256) throw new Error("registered source artifact is missing SHA-256 lineage");
    if (!Number.isFinite(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      throw new Error("registered source artifact has invalid size");
    }

    return {
      artifactVersionId: artifact.artifactVersionId,
      ingestionId: artifact.ingestionId,
      storageGeneration: artifact.storageGeneration,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    };
  };
}

/**
 * Current production composition for processing-stage effects.
 *
 * Registration is always configured. Representation is configured only when the
 * keyless internal representation endpoint is bound for the environment; otherwise
 * it remains fail-closed. Later business stages remain deliberately absent until
 * their own governed handlers are implemented and tested.
 */
export function createProductionProcessingStageEffectRouter(
  db: PostgresSqlApi,
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = process.env,
): BoundedProcessingStageEffectRouter {
  const registered = createRegisteredArtifactStageHandler(new PostgresRegisteredArtifactRepository(db));
  const represented = createConfiguredRepresentedStageHandler(db, env);
  return new BoundedProcessingStageEffectRouter({
    registered,
    ...(represented ? { represented } : {}),
  }, timeoutMs);
}
