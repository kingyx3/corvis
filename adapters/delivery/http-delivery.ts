import type { DeliveryPort, ExportDeliveryStatus, ExportFormat } from "@/core/delivery";
import type { ExportManifest } from "@/core/enterprise";

type Envelope<T> = { data: T; correlationId: string };

async function errorFrom(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as { error?: string; reasons?: string[] };
  return new Error(body.reasons?.length ? `${body.error || "request_failed"}: ${body.reasons.join("; ")}` : body.error || `Request failed (${response.status})`);
}

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
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as Envelope<ExportManifest>;
      return body.data;
    },
    async listExports(): Promise<ExportDeliveryStatus[]> {
      const response = await fetch(`${base}/api/v1/exports?limit=20`, { credentials: "include", cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) throw await errorFrom(response);
      const body = await response.json() as Envelope<ExportDeliveryStatus[]>;
      return body.data;
    },
  };
}
