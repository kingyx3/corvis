import { randomUUID } from "crypto";
import { deliverExportArtifact } from "./export-delivery.ts";
import { getServerConfig } from "./config.ts";
import { postgres, type PostgresSqlApi } from "./postgres.ts";
import { countMetric, durationValueMetric } from "./telemetry.ts";
import {
  assertWebhookEndpointAllowed,
  defaultWebhookHostLookup,
  policyPinnedWebhookFetch,
  processingTransportEventTypesSqlList,
  webhookEventTypesSqlList,
  type WebhookHostLookup,
} from "./webhook-endpoint-policy.ts";
import { webhookHeaders, type WebhookEnvelope } from "./webhooks.ts";

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
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** Per-request budget for one outbound webhook POST. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const EXPORT_MAX_ATTEMPTS = 5;
/**
 * A `delivering` row older than this was claimed by a worker that crashed or
 * was killed mid-delivery; nothing else would ever move it, so the next run
 * reclaims it as retryable (or failed once attempts are exhausted).
 */
export const DELIVERING_RECLAIM_AFTER_MINUTES = 10;

export type RandomSource = () => number;

function timestampMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = new Date(String(value)).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function computeWebhookRetryDelayMs(attempt: number, random: RandomSource = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const exponential = WEBHOOK_RETRY_BASE_DELAY_MS * (2 ** exponent);
  const capped = Math.min(exponential, WEBHOOK_RETRY_MAX_DELAY_MS);
  const jitterRange = capped * WEBHOOK_RETRY_JITTER_RATIO;
  const jitter = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(capped + jitter));
}

export async function reclaimStaleExportDeliveries(store: PostgresSqlApi): Promise<number> {
  const rows = await store.query(`update corvis_serving.export_job
    set state=case when coalesce(delivery_attempts,0)>=$1 then 'failed' else 'retryable' end,
        last_error='export delivery lease expired before completion'
    where state='delivering'
      and coalesce(delivery_started_at,'-infinity'::timestamptz) < now()-make_interval(mins => $2)
    returning export_id`, [EXPORT_MAX_ATTEMPTS, DELIVERING_RECLAIM_AFTER_MINUTES]);
  return rows.length;
}

export async function processQueuedExports(limit=25, store: PostgresSqlApi = db()): Promise<{processed:number;failed:number}> {
  await reclaimStaleExportDeliveries(store);
  const rows=await store.query(`select tenant_id,export_id,workspace_id,auth_method,session_id,requested_by,
      format,snapshot_ids,manifest,delivery_attempts,created_at
    from corvis_serving.export_job
    where state in ('queued','retryable') and coalesce(delivery_attempts,0)<${EXPORT_MAX_ATTEMPTS}
    order by created_at limit $1`,[limit]);
  let processed=0,failed=0;
  for(const row of rows){
    const tenantId=String(row.tenant_id); const exportId=String(row.export_id);
    const priorAttempts=Number(row.delivery_attempts??0);
    const claimed=await store.query(`update corvis_serving.export_job
      set state='delivering',delivery_attempts=coalesce(delivery_attempts,0)+1,delivery_started_at=now(),last_error=null
      where tenant_id=$1 and export_id=$2::uuid and state in ('queued','retryable') and coalesce(delivery_attempts,0)=$3
      returning delivery_attempts`,[tenantId,exportId,priorAttempts]);
    if(!claimed[0]) continue;
    const attempt=Number(claimed[0].delivery_attempts??priorAttempts+1);
    const context={correlationId:`export:${exportId}`,tenantId,workspaceId:row.workspace_id==null?undefined:String(row.workspace_id)};
    try{
      const delivered=await deliverExportArtifact(row,store);
      const completed=await store.query(`update corvis_serving.export_job
        set state='complete',object_uri=$1,expires_at=$2::timestamptz,checksum_sha256=$3,
            manifest=$4::jsonb,completed_at=now(),last_error=null
        where tenant_id=$5 and export_id=$6::uuid and state='delivering' and delivery_attempts=$7
        returning completed_at`,
      [delivered.objectUri,delivered.expiresAt,delivered.checksumSha256,JSON.stringify(delivered.manifest),tenantId,exportId,attempt]);
      const startedAt=timestampMs(row.created_at),completedAt=timestampMs(completed[0]?.completed_at);
      if(startedAt!==undefined&&completedAt!==undefined&&completedAt>=startedAt){
        durationValueMetric("delivery.export",completedAt-startedAt,context,{format:String(row.format)});
      }
      countMetric("delivery.export",1,context,{outcome:"complete",format:String(row.format)});
      processed++;
    }catch(error){
      failed++;
      const state=attempt>=EXPORT_MAX_ATTEMPTS?"failed":"retryable";
      await store.execute(`update corvis_serving.export_job set state=$1,last_error=$2
        where tenant_id=$3 and export_id=$4::uuid and state='delivering' and delivery_attempts=$5`,
      [state,error instanceof Error?error.message:"unknown",tenantId,exportId,attempt]);
      countMetric("delivery.export",1,context,{outcome:state,format:String(row.format)});
    }
  }
  return {processed,failed};
}

export type WebhookDeliveryDependencies = {
  store?: PostgresSqlApi;
  fetchImpl?: typeof fetch;
  lookup?: WebhookHostLookup;
};

/**
 * Webhook fan-out tracks its own completion on `outbox_event.webhook_fanout_completed_at`
 * (migration 043). It never reads or writes `published_at`, `attempt_count` or
 * `last_error`: those columns are the processing transport's dispatch and
 * dead-letter bookkeeping (migration 021), and sharing them let a webhook
 * success hide a document from the pipeline or a transport dispatch hide a
 * webhook retry. Transport event types are also excluded outright, and only
 * allow-listed customer-facing types are delivered even if a legacy
 * subscription row names another type. A subscription only receives events
 * raised after it was created: events with no subscriber stay pending, and a
 * new subscription must not replay the tenant's whole event history.
 */
async function markWebhookFanoutCompleteIfDone(store: PostgresSqlApi, tenantId: string, eventId: string): Promise<void> {
  await store.execute(`update corvis_control.outbox_event e
    set webhook_fanout_completed_at=now()
    where e.tenant_id=$1 and e.event_id=$2::uuid and e.webhook_fanout_completed_at is null
      and not exists (
        select 1 from corvis_control.webhook_subscription s
        where s.tenant_id=e.tenant_id and s.status='active' and e.event_type=any(s.event_types)
          and s.created_at<=e.created_at
          and not exists (
            select 1 from corvis_control.webhook_delivery d
            where d.tenant_id=s.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id
              and d.state in ('complete','failed')
          )
      )`,[tenantId,eventId]);
}

/** Upper bound on one call to {@link sweepUnsubscribedWebhookFanoutEvents}. */
export const WEBHOOK_FANOUT_SWEEP_LIMIT = 1000;

/**
 * `markWebhookFanoutCompleteIfDone` only ever runs as a side effect of
 * processing a delivery row for a matched subscription, so a customer-facing
 * event with no subscriber at all -- not one delivery ever attempted --
 * never gets a chance to be marked done and stays in
 * `outbox_processing_transport_ready_idx`'s webhook-fanout-pending partial
 * index (migration 047) forever. This sweep closes that gap directly: it
 * proves an event can never be delivered by checking there is no
 * subscription -- active *or* paused -- for its tenant+event_type created at
 * or before it, mirroring the fan-out query's own
 * `s.created_at<=e.created_at` semantics (a subscription created after the
 * event can never need it, matching `processWebhookDeliveries`'s join).
 * Paused subscriptions count as still-possibly-eligible because pause is
 * reversible (unlike revoke) and resuming does not change `created_at`, so a
 * currently-paused subscription created before the event could still be
 * resumed and pick it up later; only when no active-or-paused subscription
 * exists at all can this sweep prove nothing will ever need the event.
 * Bounded to `WEBHOOK_FANOUT_SWEEP_LIMIT` rows per call so it can never hold
 * a long-running scan or lock.
 */
export async function sweepUnsubscribedWebhookFanoutEvents(store: PostgresSqlApi = db(), limit = WEBHOOK_FANOUT_SWEEP_LIMIT): Promise<number> {
  const rows = await store.query(`update corvis_control.outbox_event e
    set webhook_fanout_completed_at=now()
    where e.event_id in (
      select e2.event_id from corvis_control.outbox_event e2
      where e2.webhook_fanout_completed_at is null
        and e2.event_type not in (${processingTransportEventTypesSqlList()})
        and e2.event_type in (${webhookEventTypesSqlList()})
        and not exists (
          select 1 from corvis_control.webhook_subscription s
          where s.tenant_id=e2.tenant_id and s.status in ('active','paused') and e2.event_type=any(s.event_types)
            and s.created_at<=e2.created_at
        )
      order by e2.created_at
      limit $1
    )
    returning e.event_id`,[limit]);
  return rows.length;
}

export async function reclaimStaleWebhookDeliveries(store: PostgresSqlApi): Promise<number> {
  const rows = await store.query(`update corvis_control.webhook_delivery
    set state=case when attempt>=$1 then 'failed' else 'retryable' end,
        next_attempt_at=case when attempt>=$1 then null else now() end,
        last_error='webhook delivery lease expired before completion'
    where state='delivering' and created_at < now()-make_interval(mins => $2)
    returning tenant_id,event_id,state`, [WEBHOOK_MAX_ATTEMPTS, DELIVERING_RECLAIM_AFTER_MINUTES]);
  for (const row of rows) {
    if (String(row.state) === "failed") await markWebhookFanoutCompleteIfDone(store, String(row.tenant_id), String(row.event_id));
  }
  return rows.length;
}

async function postWebhook(
  fetchImpl: typeof fetch,
  endpointUrl: string,
  init: { headers: Record<string, string>; body: string },
): Promise<Response> {
  const response = await fetchImpl(endpointUrl, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    cache: "no-store",
    // Never follow a redirect: the policy-checked endpoint is the only host we
    // will talk to, and a 3xx to an internal address must not be chased.
    redirect: "manual",
    signal: AbortSignal.timeout(WEBHOOK_DELIVERY_TIMEOUT_MS),
  });
  try { await response.body?.cancel(); } catch { /* body already consumed or closed */ }
  if (response.status >= 300 && response.status < 400) throw new Error(`Webhook endpoint redirect refused (${response.status})`);
  if (response.type === "opaqueredirect") throw new Error("Webhook endpoint redirect refused");
  if (!response.ok) throw new Error(`Webhook endpoint returned ${response.status}`);
  return response;
}

export async function processWebhookDeliveries(
  limit=50,
  random: RandomSource = Math.random,
  dependencies: WebhookDeliveryDependencies = {},
): Promise<{processed:number;failed:number}> {
  const store=dependencies.store ?? db();
  const lookup=dependencies.lookup ?? defaultWebhookHostLookup;
  // The default transport re-applies the address policy at connect time, closing the DNS-rebinding window.
  const fetchImpl=dependencies.fetchImpl ?? policyPinnedWebhookFetch(lookup);
  await reclaimStaleWebhookDeliveries(store);
  const events=await store.query(`select e.tenant_id,e.event_id,e.event_type,e.aggregate_id,e.payload,e.created_at,
      s.webhook_id,s.endpoint_url,
      k.secret as signing_secret,
      coalesce((select max(d.attempt) from corvis_control.webhook_delivery d
        where d.tenant_id=e.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e.event_id),0) as prior_attempts
    from corvis_control.outbox_event e
    join corvis_control.webhook_subscription s
      on s.tenant_id=e.tenant_id and s.status='active' and e.event_type=any(s.event_types)
      and s.created_at<=e.created_at
    join corvis_control.webhook_signing_key k
      on k.tenant_id=s.tenant_id and k.webhook_id=s.webhook_id and k.status='active'
    where e.webhook_fanout_completed_at is null
      and e.event_type not in (${processingTransportEventTypesSqlList()})
      and e.event_type in (${webhookEventTypesSqlList()})
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
    const context={correlationId:`webhook:${deliveryId}`,tenantId};
    const claimed=await store.query(`insert into corvis_control.webhook_delivery
      (tenant_id,delivery_id,webhook_id,event_id,attempt,state,created_at)
      values ($1,$2::uuid,$3::uuid,$4::uuid,$5,'delivering',now())
      on conflict (tenant_id,webhook_id,event_id,attempt) do nothing
      returning delivery_id`,[tenantId,deliveryId,webhookId,eventId,attempt]);
    if(!claimed[0]) continue;
    try{
      const endpointUrl=String(row.endpoint_url);
      await assertWebhookEndpointAllowed(endpointUrl,lookup);
      const response=await postWebhook(fetchImpl,endpointUrl,{headers:webhookHeaders(String(row.signing_secret),envelope),body});
      const completed=await store.query(`update corvis_control.webhook_delivery
        set status_code=$1,state='complete',completed_at=now(),next_attempt_at=null,last_error=null
        where tenant_id=$2 and delivery_id=$3::uuid and state='delivering'
        returning completed_at`,
      [response.status,tenantId,deliveryId]);
      const startedAt=timestampMs(row.created_at),completedAt=timestampMs(completed[0]?.completed_at);
      if(startedAt!==undefined&&completedAt!==undefined&&completedAt>=startedAt){
        durationValueMetric("delivery.webhook",completedAt-startedAt,context,{eventType:String(row.event_type)});
      }
      countMetric("delivery.webhook",1,context,{outcome:"complete",eventType:String(row.event_type)});
      await markWebhookFanoutCompleteIfDone(store,tenantId,eventId);
      processed++;
    }catch(error){
      failed++;
      const state=attempt>=5?"failed":"retryable";
      const nextAttemptAt=state==="retryable"?new Date(Date.now()+computeWebhookRetryDelayMs(attempt,random)).toISOString():null;
      const message=error instanceof Error?(error.name==="TimeoutError"?"Webhook endpoint timed out":error.message):"unknown";
      await store.execute(`update corvis_control.webhook_delivery
        set state=$1,next_attempt_at=$2::timestamptz,
            last_error=$3
        where tenant_id=$4 and delivery_id=$5::uuid and state='delivering'`,
      [state,nextAttemptAt,message.slice(0,2000),tenantId,deliveryId]);
      if(state==="failed") await markWebhookFanoutCompleteIfDone(store,tenantId,eventId);
      countMetric("delivery.webhook",1,context,{outcome:state,eventType:String(row.event_type)});
    }
  }
  return {processed,failed};
}
