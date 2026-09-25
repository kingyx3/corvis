import { assertPermission } from "@/core/enterprise";
import { SECTOR_TAXONOMY_VERSION, SECTORS } from "@/core/sector-taxonomy";
import { resolveAuthorizedRequestIdentity } from "@/lib/server/authorized-request";
import { apiError, correlationId, json } from "@/lib/server/http";

/**
 * The governed sector taxonomy. core/sector-taxonomy.ts is the single source;
 * migration 055 seeds the same rows into corvis_semantic.sector (enforced by
 * core/sector-taxonomy.test.ts), so this read needs no database round trip.
 */
export async function GET(request: Request) {
  const id = correlationId(request);
  try {
    const identity = await resolveAuthorizedRequestIdentity(request);
    assertPermission(identity, "observations:read");
    return json({ data: { taxonomyVersion: SECTOR_TAXONOMY_VERSION, sectors: SECTORS }, correlationId: id });
  } catch (error) { return apiError(error, id); }
}
