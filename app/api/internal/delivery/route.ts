import { timingSafeEqual } from "crypto";
import { processQueuedExports, processWebhookDeliveries } from "@/lib/server/delivery";
import { getServerConfig } from "@/lib/server/config";
import { correlationId, json } from "@/lib/server/http";
import { dispatchConfiguredProcessingTransport } from "@/lib/server/processing-transport";

function safeEqual(actual:string|null,expected?:string){if(!actual||!expected)return false;const a=Buffer.from(actual),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b);}

export async function POST(request:Request){
  const id=correlationId(request); const config=getServerConfig();
  if(!safeEqual(request.headers.get("x-corvis-worker-secret"),config.workerSecret)) return json({error:"forbidden",correlationId:id},{status:403});
  try{
    const [exportsResult,webhooksResult,processingResult]=await Promise.all([
      processQueuedExports(),processWebhookDeliveries(),dispatchConfiguredProcessingTransport(),
    ]);
    return json({data:{exports:exportsResult,webhooks:webhooksResult,processing:processingResult},correlationId:id});
  }catch(error){return json({error:"delivery_worker_failed",message:error instanceof Error?error.message:"unknown",correlationId:id},{status:500});}
}
