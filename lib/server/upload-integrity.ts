import type { UploadObjectStore } from "./gcs.ts";
import type { PostgresSqlApi } from "./postgres.ts";

export type ArtifactIntegrityInput = {
  tenantId: string;
  artifactVersionId: string;
  documentId: string;
  objectKey: string;
  /** Verified GCS generation the digest is pinned to. */
  generation?: string;
};

export type ArtifactIntegrityOutcome =
  /** Digest recorded on the artifact (and equal to any client-declared digest). */
  | { outcome: "sealed"; sha256: string }
  /** Already released by an earlier pass; nothing to hash. */
  | { outcome: "released" }
  /** Threat, invalid content or a prior integrity failure: must not be released. */
  | { outcome: "blocked" }
  /** The bytes do not match the digest declared at initiate; the artifact is now quarantined. */
  | { outcome: "integrity_failed" };

const BLOCKED_STATUSES = new Set(["threat", "integrity_failed", "invalid_content"]);

/**
 * The registered stage refuses an artifact without SHA-256 lineage, and a
 * client-declared digest is only a claim. Before an artifact is released this
 * computes the digest from the stored bytes (pinned to the verified generation),
 * refuses a release when it contradicts a declared digest, and records it on the
 * artifact row so downstream stages and evidence exports can rely on it.
 */
export async function sealArtifactIntegrity(
  store: UploadObjectStore,
  db: PostgresSqlApi,
  input: ArtifactIntegrityInput,
): Promise<ArtifactIntegrityOutcome> {
  const current = (await db.query(
    `select malware_scan_status, quarantine_status from corvis_source.document_artifact_version
      where tenant_id=$1 and document_artifact_version_id=$2::uuid`,
    [input.tenantId, input.artifactVersionId],
  ))[0];
  if (current?.quarantine_status === "released") return { outcome: "released" };
  if (current && BLOCKED_STATUSES.has(String(current.malware_scan_status))) return { outcome: "blocked" };

  const sha256 = await store.getObjectSha256(input.objectKey, input.generation);

  // Records the digest only when none is declared (declared hex is normalised to lower case);
  // reports whether an existing declaration agrees.
  const updated = (await db.query(
    `update corvis_source.document_artifact_version
        set sha256=lower(coalesce(sha256,$3))
      where tenant_id=$1 and document_artifact_version_id=$2::uuid
      returning (sha256=$3) as sha_matches`,
    [input.tenantId, input.artifactVersionId, sha256],
  ))[0];
  if (!updated) return { outcome: "blocked" };
  if (updated.sha_matches !== true) {
    await db.execute(`update corvis_source.document_artifact_version
      set malware_scan_status='integrity_failed',quarantine_status='quarantined'
      where tenant_id=$1 and document_artifact_version_id=$2::uuid`, [input.tenantId, input.artifactVersionId]);
    await db.execute(`update corvis_source.document set status='quarantined'
      where tenant_id=$1 and document_id=$2::uuid`, [input.tenantId, input.documentId]);
    return { outcome: "integrity_failed" };
  }
  return { outcome: "sealed", sha256 };
}
