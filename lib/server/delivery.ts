import { randomUUID } from "crypto";
import { getServerConfig } from "@/lib/server/config";
import { snowflake } from "@/lib/server/snowflake";
import { webhookHeaders, type WebhookEnvelope } from "@/lib/server/webhooks";

function bearer(token?: string): Record<string,string> { return token ? { authorization:`Bearer ${token}` } : {}; }

export async function processQueuedExports(limit=25): Promise<{processed:number;failed:number}> {
  const config=getServerConfig();
  if(!config.exportDeliveryEndpoint) throw new Error("Export delivery adapter is not configured");
  const rows=await snowflake().query(`SELECT TENANT_ID,EXPORT_ID,FORMAT,SNAPSHOT_IDS,MANIFEST,DELIVERY_ATTEMPTS FROM PM_SERVING.EXPORT_JOB WHERE STATE IN ('queued','retryable') ORDER BY CREATED_AT LIMIT ?`,[limit]);
  let processed=0,failed=0;
  for(const row of rows){
    const tenantId=String(row.tenant_id); const exportId=String(row.export_id);
    try{
      await snowflake().execute(`UPDATE PM_SERVING.EXPORT_JOB SET STATE='delivering',DELIVERY_ATTEMPTS=COALESCE(DELIVERY_ATTEMPTS,0)+1,LAST_ERROR=NULL WHERE TENANT_ID=? AND EXPORT_ID=?`,[tenantId,exportId]);
      const response=await fetch(`${config.exportDeliveryEndpoint.replace(/\/$/,"")}/exports`,{method:"POST",headers:{"content-type":"application/json",...bearer(config.exportDeliveryToken)},body:JSON.stringify({tenantId,exportId,format:row.format,snapshotIds:row.snapshot_ids,manifest:row.manifest}),cache:"no-store"});
      if(!response.ok) throw new Error(`Export delivery failed (${response.status})`);
      const body=await response.json() as {objectUri?:string;checksumSha256?:string;expiresAt?:string};
      if(!body.objectUri || !body.checksumSha256) throw new Error("Export delivery adapter returned incomplete result");
      await snowflake().execute(`UPDATE PM_SERVING.EXPORT_JOB SET STATE='complete',OBJECT_URI=?,EXPIRES_AT=TO_TIMESTAMP_TZ(?),CHECKSUM_SHA256=?,COMPLETED_AT=CURRENT_TIMESTAMP() WHERE TENANT_ID=? AND EXPORT_ID=?`,[body.objectUri,body.expiresAt??new Date(Date.now()+3600_000).toISOString(),body.checksumSha256,tenantId,exportId]);
      processed++;
    }catch(error){
      failed++;
      const attempts=Number(row.delivery_attempts??0)+1;
      await snowflake().execute(`UPDATE PM_SERVING.EXPORT_JOB SET STATE=?,LAST_ERROR=? WHERE TENANT_ID=? AND EXPORT_ID=?`,[attempts>=5?"failed":"retryable",error instanceof Error?error.message:"unknown",tenantId,exportId]);
    }
  }
  return {processed,failed};
}

export async function processWebhookDeliveries(limit=50): Promise<{processed:number;failed:number}> {
  const config=getServerConfig();
  if(!config.webhookSigningSecret) throw new Error("Webhook signing secret is not configured");
  const events=await snowflake().query(`SELECT E.TENANT_ID,E.EVENT_ID,E.EVENT_TYPE,E.AGGREGATE_ID,E.PAYLOAD,E.CREATED_AT,S.WEBHOOK_ID,S.ENDPOINT_URL
    FROM PM_CONTROL.OUTBOX_EVENT E JOIN PM_CONTROL.WEBHOOK_SUBSCRIPTION S ON S.TENANT_ID=E.TENANT_ID AND S.ACTIVE=TRUE
    WHERE E.PUBLISHED_AT IS NULL AND ARRAY_CONTAINS(E.EVENT_TYPE::VARIANT,S.EVENT_TYPES)
    ORDER BY E.CREATED_AT LIMIT ?`,[limit]);
  let processed=0,failed=0;
  for(const row of events){
    const tenantId=String(row.tenant_id), eventId=String(row.event_id), webhookId=String(row.webhook_id);
    const envelope:WebhookEnvelope={id:eventId,type:String(row.event_type),createdAt:String(row.created_at),tenantId,data:row.payload};
    const body=JSON.stringify(envelope); const deliveryId=randomUUID();
    try{
      const response=await fetch(String(row.endpoint_url),{method:"POST",headers:webhookHeaders(config.webhookSigningSecret,envelope),body,cache:"no-store"});
      if(!response.ok) throw new Error(`Webhook endpoint returned ${response.status}`);
      await snowflake().execute(`INSERT INTO PM_CONTROL.WEBHOOK_DELIVERY (TENANT_ID,DELIVERY_ID,WEBHOOK_ID,EVENT_ID,ATTEMPT,STATUS_CODE,STATE,CREATED_AT,COMPLETED_AT) VALUES (?,?,?,?,1,?,'complete',CURRENT_TIMESTAMP(),CURRENT_TIMESTAMP())`,[tenantId,deliveryId,webhookId,eventId,response.status]);
      await snowflake().execute(`UPDATE PM_CONTROL.OUTBOX_EVENT SET PUBLISHED_AT=CURRENT_TIMESTAMP(),ATTEMPT_COUNT=ATTEMPT_COUNT+1,LAST_ERROR=NULL WHERE TENANT_ID=? AND EVENT_ID=?`,[tenantId,eventId]);
      processed++;
    }catch(error){
      failed++;
      await snowflake().execute(`INSERT INTO PM_CONTROL.WEBHOOK_DELIVERY (TENANT_ID,DELIVERY_ID,WEBHOOK_ID,EVENT_ID,ATTEMPT,STATE,NEXT_ATTEMPT_AT,CREATED_AT) SELECT ?,?,?,?,COALESCE((SELECT MAX(ATTEMPT)+1 FROM PM_CONTROL.WEBHOOK_DELIVERY WHERE TENANT_ID=? AND WEBHOOK_ID=? AND EVENT_ID=?),1),'retryable',DATEADD('minute',5,CURRENT_TIMESTAMP()),CURRENT_TIMESTAMP()`,[tenantId,deliveryId,webhookId,eventId,tenantId,webhookId,eventId]);
      await snowflake().execute(`UPDATE PM_CONTROL.OUTBOX_EVENT SET ATTEMPT_COUNT=ATTEMPT_COUNT+1,LAST_ERROR=? WHERE TENANT_ID=? AND EVENT_ID=?`,[error instanceof Error?error.message:"unknown",tenantId,eventId]);
    }
  }
  return {processed,failed};
}
