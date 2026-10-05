import { correlationId, json } from "@/lib/server/http";
import {
  executeConfiguredProcessingWorkerRequest,
  ProcessingWorkerRequestError,
} from "@/lib/server/processing-worker-ingress";
import { logEvent } from "@/lib/server/telemetry";

export async function POST(request: Request): Promise<Response> {
  const id = correlationId(request);
  try {
    const result = await executeConfiguredProcessingWorkerRequest(request);
    if (result.outcome === "busy") {
      logEvent("warn", "processing.worker_busy", { correlationId: id }, { state: result.state });
      return json({ error: "processing_worker_busy", correlationId: id }, {
        status: 503,
        headers: { "retry-after": "1" },
      });
    }
    logEvent("info", "processing.worker_delivery", { correlationId: id }, { outcome: result.outcome });
    return json({ data: result, correlationId: id });
  } catch (error) {
    if (error instanceof ProcessingWorkerRequestError) {
      logEvent("warn", "processing.worker_rejected", { correlationId: id }, { code: error.code, status: error.status });
      return json({ error: error.code, correlationId: id }, { status: error.status });
    }
    logEvent("error", "processing.worker_failed", { correlationId: id }, {
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "processing_worker_failed", correlationId: id }, { status: 500 });
  }
}
