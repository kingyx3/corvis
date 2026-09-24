import assert from "node:assert/strict";
import test from "node:test";
import {
  GcpSecretManagerSecretStore,
  SECRET_MANAGER_REQUEST_TIMEOUT_MS,
  sourceConnectorSecretReference,
} from "./source-connector-runtime.ts";

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
