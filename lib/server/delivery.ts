import { randomUUID } from "crypto";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { webhookHeaders, type WebhookEnvelope } from "./webhooks.ts";

function bearer(token?: string): Record<string,string> { return token ? { authorization:`Bearer ${token}` } : {}; }
function db(): PostgresSqlApi { return postgres(getServerConfig().postgresDsn); }

/**
 * Capped exponential backoff with jitter for webhook redelivery.
 *
 * Attempt 1 retries around the original flat 5-minute interval, then the
 * delay doubles per attempt (10m, 20m, 40m, ...) up to a 1-hour cap. Jitter
 * of +/-20% is applied around the (possibly capped) delay so a burst of
 * deliveries failing at the same attempt number don't all retry in
 * lockstep against a recovering endpoint.
 *
 * `random` is injectable so tests can assert exact bounds deterministically
 * instead of relying on `Math.random`.
 */
export const WEBHOOK_RETRY_BASE_DELAY_MS = 5 * 60_000;
export const WEBHOOK_RETRY_MAX_DELAY_MS = 60 * 60_000;
export const WEBHOOK_RETRY_JITTER_RATIO = 0.2;

export type RandomSource = () => number;

export function computeWebhookRetryDelayMs(attempt: number, random: RandomSource = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = WEBHOOK_RETRY_BASE_DELAY_MS * (2 ** exponent);
  const capped = Math.min(exponential, WEBHOOK_RETRY_MAX_DELAY_MS);
  const jitterRange = capped * WEBHOOK_RETRY_JITTER_RATIO;
  const jitter = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + jitter));
}

export async function processQueuedExports(limit=25): Promise<{processed:number;failed:number}> {
  const config=getServerConfig();
  if(!config.exportDeliveryEndpoint) throw new Error("Export delivery adapter is not configured");
  const store=db();
  const rows=await store.query(`select tenant_id,export_id,format,snapshot_ids,manifest,delivery_attempts
    from corvis_serving.export_job
    where state in ('queued','retryable') and coalesce(delivery_attempts,0)<5
    order by created_at limit $1`,[limit]);
  let processed=0,failed=0;
  for(const row of rows){
    const tenantId=String(row.tenant_id); const exportId=String(row.export_id);
    const priorAttempts=Number(row.delivery_attempts??0);
    const claimed=await store.query(`update corvis_serving.export_job
      set state='delivering',delivery_attempts=coalesce(delivery_attempts,0)+1,last_error=null
      where tenant_id=$1 and export_id=$2::uuid and state in ('queued','retryable') and coalesce(delivery_attempts,0)=$3
      returning delivery_attempts`,[tenantId,exportId,priorAttempts]);
    if(!claimed[0]) continue;
    const attempt=Number(claimed[0].delivery_attempts??priorAttempts+1);
    try{
      const response=await fetch(`${config.exportDeliveryEndpoint.replace(/\/$/,"")}/exports`,{
        method:"POST",headers:{"content-type":"application/json",...bearer(config.exportDeliveryToken)},
        body:JSON.stringify({tenantId,exportId,format:row.format,snapshotIds:row.snapshot_ids,manifest:row.manifest}),cache:"no-store"
      });
      if(!response.ok) throw new Error(`Export delivery failed (${response.status})`);
      const body=await response.json() as {objectUri?:string;checksumSha256?:string;expiresAt?:string};
      if(!body.objectUri || !body.checksumSha256) throw new Error("Export delivery adapter returned incomplete result");
      await store.execute(`update corvis_serving.export_job
        set state='complete',object_uri=$1,expires_at=$2::timestamptz,checksum_sha256=$3,completed_at=now()
        where tenant_id=$4 and export_id=$5::uuid and state='delivering' and delivery_attempts=$6`,
      [body.objectUri,body.expiresAt??new Date(Date.now()+3600_000).toISOString(),body.checksumSha256,tenantId,exportId,attempt]);
      processed++;
    }catch(error){
      failed++;
      await store.execute(`update corvis_serving.export_job set state=$1,last_error=$2
        where tenant_id=$3 and export_id=$4::uuid and state='delivering' and delivery_attempts=$5`,
      [attempt>=5?"failed":"retryable",error instanceof Error?error.message:"unknown",tenantId,exportId,attempt]);
    }
  }
  return {processed,failed};
}

export async function processWebhookDeliveries(limit=50, random: RandomSource = Math.random): Promise<{processed:number;failed:number}> {
  const store=db();
  const events=await store.query(`select e.tenant_id,e.event_id,e.event_type,e.aggregate_id,e.payload,e.created_at,
      s.webhook_id,s.endpoint_url,
      k.secret as signing_secret,
      coalesce((select max(d.attempt) from corvis_control.webhook_delivery d
        where d.tenant_id=e.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id),0) as prior_attempts
    from corvis_control.outbox_event e
    join corvis_control.webhook_subscription s
      on s.tenant_id=e.tenant_id and s.status='active' and e.event_type=any(s.event_types)
    join corvis_control.webhook_signing_key k
      on k.tenant_id=s.tenant_id and k.webhook_id=s.webhook_id and k.status='active'
    where e.published_at is null
      and coalesce((select max(d.attempt) from corvis_control.webhook_delivery d
        where d.tenant_id=e.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id),0)<5
      and not exists (
        select 1 from corvis_control.webhook_delivery d
        where d.tenant_id=e.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id and d.state in ('delivering','complete')
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
    const claimed=await store.query(`insert into corvis_control.webhook_delivery
      (tenant_id,delivery_id,webhook_id,event_id,attempt,state,created_at)
      values ($1,$2::uuid,$3::uuid,$4::uuid,$5,'delivering',now())
      on conflict (tenant_id,webhook_id,event_id,attempt) do nothing
      returning delivery_id`,[tenantId,deliveryId,webhookId,eventId,attempt]);
    if(!claimed[0]) continue;
    try{
      const response=await fetch(String(row.endpoint_url),{
        method:"POST",headers:webhookHeaders(String(row.signing_secret),envelope),body,cache:"no-store"
      });
      if(!response.ok) throw new Error(`Webhook endpoint returned ${response.status}`);
      await store.execute(`update corvis_control.webhook_delivery
        set status_code=$1,state='complete',completed_at=now(),next_attempt_at=null,last_error=null
        where tenant_id=$2 and delivery_id=$3::uuid and state='delivering'`,
      [response.status,tenantId,deliveryId]);
      const pending=await store.query(`select count(*) as pending_count
        from corvis_control.webhook_subscription s
        where s.tenant_id=$1 and s.status='active'
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
      const nextAttemptAt=state==="retryable"?new Date(Date.now()+computeWebhookRetryDelayMs(attempt,random)).toISOString():null;
      await store.execute(`update corvis_control.webhook_delivery
        set state=$1,next_attempt_at=$2::timestamptz,
            last_error=$3
        where tenant_id=$4 and delivery_id=$5::uuid and state='delivering'`,
      [state,nextAttemptAt,error instanceof Error?error.message:"unknown",tenantId,deliveryId]);
      await store.execute(`update corvis_control.outbox_event
        set attempt_count=attempt_count+1,last_error=$1
        where tenant_id=$2 and event_id=$3::uuid`,
      [error instanceof Error?error.message:"unknown",tenantId,eventId]);
    }
  }
  return {processed,failed};
}
