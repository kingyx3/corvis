import type { DeliveryPort, ExportFormat } from "@/core/delivery";
import type { ExportManifest } from "@/core/enterprise";

type Envelope<T> = { data: T; correlationId: string };

export function createHttpDeliveryPort(apiBase = ""): DeliveryPort {
  const base = apiBase.replace(/\/$/, "");
  return {
    async createExport(format: ExportFormat): Promise<ExportManifest> {
      const response = await fetch(`${base}/api/v1/exports`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; reasons?: string[] };
        throw new Error(body.reasons?.length ? `${body.error || "export_failed"}: ${body.reasons.join("; ")}` : body.error || `Export request failed (${response.status})`);
      }
      const body = await response.json() as Envelope<ExportManifest>;
      return body.data;
    },
  };
}
