import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Outbox event types that are internal processing-transport signals.
 *
 * `claim_processing_transport_events` (migration 021) consumes exactly these
 * types and uses `outbox_event.published_at` / `attempt_count` as its own
 * dispatch/dead-letter bookkeeping. They are never customer-facing webhook
 * events: a subscription may not name them, and webhook delivery never
 * selects them even if a legacy subscription row does.
 */
export const PROCESSING_TRANSPORT_EVENT_TYPES = [
  "DocumentRegistered",
  "ProcessingStageReady",
  "ProcessingStageRetryScheduled",
  "ProcessingJobRetryRequested",
] as const;

/**
 * Customer-facing outbox event types a tenant may subscribe a webhook to.
 * Internal processing signals (stage blocked/dead-lettered, transport events)
 * carry job ids and operator state and are deliberately not exposed.
 */
export const WEBHOOK_EVENT_TYPES = [
  "SnapshotPublicationChanged",
  "DataCorrectionOpened",
  "DataCorrectionResolved",
  "CorrectionReplacementDeliveryRequested",
  "ExportRequested",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WEBHOOK_EVENT_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(value: string): value is WebhookEventType {
  return WEBHOOK_EVENT_TYPE_SET.has(value);
}

/** SQL list literal of the customer-facing webhook event types, built from a static constant (never user input). */
export function webhookEventTypesSqlList(): string {
  return WEBHOOK_EVENT_TYPES.map((type) => `'${type}'`).join(",");
}

/** SQL list literal of the transport-only event types, built from a static constant (never user input). */
export function processingTransportEventTypesSqlList(): string {
  return PROCESSING_TRANSPORT_EVENT_TYPES.map((type) => `'${type}'`).join(",");
}

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128],
  // IPv4-compatible and NAT64 forms can smuggle an internal IPv4 address.
  // IPv4-mapped (::ffff:a.b.c.d) needs no rule: BlockList matches it against
  // the IPv4 subnets above (and a ::ffff:0:0/96 rule would block all IPv4).
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  // IPv4-translated (SIIT), 6to4 and Teredo embed an arbitrary IPv4 address too.
  ["::ffff:0:0:0", 96], ["2002::", 16], ["2001::", 32],
  ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);

/** True when `address` is an IP literal in a loopback/private/link-local/metadata/reserved range. */
export function isBlockedWebhookAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return BLOCKED_ADDRESSES.check(bare, "ipv4");
  if (family === 6) return BLOCKED_ADDRESSES.check(bare, "ipv6");
  return false;
}

/**
 * Static (no-DNS) endpoint policy, applied at subscription create time and
 * again at send time. Returns a stable reason code, or undefined when allowed.
 * WHATWG URL parsing already normalizes alternate IPv4 spellings such as
 * `https://2130706433/` or `https://0x7f.1/` to dotted-quad form.
 */
export function webhookEndpointBlockReason(endpointUrl: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(endpointUrl); } catch { return "endpoint_url_invalid"; }
  if (parsed.protocol !== "https:") return "endpoint_url_must_be_https";
  if (parsed.username || parsed.password) return "endpoint_url_credentials_not_allowed";
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return "endpoint_url_invalid";
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    return "endpoint_url_host_not_allowed";
  }
  if (isBlockedWebhookAddress(hostname)) return "endpoint_url_host_not_allowed";
  return undefined;
}

export type WebhookHostLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

export const defaultWebhookHostLookup: WebhookHostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

type NetLookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `net`/`tls` connect-time `lookup` that applies the private-address policy
 * to the exact addresses the socket is about to connect to. Checking DNS once
 * up front and letting `fetch` resolve again leaves a rebinding window (a
 * zero-TTL record that answers public first and internal second).
 */
export function policyCheckedLookup(lookup: WebhookHostLookup = defaultWebhookHostLookup) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: NetLookupCallback): void => {
    lookup(hostname).then((addresses) => {
      if (addresses.length === 0) throw new Error("webhook endpoint refused: endpoint_url_unresolvable");
      if (addresses.some((entry) => isBlockedWebhookAddress(entry.address))) {
        throw new Error("webhook endpoint refused: endpoint_url_resolves_to_private_address");
      }
      const resolved = addresses.map((entry) => ({ address: entry.address, family: isIP(entry.address) }));
      if (typeof options === "object" && options?.all) callback(null, resolved);
      else callback(null, resolved[0]!.address, resolved[0]!.family);
    }).catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ""));
  };
}

/**
 * Outbound webhook POST over `node:https` whose socket connects only to
 * policy-checked addresses (see `policyCheckedLookup`). Never follows
 * redirects, never reads the response body, and honors `init.signal`.
 * Shaped like `fetch` so tests can substitute a fake.
 */
export function policyPinnedWebhookFetch(lookup: WebhookHostLookup = defaultWebhookHostLookup): typeof fetch {
  const checkedLookup = policyCheckedLookup(lookup);
  return ((input: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "https:") { reject(new Error("webhook endpoint refused: endpoint_url_must_be_https")); return; }
    const body = typeof init.body === "string" ? init.body : undefined;
    const request = httpsRequest(url, {
      method: init.method ?? "POST",
      headers: { ...(init.headers as Record<string, string> | undefined), ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) },
      signal: init.signal ?? undefined,
      lookup: checkedLookup as never,
    }, (response) => {
      response.resume();
      response.destroy();
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 599) { reject(new Error(`Webhook endpoint returned ${status}`)); return; }
      resolve(new Response(null, { status }));
    });
    // Surface an aborted signal's own reason (e.g. the TimeoutError from AbortSignal.timeout), like fetch does.
    request.on("error", (error) => reject(init.signal?.aborted ? init.signal.reason : error));
    request.end(body);
  })) as typeof fetch;
}

/**
 * Send-time policy: the static checks plus a DNS resolution check that every
 * address the hostname currently resolves to is public. Throws on violation.
 */
export async function assertWebhookEndpointAllowed(endpointUrl: string, lookup: WebhookHostLookup = defaultWebhookHostLookup): Promise<void> {
  const reason = webhookEndpointBlockReason(endpointUrl);
  if (reason) throw new Error(`webhook endpoint refused: ${reason}`);
  const hostname = new URL(endpointUrl).hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return;
  const addresses = await lookup(hostname);
  if (addresses.length === 0) throw new Error("webhook endpoint refused: endpoint_url_unresolvable");
  if (addresses.some((entry) => isBlockedWebhookAddress(entry.address))) {
    throw new Error("webhook endpoint refused: endpoint_url_resolves_to_private_address");
  }
}
