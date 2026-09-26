import { normalizeExportRequest, type DeliveryPort, type ExportDeliveryStatus, type ExportFormat, type ExportRequest } from "@/core/delivery";
import { workspaceContextHeaders } from "../../lib/workspace-context.ts";
import type { ExportManifest } from "@/core/enterprise";

type Envelope<T> = { data: T; correlationId: string };

async function errorFrom(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string; reasons?: string[] };
  return new Error(body.reasons?.length ? `${body.error || "request_failed"}: ${body.reasons.join("; ")}` : body.error || `Request failed (${response.status})`);
}

export function createHttpDeliveryPort(apiBase = ""): DeliveryPort {
  const base = apiBase.replace(/\/$/, "");
  return {
    async createExport(format: ExportFormat, request?: ExportRequest): Promise<ExportManifest> {
      const options = normalizeExportRequest(request);
      const response = await fetch(`${base}/api/v1/exports`, {
        method: "POST",
        credentials: "include",
        headers: { ...workspaceContextHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ format, ...(options.scope ? { scope: options.scope } : {}), ...(options.source ? { source: options.source } : {}) }),
      });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as Envelope<ExportManifest>;
      return body.data;
    },
    async listExports(): Promise<ExportDeliveryStatus[]> {
      const response = await fetch(`${base}/api/v1/exports?limit=20`, { credentials: "include", cache: "no-store", headers: { ...workspaceContextHeaders(), accept: "application/json" } });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as Envelope<ExportDeliveryStatus[]>;
      return body.data;
    },
    async prepareDownload(exportId: string): Promise<ExportDeliveryStatus> {
      const response = await fetch(`${base}/api/v1/exports/${encodeURIComponent(exportId)}`, { credentials: "include", cache: "no-store", headers: { ...workspaceContextHeaders(), accept: "application/json" } });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as Envelope<ExportDeliveryStatus>;
      return body.data;
    },
  };
}
