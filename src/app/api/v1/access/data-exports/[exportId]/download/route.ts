import { dataGovernanceErrorResponse, resolveOrganizationAdmin } from "@/modules/governance/server/data-governance";
import { correlationId, json } from "@/platform/http/http";
import { tenantExportService } from "@/modules/delivery/server/tenant-export-service";

/**
 * Redeems a single-use download link (issued by `POST /data-exports/{exportId}` with `prepare_download`) and streams the
 * archive. The link is bound to the Organization Admin it was issued to, expires with the artifact (and after ten
 * minutes at most), and is checked against the organization's current data rights before a byte is sent.
 */
export async function GET(request: Request, context: { params: Promise<{ exportId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const { exportId } = await context.params;
    const grant = new URL(request.url).searchParams.get("grant") ?? "";
    const download = await tenantExportService().download(identity, exportId, grant, id);
    if (!download) return json({ error: "not_found", correlationId: id }, { status: 404 });
    return new Response(download.body, {
      status: 200,
      headers: {
        "content-type": download.contentType,
        ...(download.contentLength ? { "content-length": download.contentLength } : {}),
        "content-disposition": `attachment; filename="${download.filename}"`,
        "cache-control": "private, no-store, max-age=0",
        "x-content-type-options": "nosniff",
        "x-corvis-checksum-sha256": download.checksumSha256,
        "x-correlation-id": id,
      },
    });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}

/**
 * Next.js would otherwise answer HEAD with the GET handler, and a probe (link checker, download manager) would consume
 * the single-use link without receiving the file.
 */
export async function HEAD(request: Request) {
  return new Response(null, { status: 405, headers: { allow: "GET", "x-correlation-id": correlationId(request) } });
}
