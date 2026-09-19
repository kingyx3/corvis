import { randomUUID } from "crypto";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { webhookHeaders, type WebhookEnvelope } from "./webhooks.ts";

function bearer(token?: string): Record<string,string> { return token ? { authorization:`Bearer ${token}` } : {}; }
function db(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

export async function processQueuedExports(limit=25): Promise<{processed:number;failed:number}> {
  const config=getServerConfig();
  if(!config.exportDeliveryEndpoint) throw new Error("Export delivery adapter is not configured");
  const store=db();
  const rows=await store.query(`select tenant_id,export_id,format,snapshot_ids,manifest,delivery_attempts
    from corvis_serving.export_job
    where state in ('queued','retryable')
    order by created_at limit $1`,[limit]);
  let processed=0,failed=0;
  for(const row of rows){
    const tenantId=String(row.tenant_id); const exportId=String(row.export_id);
    try{
      await store.execute(`update corvis_serving.export_job
        set state='delivering',delivery_attempts=coalesce(delivery_attempts,0)+1,last_error=null
        where tenant_id=$1 and export_id=$2::uuid`,[tenantId,exportId]);
      const response=await fetch(`${config.exportDeliveryEndpoint.replace(/\/$/,"")}/exports`,{
        method:"POST",headers:{"content-type":"application/json",...bearer(config.exportDeliveryToken)},
        body:JSON.stringify({tenantId,exportId,format:row.format,snapshotIds:row.snapshot_ids,manifest:row.manifest}),cache:"no-store"
      });
      if(!response.ok) throw new Error(`Export delivery failed (${response.status})`);
      const body=await response.json() as {objectUri?:string;checksumSha256?:string;expiresAt?:string};
      if(!body.objectUri || !body.checksumSha256) throw new Error("Export delivery adapter returned incomplete result");
      await store.execute(`update corvis_serving.export_job
        set state='complete',object_uri=$1,expires_at=$2::timestamptz,checksum_sha256=$3,completed_at=now()
        where tenant_id=$4 and export_id=$5::uuid`,
      [body.objectUri,body.expiresAt??new Date(Date.now()+3600_000).toISOString(),body.checksumSha256,tenantId,exportId]);
      processed++;
    }catch(error){
      failed++;
      const attempts=Number(row.delivery_attempts??0)+1;
      await store.execute(`update corvis_serving.export_job set state=$1,last_error=$2
        where tenant_id=$3 and export_id=$4::uuid`,
      [attempts>=5?"failed":"retryable",error instanceof Error?error.message:"unknown",tenantId,exportId]);
    }
  }
  return {processed,failed};
}

export async function processWebhookDeliveries(limit=50): Promise<{processed:number;failed:number}> {
  const config=getServerConfig();
  if(!config.webhookSigningSecret) throw new Error("Webhook signing secret is not configured");
  const store=db();
  const events=await store.query(`select e.tenant_id,e.event_id,e.event_type,e.aggregate_id,e.payload,e.created_at,
      s.webhook_id,s.endpoint_url,
      coalesce((select max(d.attempt) from corvis_control.webhook_delivery d
        where d.tenant_id=e.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id),0) as prior_attempts
    from corvis_control.outbox_event e
    join corvis_control.webhook_subscription s
      on s.tenant_id=e.tenant_id and s.active=true and e.event_type=any(s.event_types)
    where e.published_at is null
      and not exists (
        select 1 from corvis_control.webhook_delivery d
        where d.tenant_id=e.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id and d.state='complete'
      )
      and coalesce((
        select max(d.next_attempt_at) from corvis_control.webhook_delivery d
        where d.tenant_id=e.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id and d.state='retryable'
      ), now()) <= now()
    order by e.created_at limit $1`,[limit]);
  let processed=0,failed=0;
  for(const row of events){
    const tenantId=String(row.tenant_id), eventId=String(row.event_id), webhookId=String(row.webhook_id);
    const envelope:WebhookEnvelope={id:eventId,type:String(row.event_type),createdAt:String(row.created_at),tenantId,data:row.payload};
    const body=JSON.stringify(envelope); const deliveryId=randomUUID();
    const attempt=Number(row.prior_attempts??0)+1;
    try{
      const response=await fetch(String(row.endpoint_url),{
        method:"POST",headers:webhookHeaders(config.webhookSigningSecret,envelope),body,cache:"no-store"
      });
      if(!response.ok) throw new Error(`Webhook endpoint returned ${response.status}`);
      await store.execute(`insert into corvis_control.webhook_delivery
        (tenant_id,delivery_id,webhook_id,event_id,attempt,status_code,state,created_at,completed_at)
        values ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,'complete',now(),now())`,
      [tenantId,deliveryId,webhookId,eventId,attempt,response.status]);
      const pending=await store.query(`select count(*) as pending_count
        from corvis_control.webhook_subscription s
        where s.tenant_id=$1 and s.active=true
          and $2=any(s.event_types)
          and not exists (
            select 1 from corvis_control.webhook_delivery d
            where d.tenant_id=s.tenant_id and d.webhook_id=s.webhook_id and d.event_id=$3::uuid and d.state='complete'
          )`,[tenantId,String(row.event_type),eventId]);
      if(Number(pending[0]?.pending_count??0)===0){
        await store.execute(`update corvis_control.outbox_event
          set published_at=now(),attempt_count=attempt_count+1,last_error=null
          where tenant_id=$1 and event_id=$2::uuid`,[tenantId,eventId]);
      }
      processed++;
    }catch(error){
      failed++;
      const state=attempt>=5?"failed":"retryable";
      await store.execute(`insert into corvis_control.webhook_delivery
        (tenant_id,delivery_id,webhook_id,event_id,attempt,state,next_attempt_at,created_at,last_error)
        values ($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,case when $6='retryable' then now()+interval '5 minutes' else null end,now(),$7)`,
      [tenantId,deliveryId,webhookId,eventId,attempt,state,error instanceof Error?error.message:"unknown"]);
      await store.execute(`update corvis_control.outbox_event
        set attempt_count=attempt_count+1,last_error=$1
        where tenant_id=$2 and event_id=$3::uuid`,
      [error instanceof Error?error.message:"unknown",tenantId,eventId]);
    }
  }
  return {processed,failed};
}
