import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY, DEMO_TOKENS } from "../adapters/source-providers.ts";
import { RateLimiter } from "../../../platform/http/rate-limit.ts";

// See src/modules/sources/server/source-connections-routes.test.ts for why this loader is needed (the "@/..." route alias).
register(new URL("../../../test-support/alias-loader.mjs", import.meta.url), import.meta.url);

process.env.CORVIS_DEMO_MODE = "true";
delete process.env.CORVIS_POSTGRES_DSN;
delete process.env.CORVIS_PUBLIC_APP_URL;
process.env.CORVIS_RATE_LIMIT_REQUESTS_PER_MINUTE = "1000000";

// Demo mode must never reach a database, an object store or any provider.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call in demo mode: ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
}) as typeof fetch;
test.after(() => { globalThis.fetch = originalFetch; });
console.warn = () => undefined;
console.info = () => undefined;

const { POST: connectPost } = await import("@/app/api/v1/source-connections/connect/route");
const { POST: oauthStartPost } = await import("@/app/api/v1/source-connections/oauth/start/route");
const { POST: oauthCompletePost } = await import("@/app/api/v1/source-connections/oauth/complete/route");
const { GET: consentGet } = await import("@/app/api/v1/source-connections/oauth/demo-consent/route");
const { GET: listGet } = await import("@/app/api/v1/source-connections/route");
const { GET: activityGet } = await import("@/app/api/v1/source-connections/activity/route");
const { overrideSourceConnectLimiter } = await import("./source-connect-limits.ts");
overrideSourceConnectLimiter(new RateLimiter(1_000_000));

function request(method: string, path: string, options: { tenant: string; body?: unknown; cookie?: string }): Request {
  const headers = new Headers({ "x-corvis-demo-tenant": options.tenant, "x-corvis-demo-workspace": "workspace-1", "x-corvis-demo-subject": "demo-admin", "x-corvis-demo-roles": "admin" });
  if (options.cookie) headers.set("cookie", options.cookie);
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) { headers.set("content-type", "application/json"); init.body = JSON.stringify(options.body); }
  return new Request(`https://corvis.test${path}`, init);
}

type Connection = { sourceConnectionId: string; providerKey: string; status: string; sourceScope: Array<{ label: string; path?: string }>; nextScheduledAt?: string; lastSuccessAt?: string };
type Run = { state: string; trigger: string; acceptedCount: number; duplicateCount: number; discoveredCount: number; acquisitions: Array<{ remotePath: string; disposition: string }> };
type Activity = { sourceConnectionId: string; runs: Run[] };

const connect = (tenant: string, token: string, extra: Record<string, unknown> = {}) => connectPost(request("POST", "/api/v1/source-connections/connect", {
  tenant, body: { providerKey: DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "Our GP portal", scopeConfirmed: true, secret: { token }, ...extra },
}));
const list = async (tenant: string) => (await (await listGet(request("GET", "/api/v1/source-connections", { tenant }))).json() as { data: Connection[] }).data;
const activity = async (tenant: string) => (await (await activityGet(request("GET", "/api/v1/source-connections/activity", { tenant }))).json() as { data: Activity[] }).data;

test("an active demo connection syncs on its schedule: the first read collects, the next finds everything already collected", async () => {
  const tenant = "tenant-demo-sync";
  const created = await (await connect(tenant, DEMO_TOKENS.valid)).json() as { data: { connection: Connection } };
  const id = created.data.connection.sourceConnectionId;
  assert.equal(created.data.connection.status, "active");
  assert.equal(created.data.connection.nextScheduledAt, undefined, "not scheduled yet: due at the next collection run");

  const [connection] = (await list(tenant)).filter((entry) => entry.sourceConnectionId === id);
  assert.ok(connection!.lastSuccessAt, "the scheduler collected from it");
  assert.ok(Date.parse(connection!.nextScheduledAt!) > Date.now(), "and scheduled the next sync");
  const [run] = (await activity(tenant)).find((entry) => entry.sourceConnectionId === id)!.runs;
  assert.deepEqual([run!.state, run!.trigger, run!.discoveredCount, run!.acceptedCount], ["succeeded", "scheduled", 4, 4]);
  assert.ok(run!.acquisitions.every((acquisition) => acquisition.disposition === "accepted"));

  // Reading again before the next run is due collects nothing more.
  await list(tenant);
  assert.equal((await activity(tenant)).find((entry) => entry.sourceConnectionId === id)!.runs.length, 1);
});

test("a connection whose test failed never syncs: no run is recorded and it is never scheduled", async () => {
  const tenant = "tenant-demo-no-sync";
  const created = await (await connect(tenant, DEMO_TOKENS.unreachable)).json() as { data: { connection: Connection; test: { ok: boolean } } };
  assert.equal(created.data.test.ok, false);
  const id = created.data.connection.sourceConnectionId;
  const [connection] = (await list(tenant)).filter((entry) => entry.sourceConnectionId === id);
  assert.notEqual(connection!.status, "active");
  assert.equal(connection!.nextScheduledAt, undefined);
  assert.deepEqual((await activity(tenant)).find((entry) => entry.sourceConnectionId === id)!.runs, []);
});

test("the folders kept in the wizard are what the connection reads and what its runs collect", async () => {
  const tenant = "tenant-demo-scope";
  const created = await (await connect(tenant, DEMO_TOKENS.valid, { selectedScopeIds: ["capital-accounts"] })).json() as { data: { connection: Connection } };
  assert.deepEqual(created.data.connection.sourceScope, [{ label: "Capital account statements", path: "/Fund III/Capital accounts" }]);
  const id = created.data.connection.sourceConnectionId;
  await list(tenant);
  const [run] = (await activity(tenant)).find((entry) => entry.sourceConnectionId === id)!.runs;
  assert.equal(run!.discoveredCount, 2);
  assert.ok(run!.acquisitions.every((acquisition) => acquisition.remotePath.startsWith("/Fund III/Capital accounts/")), "nothing outside the kept folder was collected");

  const before = (await list(tenant)).length;
  for (const bad of [[], ["nope"], ["capital-accounts", "capital-accounts"]]) {
    assert.equal((await connect(tenant, DEMO_TOKENS.valid, { selectedScopeIds: bad })).status, 400);
  }
  assert.equal((await list(tenant)).length, before);
});

test("the folder choice also survives the OAuth redirect in demo mode", async () => {
  const tenant = "tenant-demo-oauth-scope";
  const started = await oauthStartPost(request("POST", "/api/v1/source-connections/oauth/start", { tenant, body: { providerKey: DEMO_OAUTH_PROVIDER_KEY, connectionLabel: "Data room", scopeConfirmed: true, selectedScopeIds: ["side-letters"] } }));
  assert.equal(started.status, 200);
  const { authorizationUrl } = (await started.json() as { data: { authorizationUrl: string } }).data;
  const consent = await consentGet(new Request(`https://corvis.test${authorizationUrl}`));
  const html = await consent.text();
  const approve = new URL([...html.matchAll(/href="([^"]+)"/g)][0]![1]!.replace(/&(?:amp|#38);/g, "&"));
  const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
  const completed = await oauthCompletePost(request("POST", "/api/v1/source-connections/oauth/complete", { tenant, cookie, body: { code: approve.searchParams.get("code"), state: approve.searchParams.get("state") } }));
  assert.equal(completed.status, 201);
  const { data } = await completed.json() as { data: { connection: Connection } };
  assert.deepEqual(data.connection.sourceScope, [{ label: "Demo side letters", path: "/Demo/Side letters" }]);
});
