import { timingSafeEqual } from "crypto";
import { processQueuedExports, processWebhookDeliveries, settleDeliveryTasks, sweepUnsubscribedWebhookFanoutEvents } from "@/lib/server/delivery";
import { getServerConfig } from "@/lib/server/config";
import { sweepExpiredExportDownloadGrants } from "@/lib/server/export-grant-sweep";
import { processDueExportSchedules } from "@/lib/server/export-schedule";
import { apiError, correlationId, json } from "@/lib/server/http";
import { sweepExpiredIdempotencyKeys } from "@/lib/server/idempotency";
import { dispatchConfiguredProcessingTransport } from "@/lib/server/processing-transport";
import { verifyConfiguredProcessingWorkerIdentity } from "@/lib/server/processing-worker-ingress";
import { processEmailDigests, processEmailOutbox } from "@/lib/server/notifications";
import { sweepTenantExports } from "@/lib/server/tenant-export-sweep";
import { processApprovedTenantExports } from "@/lib/server/tenant-export-worker";
import { logEvent } from "@/lib/server/telemetry";
import { releaseScannedUploads } from "@/lib/server/upload-release";
import { sweepUploadSessions } from "@/lib/server/upload-sweep";

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
    // allSettled: one rejected task must not hide the others' results (their side effects already happened).
    const {results,failed}=await settleDeliveryTasks({
      exports:()=>processQueuedExports(),
      // Full tenant exports approved by a second Organization Admin (F10): same tick, same object store and artifact lifetime.
      tenantExports:()=>processApprovedTenantExports(),
      // F4: due schedule triggers become governed export requests made as the schedule's owner; the export worker above delivers them.
      exportSchedules:()=>processDueExportSchedules(),
      webhooks:()=>processWebhookDeliveries(),
      processing:()=>dispatchConfiguredProcessingTransport(processingWorkerUrl),
      webhookFanoutSweep:()=>sweepUnsubscribedWebhookFanoutEvents(),
      idempotencyKeySweep:()=>sweepExpiredIdempotencyKeys(),
      exportGrantSweep:()=>sweepExpiredExportDownloadGrants(),
      // F10f: expired tenant-export artifacts are deleted from the object store and recorded, and spent download grants removed; both audited.
      tenantExportSweep:()=>sweepTenantExports(),
      uploadRelease:()=>releaseScannedUploads(),
      uploadSweep:()=>sweepUploadSessions(),
      emailDigests:()=>processEmailDigests(),
      emailOutbox:()=>processEmailOutbox(),
    });
    // The upload sweep absorbs per-tenant failures into its summary instead of rejecting; surface them as a task failure too.
    const sweepSummary=results.uploadSweep as {errors?:unknown}|null|undefined;
    const sweepErrors=typeof sweepSummary?.errors==="number"?sweepSummary.errors:0;
    if(sweepErrors>0&&!failed.includes("uploadSweep")) failed.push("uploadSweep");
    // Likewise an artifact the sweep could not delete: the tick answers 500 so it is retried and alerted rather than silently kept.
    const exportSweep=results.tenantExportSweep as {errors?:unknown}|null|undefined;
    if(typeof exportSweep?.errors==="number"&&exportSweep.errors>0&&!failed.includes("tenantExportSweep")) failed.push("tenantExportSweep");
    for(const task of failed) logEvent("error","delivery.task_failed",{correlationId:id},{task,failure:results[task as keyof typeof results]});
    // A partial failure is still reported per task, but answers 500 so the scheduler retries and alerts.
    return json({data:results,failed,correlationId:id},{status:failed.length>0?500:200});
  }catch(error){return apiError(error,id);}
}
