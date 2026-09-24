import { timingSafeEqual } from "crypto";
import { processQueuedExports, processWebhookDeliveries, sweepUnsubscribedWebhookFanoutEvents } from "@/lib/server/delivery";
import { getServerConfig } from "@/lib/server/config";
import { apiError, correlationId, json } from "@/lib/server/http";
import { sweepExpiredIdempotencyKeys } from "@/lib/server/idempotency";
import { dispatchConfiguredProcessingTransport } from "@/lib/server/processing-transport";
import { verifyConfiguredProcessingWorkerIdentity } from "@/lib/server/processing-worker-ingress";

function safeEqual(actual:string|null,expected?:string){if(!actual||!expected)return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}

async function authorizedWorker(request: Request): Promise<boolean> {
  const config = getServerConfig();
  try {
    await verifyConfiguredProcessingWorkerIdentity(request);
    return true;
  } catch {
    // Local/test compatibility only. Production service-to-service calls are
    // authenticated with Google OIDC and never depend on a shared header secret.
    return config.environment !== "production" && safeEqual(request.headers.get("x-corvis-worker-secret"), config.workerSecret);
  }
}

export async function POST(request:Request){
  const id=correlationId(request);
  if(!await authorizedWorker(request)) return json({error:"forbidden",correlationId:id},{status:403});
  try{
    // This route runs on the private worker service. Derive its exact provider
    // URL from the authenticated request instead of hard-coding a run.app host
    // or introducing a self-referential Terraform environment variable.
    const processingWorkerUrl = new URL("/api/internal/processing-stage", request.url).toString();
    const [exportsResult,webhooksResult,processingResult,webhookFanoutSweep,idempotencyKeySweep]=await Promise.all([
      processQueuedExports(),processWebhookDeliveries(),dispatchConfiguredProcessingTransport(processingWorkerUrl),
      sweepUnsubscribedWebhookFanoutEvents(),sweepExpiredIdempotencyKeys(),
    ]);
    return json({data:{exports:exportsResult,webhooks:webhooksResult,processing:processingResult,webhookFanoutSweep,idempotencyKeySweep},correlationId:id});
  }catch(error){return apiError(error,id);}
}
