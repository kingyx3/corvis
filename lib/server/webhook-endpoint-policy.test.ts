import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertWebhookEndpointAllowed,
  isBlockedWebhookAddress,
  isWebhookEventType,
  PROCESSING_TRANSPORT_EVENT_TYPES,
  WEBHOOK_EVENT_TYPES,
  webhookEndpointBlockReason,
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
  assert.match(openapi, /enum: \[SnapshotPublicationChanged, DataCorrectionOpened, DataCorrectionResolved, CorrectionReplacementDeliveryRequested, ExportRequested\]/);
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
