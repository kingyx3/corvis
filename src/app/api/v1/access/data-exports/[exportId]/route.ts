import { parseTenantExportCommand } from "@/modules/delivery/domain/tenant-export";
import { readJsonObject } from "@/modules/identity-access/server/request/admin-request";
import { dataGovernanceErrorResponse, resolveOrganizationAdmin } from "@/modules/governance/server/lifecycle/data-governance";
import { correlationId, json } from "@/platform/http/api/http";
import { tenantExportService } from "@/modules/delivery/server/tenant-export/tenant-export-service";

/** One request with its status history. */
export async function GET(request: Request, context: { params: Promise<{ exportId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const { exportId } = await context.params;
    return json({ data: await tenantExportService().get(identity, exportId), correlationId: id });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}

/**
 * `{ action: "approve" | "reject" | "cancel", note?, expectedStatus? }` decides the request: approve and reject need a
 * different Organization Admin than the requester (`403 data_export_independent_approver_required`, enforced in SQL),
 * reject needs a note, and only the requester may cancel. `{ action: "prepare_download" }` issues a fresh single-use,
 * short-lived link for a completed export; the link itself is `GET .../download?grant=...`.
 */
export async function POST(request: Request, context: { params: Promise<{ exportId: string }> }) {
  const id = correlationId(request);
  try {
    const identity = await resolveOrganizationAdmin(request);
    const { exportId } = await context.params;
    const command = parseTenantExportCommand(await readJsonObject(request));
    const service = tenantExportService();
    if (command.action === "prepare_download") return json({ data: await service.prepareDownload(identity, exportId, id), correlationId: id });
    return json({ data: await service.decide(identity, exportId, command, id), correlationId: id });
  } catch (error) { return dataGovernanceErrorResponse(error, id); }
}
