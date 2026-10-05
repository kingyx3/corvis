import { randomUUID } from "crypto";
import { deleteExportAttemptArtifacts, deliverExportArtifact } from "./export-delivery.ts";
import { getServerConfig } from "../../../platform/config/config.ts";
import type { GcsControlClient } from "../../../platform/gcp/gcs.ts";
import { notifyScheduledExportOutcome } from "./export-schedule-notifications.ts";
import { bestEffortNotification, enqueueExportReady } from "../../notifications/server/notifications.ts";
import { postgres, type PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { errorClassOf, safeErrorText } from "../../processing/server/processing-error-text.ts";
import { countMetric, durationValueMetric } from "../../../platform/observability/telemetry.ts";
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
/** Export retry backoff: 1m, 2m, 4m, 8m (capped at 15m) with +/-20% jitter. */
export const EXPORT_RETRY_BASE_DELAY_MS = 60_000;
export const EXPORT_RETRY_MAX_DELAY_MS = 15 * 60_000;
export const EXPORT_RETRY_JITTER_RATIO = 0.2;
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

/** Capped exponential backoff with jitter for a failed export attempt (`attempt` is 1-based). */
export function computeExportRetryDelayMs(attempt: number, random: RandomSource = Math.random): number {
  const exponential = EXPORT_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
  const capped = Math.min(exponential, EXPORT_RETRY_MAX_DELAY_MS);
  const jitter = (random() * 2 - 1) * capped * EXPORT_RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(capped + jitter));
}

export type DeliveryTaskFailure = { error: string; message: string };

/**
 * Runs the independent delivery-tick tasks with `allSettled` so one rejection
 * never hides the others' results (their side effects have already happened).
 * A failed task is reported as `{ error, message }` with a stable class and a
 * redacted message; `failed` lists the task names that rejected.
 */
export async function settleDeliveryTasks<T extends Record<string, () => Promise<unknown>>>(tasks: T): Promise<{
  results: { [K in keyof T]: Awaited<ReturnType<T[K]>> | DeliveryTaskFailure };
  failed: string[];
}> {
  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(names.map((name) => tasks[name]!()));
  const results: Record<string, unknown> = {};
  const failed: string[] = [];
  settled.forEach((outcome, index) => {
    const name = names[index]!;
    if (outcome.status === "fulfilled") { results[name] = outcome.value; return; }
    failed.push(name);
    results[name] = { error: errorClassOf(outcome.reason), message: safeErrorText(outcome.reason) } satisfies DeliveryTaskFailure;
  });
  return { results: results as { [K in keyof T]: Awaited<ReturnType<T[K]>> | DeliveryTaskFailure }, failed };
}

export async function reclaimStaleExportDeliveries(store: PostgresSqlApi): Promise<number> {
  const rows = await store.query(`update corvis_serving.export_job
    set state=case when coalesce(delivery_attempts,0)>=$1 then 'failed' else 'retryable' end,
        last_error='export delivery lease expired before completion'
    where state='delivering'
      and coalesce(delivery_started_at,'-infinity'::timestamptz) < now()-make_interval(mins => $2)
    returning tenant_id,export_id,state`, [EXPORT_MAX_ATTEMPTS, DELIVERING_RECLAIM_AFTER_MINUTES]);
  // An export that just ran out of attempts is final: a scheduled run behind it ends in a failure notice (F4b).
  for (const row of rows) {
    if (String(row.state) === "failed") await notifyScheduledExportOutcome(store, { tenantId: String(row.tenant_id), exportId: String(row.export_id), outcome: "failed" });
  }
  return rows.length;
}

export async function processQueuedExports(limit=25, store: PostgresSqlApi = db(), random: RandomSource = Math.random, objectStore?: Pick<GcsControlClient,"bucket"|"putObject"|"deleteObject">): Promise<{processed:number;failed:number}> {
  await reclaimStaleExportDeliveries(store);
  const rows=await store.query(`select tenant_id,export_id,workspace_id,auth_method,session_id,requested_by,
      format,snapshot_ids,manifest,delivery_attempts,created_at
    from corvis_serving.export_job
    where state in ('queued','retryable') and coalesce(delivery_attempts,0)<${EXPORT_MAX_ATTEMPTS}
      and coalesce(delivery_next_attempt_at,'-infinity'::timestamptz) <= now()
    order by created_at limit $1`,[limit]);
  let processed=0,failed=0;
  for(const row of rows){
    const tenantId=String(row.tenant_id); const exportId=String(row.export_id);
    const priorAttempts=Number(row.delivery_attempts??0);
    const claimed=await store.query(`update corvis_serving.export_job
      set state='delivering',delivery_attempts=coalesce(delivery_attempts,0)+1,delivery_started_at=now(),delivery_next_attempt_at=null,last_error=null
      where tenant_id=$1 and export_id=$2::uuid and state in ('queued','retryable') and coalesce(delivery_attempts,0)=$3
      returning delivery_attempts`,[tenantId,exportId,priorAttempts]);
    if(!claimed[0]) continue;
    const attempt=Number(claimed[0].delivery_attempts??priorAttempts+1);
    const context={correlationId:`export:${exportId}`,tenantId,workspaceId:row.workspace_id==null?undefined:String(row.workspace_id)};
    try{
      const delivered=await deliverExportArtifact(row,store,objectStore,{attempt});
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
      // A scheduled run behind this export ends in a completion event for webhook subscribers, and its owner's ready email
      // follows that schedule's switch (F4b); any other export is a no-op here and always emails its requester.
      const scheduled=completed[0]?await notifyScheduledExportOutcome(store,{tenantId,exportId,outcome:"complete"}):{ownerEmails:false};
      if(completed[0]&&scheduled.ownerEmails) await bestEffortNotification(store,`export_ready:${exportId}`,()=>enqueueExportReady(store,{
        // deliverExportArtifact only resolves after required() has rejected a null or blank workspace_id,
        // auth_method and requested_by, so none of them can be absent here.
        tenantId,exportId,workspaceId:String(row.workspace_id),
        authMethod:String(row.auth_method),subject:String(row.requested_by),format:String(row.format),
      }));
      // Objects written by earlier (failed or abandoned) attempts are no longer referenced.
      if(attempt>1&&completed[0]) await deleteExportAttemptArtifacts(row,Array.from({length:attempt-1},(_,i)=>i+1),objectStore).catch(()=>undefined);
      processed++;
    }catch(error){
      failed++;
      // Deterministic failures (e.g. the row cap) can never succeed on retry.
      const permanent=(error as {retryable?:unknown}|null)?.retryable===false;
      const state=permanent||attempt>=EXPORT_MAX_ATTEMPTS?"failed":"retryable";
      const nextAttemptAt=state==="retryable"?new Date(Date.now()+computeExportRetryDelayMs(attempt,random)).toISOString():null;
      // Best effort: remove whatever this attempt may have written so retries do not orphan objects.
      await deleteExportAttemptArtifacts(row,attempt,objectStore).catch(()=>undefined);
      await store.execute(`update corvis_serving.export_job set state=$1,last_error=$2,delivery_next_attempt_at=$6::timestamptz
        where tenant_id=$3 and export_id=$4::uuid and state='delivering' and delivery_attempts=$5`,
      [state,safeErrorText(error),tenantId,exportId,attempt,nextAttemptAt]);
      countMetric("delivery.export",1,context,{outcome:state,format:String(row.format)});
      // Final failure of an export a schedule requested ends the run in a failure notice (F4b).
      if(state==="failed") await notifyScheduledExportOutcome(store,{tenantId,exportId,outcome:"failed"});
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
 * new subscription must not replay the tenant's whole event history. A paused
 * subscription still holds its pending events open (pause is reversible and
 * resuming keeps `created_at`), exactly as the unsubscribed-event sweep below
 * treats it, so resuming never silently loses an event another subscriber
 * already finished.
 */
async function markWebhookFanoutCompleteIfDone(store: PostgresSqlApi, tenantId: string, eventId: string): Promise<void> {
  await store.execute(`update corvis_control.outbox_event e
    set webhook_fanout_completed_at=now()
    where e.tenant_id=$1 and e.event_id=$2::uuid and e.webhook_fanout_completed_at is null
      and not exists (
        select 1 from corvis_control.webhook_subscription s
        where s.tenant_id=e.tenant_id and s.status in ('active','paused') and e.event_type=any(s.event_types)
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
 * resumed and pick it up later; only when every active-or-paused subscription
 * has already finished (complete or failed) its delivery of the event, which
 * includes there being none at all, can this sweep prove nothing will ever
 * need it. That also releases an event whose last pending subscriber was
 * revoked after the other subscribers finished: completion is otherwise only
 * re-evaluated as a side effect of processing a delivery row, which a revoked
 * subscriber never gets. Bounded to `WEBHOOK_FANOUT_SWEEP_LIMIT` rows per call so it can never hold
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
            and not exists (
              select 1 from corvis_control.webhook_delivery d
              where d.tenant_id=s.tenant_id and d.webhook_id=s.webhook_id and d.event_id=e2.event_id
                and d.state in ('complete','failed')
            )
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
    // pg returns timestamptz as "2026-09-29 10:11:12.123456+00"; customers receive RFC 3339.
    const createdMs=timestampMs(row.created_at);
    const envelope:WebhookEnvelope={id:eventId,type:String(row.event_type),createdAt:createdMs===undefined?String(row.created_at):new Date(createdMs).toISOString(),tenantId,data:row.payload};
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
      const message=error instanceof Error&&error.name==="TimeoutError"?"Webhook endpoint timed out":safeErrorText(error);
      await store.execute(`update corvis_control.webhook_delivery
        set state=$1,next_attempt_at=$2::timestamptz,
            last_error=$3
        where tenant_id=$4 and delivery_id=$5::uuid and state='delivering'`,
      [state,nextAttemptAt,message,tenantId,deliveryId]);
      if(state==="failed") await markWebhookFanoutCompleteIfDone(store,tenantId,eventId);
      countMetric("delivery.webhook",1,context,{outcome:state,eventType:String(row.event_type)});
    }
  }
  return {processed,failed};
}
