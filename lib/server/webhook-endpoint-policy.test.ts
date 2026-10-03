import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { request as httpsRequest } from "node:https";
import test from "node:test";
import {
  assertWebhookEndpointAllowed,
  defaultWebhookHostLookup,
  isBlockedWebhookAddress,
  isWebhookEventType,
  policyCheckedLookup,
  policyPinnedWebhookFetch,
  PROCESSING_TRANSPORT_EVENT_TYPES,
  processingTransportEventTypesSqlList,
  WEBHOOK_EVENT_TYPES,
  webhookEndpointBlockReason,
  webhookEventTypesSqlList,
  type WebhookHostLookup,
} from "./webhook-endpoint-policy.ts";

test("transport event types are exactly what the transport claims and are never subscribable", async () => {
  const sql = await readFile("db/postgres/migrations/021_processing_transport_runtime.sql", "utf8");
  const claimed = /o\.event_type in \(([^)]*)\)/.exec(sql)?.[1]?.match(/'([A-Za-z]+)'/g)?.map((value) => value.slice(1, -1));
  assert.deepEqual([...PROCESSING_TRANSPORT_EVENT_TYPES].sort(), [...(claimed ?? [])].sort());
  for (const type of PROCESSING_TRANSPORT_EVENT_TYPES) {
    assert.equal(isWebhookEventType(type), false, `${type} must not be a webhook event type`);
    assert.equal((WEBHOOK_EVENT_TYPES as readonly string[]).includes(type), false);
  }
  assert.equal(isWebhookEventType("SnapshotPublicationChanged"), true);
  assert.equal(isWebhookEventType("constructor"), false);
});

test("internal processing signals are not subscribable and delivery only selects allow-listed types", async () => {
  for (const type of ["ProcessingStageBlocked", "ProcessingStageDeadLettered"]) {
    assert.equal(isWebhookEventType(type), false, `${type} carries internal job state and must not be a webhook event type`);
  }
  const delivery = await readFile("lib/server/delivery.ts", "utf8");
  assert.match(delivery, /e\.event_type in \(\$\{webhookEventTypesSqlList\(\)\}\)/);
  const openapi = await readFile("openapi/corvis-v1.yaml", "utf8");
  assert.match(openapi, /enum: \[SnapshotPublicationChanged, DataCorrectionOpened, DataCorrectionResolved, CorrectionReplacementDeliveryRequested, ExportRequested, ExportScheduleRunCompleted, ExportScheduleRunFailed\]/);
});

test("blocked address ranges cover loopback, private, link-local, CGNAT, metadata and IPv6 local forms", () => {
  for (const address of [
    "127.0.0.1", "10.0.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.100.100.200", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd00:ec2::254", "fe80::1", "::ffff:10.0.0.1", "[::1]",
  ]) assert.equal(isBlockedWebhookAddress(address), true, address);
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "not-an-ip"]) {
    assert.equal(isBlockedWebhookAddress(address), false, address);
  }
});

test("IPv6 transition forms that embed an IPv4 address (SIIT, 6to4, Teredo) are blocked", () => {
  for (const address of ["::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) {
    assert.equal(isBlockedWebhookAddress(address), true, address);
  }
  assert.equal(webhookEndpointBlockReason("https://[2002:a9fe:a9fe::1]/"), "endpoint_url_host_not_allowed");
  for (const address of ["2001:4860:4860::8888", "::ffff:8.8.8.8"]) assert.equal(isBlockedWebhookAddress(address), false, address);
});

test("static endpoint policy rejects non-https, credentials, internal names and IP literals", () => {
  assert.equal(webhookEndpointBlockReason("http://hooks.example.com/"), "endpoint_url_must_be_https");
  assert.equal(webhookEndpointBlockReason("https://user:pass@hooks.example.com/"), "endpoint_url_credentials_not_allowed");
  assert.equal(webhookEndpointBlockReason("https://LOCALHOST./hook"), "endpoint_url_host_not_allowed");
  assert.equal(webhookEndpointBlockReason("https://metadata.google.internal/"), "endpoint_url_host_not_allowed");
  assert.equal(webhookEndpointBlockReason("https://0x7f.1/"), "endpoint_url_host_not_allowed");
  assert.equal(webhookEndpointBlockReason("https://[::ffff:169.254.169.254]/"), "endpoint_url_host_not_allowed");
  assert.equal(webhookEndpointBlockReason("https://hooks.example.com/corvis"), undefined);
  assert.equal(webhookEndpointBlockReason("https://93.184.216.34/corvis"), undefined);
});

test("send-time policy resolves every address and refuses any internal one", async () => {
  await assertWebhookEndpointAllowed("https://hooks.example.com/", async () => [{ address: "93.184.216.34" }]);
  await assert.rejects(
    () => assertWebhookEndpointAllowed("https://hooks.example.com/", async () => [{ address: "93.184.216.34" }, { address: "fd00::1" }]),
    /resolves_to_private_address/,
  );
  await assert.rejects(() => assertWebhookEndpointAllowed("https://hooks.example.com/", async () => []), /unresolvable/);
  let looked = false;
  await assertWebhookEndpointAllowed("https://93.184.216.34/", async () => { looked = true; return []; });
  assert.equal(looked, false, "an IP literal is checked statically without DNS");
});

test("the scheduled export run events are customer-facing webhook events, and the delivery SQL selects them", () => {
  for (const type of ["ExportScheduleRunCompleted", "ExportScheduleRunFailed"]) {
    assert.equal(isWebhookEventType(type), true, type);
    assert.ok(webhookEventTypesSqlList().includes(`'${type}'`), type);
  }
  assert.equal(webhookEventTypesSqlList().split(",").length, WEBHOOK_EVENT_TYPES.length);
  assert.equal(processingTransportEventTypesSqlList().split(",").length, PROCESSING_TRANSPORT_EVENT_TYPES.length);
});

test("endpoint policy names an unparseable URL and an empty host", () => {
  assert.equal(webhookEndpointBlockReason("not a url"), "endpoint_url_invalid");
  assert.equal(webhookEndpointBlockReason("https://./hook"), "endpoint_url_invalid");
});

test("the default resolver returns every address of a name", async () => {
  const addresses = await defaultWebhookHostLookup("localhost");
  assert.ok(addresses.length > 0);
  assert.ok(addresses.every((entry) => typeof entry.address === "string"));
});

test("the connect-time lookup refuses unresolvable and private answers and hands the socket exactly what it checked", async () => {
  const run = (lookup: WebhookHostLookup, options?: { all?: boolean } | number) => new Promise<{ error: Error | null; address: unknown; family: unknown }>((resolve) => {
    policyCheckedLookup(lookup)("hooks.example.com", options, (error, address, family) => resolve({ error, address, family }));
  });
  assert.match((await run(async () => []))!.error!.message, /unresolvable/);
  assert.match((await run(async () => [{ address: "93.184.216.34" }, { address: "10.0.0.1" }]))!.error!.message, /resolves_to_private_address/);
  assert.equal((await run(async () => { throw "not an error object"; })).error!.message, "not an error object");
  assert.equal((await run(async () => { throw new Error("dns unavailable"); })).error!.message, "dns unavailable");
  assert.deepEqual(await run(async () => [{ address: "93.184.216.34" }], { all: true }), { error: null, address: [{ address: "93.184.216.34", family: 4 }], family: undefined });
  assert.deepEqual(await run(async () => [{ address: "2606:4700:4700::1111" }, { address: "93.184.216.34" }], 4), { error: null, address: "2606:4700:4700::1111", family: 6 });
  assert.deepEqual(await run(async () => [{ address: "93.184.216.34" }]), { error: null, address: "93.184.216.34", family: 4 });
  const defaulted = await new Promise<{ error: Error | null }>((resolve) => { policyCheckedLookup()("localhost", undefined, (error) => resolve({ error })); });
  assert.match(defaulted.error!.message, /resolves_to_private_address/, "the default resolver sees localhost as internal");
});

type FakeResponse = { statusCode?: number; resume: () => void; destroy: () => void };
function fakeTransport(behaviour: (respond: (response: FakeResponse) => void, request: EventEmitter) => void) {
  const seen: { url?: URL; options?: Record<string, unknown>; ended?: string | undefined } = {};
  const requestImpl = ((url: URL, options: Record<string, unknown>, onResponse: (response: FakeResponse) => void) => {
    seen.url = url;
    seen.options = options;
    const request = Object.assign(new EventEmitter(), { end: (body?: string) => { seen.ended = body; behaviour(onResponse, request); } });
    return request;
  }) as unknown as typeof httpsRequest;
  return { requestImpl, seen };
}
const answer = (statusCode?: number) => (respond: (response: FakeResponse) => void) => respond({ statusCode, resume() {}, destroy() {} });

test("the pinned fetch posts over https with the connect-time lookup, never reads the body and reports the status", async () => {
  const lookup: WebhookHostLookup = async () => [{ address: "93.184.216.34" }];
  const ok = fakeTransport(answer(204));
  const response = await policyPinnedWebhookFetch(lookup, ok.requestImpl)("https://hooks.example.com/corvis", { body: "{\"a\":1}", headers: { "x-test": "1" } });
  assert.equal(response.status, 204);
  assert.equal(ok.seen.url!.href, "https://hooks.example.com/corvis");
  assert.equal(ok.seen.ended, "{\"a\":1}");
  assert.deepEqual(ok.seen.options!.headers, { "x-test": "1", "content-length": "7" });
  assert.equal(ok.seen.options!.method, "POST");
  assert.equal(typeof ok.seen.options!.lookup, "function");

  const noBody = fakeTransport(answer(200));
  assert.equal((await policyPinnedWebhookFetch(lookup, noBody.requestImpl)(new URL("https://hooks.example.com/"), { method: "PUT", signal: AbortSignal.timeout(5000) })).status, 200);
  assert.deepEqual([noBody.seen.options!.method, noBody.seen.options!.headers, noBody.seen.ended], ["PUT", {}, undefined]);
  assert.ok(noBody.seen.options!.signal instanceof AbortSignal);

  const asRequest = fakeTransport(answer(503));
  assert.equal((await policyPinnedWebhookFetch(lookup, asRequest.requestImpl)(new Request("https://hooks.example.com/r", { method: "POST" }))).status, 503, "a redirect or error status is reported, never followed");
  assert.equal(asRequest.seen.options!.signal, undefined);
});

test("the pinned fetch refuses non-https endpoints and out-of-range statuses, and surfaces transport and abort errors", async () => {
  const lookup: WebhookHostLookup = async () => [{ address: "93.184.216.34" }];
  let used = false;
  const never = fakeTransport(() => { used = true; });
  await assert.rejects(policyPinnedWebhookFetch(lookup, never.requestImpl)("http://hooks.example.com/"), /endpoint_url_must_be_https/);
  assert.equal(used, false, "nothing is sent over http");

  for (const status of [undefined, 99, 600]) {
    const odd = fakeTransport(answer(status));
    await assert.rejects(policyPinnedWebhookFetch(lookup, odd.requestImpl)("https://hooks.example.com/"), new RegExp(`Webhook endpoint returned ${status ?? 0}`));
  }

  const broken = fakeTransport((_respond, request) => { request.emit("error", new Error("socket hang up")); });
  await assert.rejects(policyPinnedWebhookFetch(lookup, broken.requestImpl)("https://hooks.example.com/"), /socket hang up/);

  const controller = new AbortController();
  controller.abort(new DOMException("timed out", "TimeoutError"));
  const aborted = fakeTransport((_respond, request) => { request.emit("error", new Error("aborted")); });
  await assert.rejects(policyPinnedWebhookFetch(lookup, aborted.requestImpl)("https://hooks.example.com/", { signal: controller.signal }), (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
});

test("the default pinned fetch uses the real transport and refuses a private address before connecting", async () => {
  await assert.rejects(policyPinnedWebhookFetch(async () => [{ address: "10.0.0.5" }])("https://hooks.example.com/", { signal: AbortSignal.timeout(5000) }), /resolves_to_private_address/);
});
