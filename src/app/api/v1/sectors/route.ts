import { assertPermission } from "@/shared/domain/enterprise";
import { SECTOR_TAXONOMY_VERSION, SECTORS } from "@/modules/workspace/domain/sector-taxonomy";
import { resolveAuthorizedRequestIdentity } from "@/platform/http/authorized-request";
import { apiError, correlationId, json } from "@/platform/http/http";

/**
 * The governed sector taxonomy. src/modules/workspace/domain/sector-taxonomy.ts is the single source;
 * migration 055 seeds the same rows into corvis_semantic.sector (enforced by
 * src/modules/workspace/domain/sector-taxonomy.test.ts), so this read needs no database round trip.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return json({ data: { taxonomyVersion: SECTOR_TAXONOMY_VERSION, sectors: SECTORS }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
