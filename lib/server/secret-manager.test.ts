import assert from "node:assert/strict";
import test from "node:test";
import {
  GcpSecretManagerSecretStore,
  SECRET_MANAGER_REQUEST_TIMEOUT_MS,
  selectSourceConnectorSecretStore,
  sourceConnectorSecretReference,
  sourceConnectorSecretStore,
  sourceConnectorDrivers,
  sweepExpiredSourceSecrets,
} from "./source-connector-runtime.ts";
import type { SecretStore } from "./source-connectors.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const PROJECT_ID = "corvis-uat-98213";
const CONSTRAINT = new RegExp(
  `^projects/[a-z0-9][a-z0-9-]{4,28}[a-z0-9]/secrets/corvis-src-${TENANT}-[a-z0-9][a-z0-9-]{0,63}(/versions/(latest|[0-9]+))?$`,
);

const isMetadataServer = (url: string) => new URL(url).hostname === "metadata.google.internal";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Fakes both the workload-identity metadata endpoint and the Secret Manager REST API. */
function fakeSecretManager(options: {
  onCreate?: (url: string, init?: RequestInit) => Response | undefined;
  onAddVersion?: (url: string, init?: RequestInit) => Response | undefined;
  onAccess?: (url: string) => Response | undefined;
  onDelete?: (url: string) => Response | undefined;
} = {}): { fetchImpl: typeof fetch; calls: { url: string; method: string; body?: string }[] } {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (isMetadataServer(url)) return jsonResponse({ access_token: "workload-token", expires_in: 3600 });
    if (method === "POST" && url.includes("/secrets?secretId=")) {
      return options.onCreate?.(url, init) ?? jsonResponse({ name: "created" });
    }
    if (method === "POST" && url.endsWith(":addVersion")) {
      return options.onAddVersion?.(url, init) ?? jsonResponse({ name: "version-1" });
    }
    if (method === "DELETE") {
      return options.onDelete?.(url) ?? new Response(null, { status: 200 });
    }
    if (url.includes(":access")) {
      return options.onAccess?.(url) ?? new Response(null, { status: 404 });
    }
    throw new Error(`unexpected call to ${method} ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("write then read round-trips the secret payload through Secret Manager", async () => {
  const secret = { token: "super-secret-value", refresh: "also-secret" };
  const stored = { calls: 0 };
  const { fetchImpl, calls } = fakeSecretManager({
    onAccess: () => {
      stored.calls += 1;
      return jsonResponse({ name: "v1", payload: { data: Buffer.from(JSON.stringify(secret)).toString("base64") } });
    },
  });
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl });

  const reference = await store.write(TENANT, "google_drive", secret);
  assert.match(reference, CONSTRAINT);
  assert.match(reference, new RegExp(`^projects/${PROJECT_ID}/`));

  const read = await store.read(reference);
  assert.deepEqual(read, secret);
  assert.equal(stored.calls, 1);

  const createCall = calls.find((call) => call.url.includes("/secrets?secretId="));
  assert.ok(createCall, "expected a secret-creation call");
  assert.equal(createCall?.method, "POST");
  assert.deepEqual(JSON.parse(createCall!.body!), { replication: { automatic: {} } });

  const addVersionCall = calls.find((call) => call.url.endsWith(":addVersion"));
  assert.ok(addVersionCall, "expected an addVersion call");
  const versionBody = JSON.parse(addVersionCall!.body!) as { payload: { data: string } };
  assert.equal(Buffer.from(versionBody.payload.data, "base64").toString("utf8"), JSON.stringify(secret));

  // The workload-identity token is fetched once and reused across calls.
  assert.equal(calls.filter((call) => isMetadataServer(call.url)).length, 1);
});

test("a short-lived secret (a pending OAuth attempt) is created with a TTL so Secret Manager deletes it by itself", async () => {
  const { fetchImpl, calls } = fakeSecretManager();
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl });
  const reference = await store.write(TENANT, "oauth-attempt", { state: "s" }, { ttlSeconds: 600 });
  assert.match(reference, CONSTRAINT);
  const createCall = calls.find((call) => call.url.includes("/secrets?secretId="));
  assert.deepEqual(JSON.parse(createCall!.body!), { replication: { automatic: {} }, ttl: "600s" });
});

test("construction needs a project id, and the workload-identity token must be obtainable", async () => {
  assert.throws(() => new GcpSecretManagerSecretStore("  "), /requires a project id/);
  const reference = sourceConnectorSecretReference(TENANT, "google_drive", 1, PROJECT_ID);
  const failing = (response: Response) => new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl: (async () => response.clone()) as typeof fetch });
  await assert.rejects(failing(new Response(null, { status: 503 })).read(reference), /token request failed \(503\)/);
  await assert.rejects(failing(jsonResponse({})).read(reference), /did not return an access token/);
});

test("a token without an expiry is cached for five minutes by default", async () => {
  let metadataCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    if (isMetadataServer(String(input))) { metadataCalls += 1; return jsonResponse({ access_token: "workload-token" }); }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl });
  const reference = sourceConnectorSecretReference(TENANT, "google_drive", 1, PROJECT_ID);
  await assert.rejects(store.read(reference), /secret_reference_not_found/);
  await assert.rejects(store.read(reference), /secret_reference_not_found/);
  assert.equal(metadataCalls, 1);
});

test("read reports a missing, refused, empty or corrupt secret without carrying its bytes", async () => {
  const reference = sourceConnectorSecretReference(TENANT, "google_drive", 1, PROJECT_ID);
  const readWith = (response: () => Response | undefined) => new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl: fakeSecretManager({ onAccess: response }).fetchImpl }).read(reference);
  await assert.rejects(readWith(() => new Response(null, { status: 404 })), /^Error: secret_reference_not_found$/);
  await assert.rejects(readWith(() => new Response(null, { status: 500 })), /secret access failed \(500\)/);
  await assert.rejects(readWith(() => jsonResponse({ payload: {} })), /returned no payload/);
  await assert.rejects(readWith(() => jsonResponse({})), /returned no payload/);
  const corrupt = Buffer.from("not json at all: SECRET-BYTES").toString("base64");
  await assert.rejects(readWith(() => jsonResponse({ payload: { data: corrupt } })), (error: unknown) => error instanceof Error && /was not valid JSON/.test(error.message) && !error.message.includes("SECRET-BYTES"));
});

test("revoke surfaces a refused deletion instead of pretending the credential is gone", async () => {
  const reference = sourceConnectorSecretReference(TENANT, "google_drive", 1, PROJECT_ID);
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl: fakeSecretManager({ onDelete: () => new Response(null, { status: 403 }) }).fetchImpl });
  await assert.rejects(store.revoke(reference), /secret deletion failed \(403\)/);
});

test("the wired store is Secret Manager when a project is configured, the placeholder otherwise, and fails closed in production", async () => {
  assert.ok(selectSourceConnectorSecretStore("corvis-uat-98213", "production") instanceof GcpSecretManagerSecretStore);
  assert.ok(selectSourceConnectorSecretStore("corvis-uat-98213", "development") instanceof GcpSecretManagerSecretStore);
  const placeholder = selectSourceConnectorSecretStore(undefined, "development");
  assert.ok(!(placeholder instanceof GcpSecretManagerSecretStore));
  const reference = await placeholder.write(TENANT, "oauth-attempt", { state: "s" }, { ttlSeconds: 600 });
  assert.deepEqual(await placeholder.read(reference), { state: "s" });
  assert.throws(() => selectSourceConnectorSecretStore(undefined, "production"), /CORVIS_GCP_PROJECT_ID is required/);
  assert.throws(() => selectSourceConnectorSecretStore("", "production"), /CORVIS_GCP_PROJECT_ID is required/);

  // The process-wide store reads the configured project (trimmed) once and then keeps it.
  const previous = process.env.CORVIS_GCP_PROJECT_ID;
  process.env.CORVIS_GCP_PROJECT_ID = " corvis-uat-98213 ";
  try {
    const wired = sourceConnectorSecretStore();
    assert.ok(wired instanceof GcpSecretManagerSecretStore);
    assert.equal(sourceConnectorSecretStore(), wired);
  } finally {
    if (previous === undefined) delete process.env.CORVIS_GCP_PROJECT_ID; else process.env.CORVIS_GCP_PROJECT_ID = previous;
  }
});

test("write cleans up the just-created secret when adding the version fails", async () => {
  const { fetchImpl, calls } = fakeSecretManager({
    onAddVersion: () => new Response(null, { status: 500 }),
  });
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl });

  await assert.rejects(store.write(TENANT, "google_drive", { token: "t" }), /secret version add failed \(500\)/);

  const deleteCall = calls.find((call) => call.method === "DELETE");
  assert.ok(deleteCall, "expected the orphaned secret to be deleted");
  const createCall = calls.find((call) => call.url.includes("/secrets?secretId="));
  assert.ok(createCall);
  // The delete targets the exact secret resource just created, not some other reference.
  assert.ok(deleteCall!.url.includes(createCall!.url.match(/secretId=([^&]+)/)![1]!));
});

test("a failed clean-up never hides the original write failure", async () => {
  const { fetchImpl } = fakeSecretManager({
    onAddVersion: () => new Response(null, { status: 500 }),
    onDelete: () => new Response(null, { status: 503 }),
  });
  await assert.rejects(new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl }).write(TENANT, "google_drive", { token: "t" }), /secret version add failed \(500\)/);
});

test("revoke deletes the secret and tolerates it already being gone", async () => {
  const { fetchImpl, calls } = fakeSecretManager();
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl });
  const reference = sourceConnectorSecretReference(TENANT, "google_drive", 1, PROJECT_ID);

  await store.revoke(reference);
  const deleteCall = calls.find((call) => call.method === "DELETE");
  assert.equal(deleteCall?.url, `https://secretmanager.googleapis.com/v1/${reference}`);

  const { fetchImpl: notFoundFetch } = fakeSecretManager({ onDelete: () => new Response(null, { status: 404 }) });
  await assert.doesNotReject(new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl: notFoundFetch }).revoke(reference));
});

test("the secret reference embeds the caller's own GCP project id, not a hardcoded one", () => {
  for (const projectId of ["corvis-dev-11", "corvis-uat-22", "corvis-prod-33"]) {
    const reference = sourceConnectorSecretReference(TENANT, "google_drive", 1, projectId);
    assert.match(reference, new RegExp(`^projects/${projectId}/secrets/`));
  }
});

test("a hung Secret Manager call is bounded by a timeout instead of hanging the request", { timeout: 5_000 }, async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (isMetadataServer(url)) return jsonResponse({ access_token: "workload-token", expires_in: 3600 });
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (!signal) return; // an unbounded call hangs forever and the test times out
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl, timeoutMs: 20 });
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(store.read(sourceConnectorSecretReference(TENANT, "google_drive", 1, PROJECT_ID)));
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(SECRET_MANAGER_REQUEST_TIMEOUT_MS > 0 && SECRET_MANAGER_REQUEST_TIMEOUT_MS <= 60_000);
});

test("no thrown error ever carries the raw secret payload", async () => {
  const rawSecret = "sk-do-not-leak-this-value-1234567890";
  const { fetchImpl } = fakeSecretManager({
    onAccess: () => jsonResponse({ name: "v1", payload: { data: Buffer.from(`not json but contains ${rawSecret}`).toString("base64") } }),
  });
  const store = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl });
  const reference = sourceConnectorSecretReference(TENANT, "google_drive", 1, PROJECT_ID);

  await assert.rejects(store.read(reference), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(rawSecret), `error leaked secret material: ${error.message}`);
    return true;
  });

  const { fetchImpl: failingCreate } = fakeSecretManager({ onCreate: () => new Response(null, { status: 500 }) });
  const failingStore = new GcpSecretManagerSecretStore(PROJECT_ID, { fetchImpl: failingCreate });
  await assert.rejects(failingStore.write(TENANT, "google_drive", { token: rawSecret }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(rawSecret), `error leaked secret material: ${error.message}`);
    return true;
  });
});

test("the placeholder store honors a secret's lifetime on read and its sweep reclaims the expired ones", async (t) => {
  const store = selectSourceConnectorSecretStore(undefined, "development");
  const live = await store.write(TENANT, "oauth-attempt", { n: 1 }, { ttlSeconds: 600 });
  const permanent = await store.write(TENANT, "acme", { n: 2 });
  const short = await store.write(TENANT, "oauth-attempt", { n: 3 }, { ttlSeconds: 1 });
  const real = Date.now();
  assert.deepEqual(await store.read(short), { n: 3 }, "readable until its time is up");

  const clock = t.mock.method(Date, "now", () => real + 5_000);
  await assert.rejects(store.read(short), /secret_reference_not_found/, "an expired secret no longer exists, as in Secret Manager");
  assert.deepEqual(await store.read(live), { n: 1 });
  assert.deepEqual(await store.read(permanent), { n: 2 });
  assert.equal(await store.sweepExpired!(), 1, "the sweep removes exactly the expired one");
  assert.equal(await store.sweepExpired!(), 0);
  clock.mock.restore();

  assert.equal(await store.sweepExpired!(real + 700_000), 1, "an explicit time sweeps the next to expire");
  assert.deepEqual(await store.read(permanent), { n: 2 }, "a secret written without a lifetime is never swept");
});

test("the operator sweep only touches a store this process already holds, and leaves a store with native expiry alone", async () => {
  const shared = globalThis as typeof globalThis & { secretStore?: SecretStore };
  const previous = shared.secretStore;
  try {
    shared.secretStore = undefined;
    assert.deepEqual(await sweepExpiredSourceSecrets(), { removed: 0 });
    assert.equal(shared.secretStore, undefined, "sweeping never selects (or fails to select) a store just to sweep it");

    shared.secretStore = { write: async () => "r", read: async () => ({}), revoke: async () => undefined };
    assert.deepEqual(await sweepExpiredSourceSecrets(), { removed: 0 }, "Secret Manager expires its own secrets and has no sweep");

    const placeholder = selectSourceConnectorSecretStore(undefined, "development");
    shared.secretStore = placeholder;
    await placeholder.write(TENANT, "oauth-attempt", { n: 1 }, { ttlSeconds: 1 });
    assert.deepEqual(await sweepExpiredSourceSecrets(Date.now() + 5_000), { removed: 1 });
  } finally { shared.secretStore = previous; }
});

test("the driver registry lives on globalThis, so next dev evaluating this module again keeps the registered drivers", () => {
  const shared = globalThis as typeof globalThis & { sourceConnectorDrivers?: Map<string, unknown> };
  const registry = sourceConnectorDrivers();
  assert.equal(shared.sourceConnectorDrivers, registry);
  sourceConnectorDrivers().set("kept-across-reloads", {} as never);
  try { assert.equal(shared.sourceConnectorDrivers!.has("kept-across-reloads"), true); } finally { sourceConnectorDrivers().delete("kept-across-reloads"); }
});
