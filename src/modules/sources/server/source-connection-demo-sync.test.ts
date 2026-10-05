import assert from "node:assert/strict";
import test from "node:test";
import type { RequestIdentity } from "../../../shared/domain/enterprise.ts";
import { DemoSourceConnectionStore } from "../adapters/source-connection-store.ts";
import { demoConnectorDriver } from "../adapters/source-driver.ts";
import { DEMO_OAUTH_PROVIDER_KEY, DEMO_TOKEN_PROVIDER_KEY } from "../adapters/source-providers.ts";
import { ConnectorError } from "./source-connector-sync.ts";
import type { ConnectorDriver, IngestInput, IngestResult, IngestSink } from "./source-connectors.ts";
import { SYNC_INTERVAL_MS } from "./source-sync-schedule.ts";

const START = Date.parse("2026-10-02T12:00:00.000Z");

function identity(workspaceId = "workspace-1"): RequestIdentity {
  return { subject: "demo|admin", tenantId: "tenant-1", workspaceId, roles: ["admin"], entitlements: { workspaceIds: [workspaceId], sourceDocumentAccessAllowed: false }, authMethod: "demo", sessionId: "s" };
}

class Sink implements IngestSink {
  readonly inputs: IngestInput[] = [];
  reject = false;
  async ingest(input: IngestInput): Promise<IngestResult> {
    this.inputs.push(input);
    return this.reject
      ? { accepted: false, reason: "upload_integrity_failed", quarantined: true }
      : { accepted: true, documentId: `00000000-0000-4000-8000-${String(this.inputs.length).padStart(12, "0")}`, documentArtifactVersionId: "22222222-2222-4222-8222-222222222222" };
  }
}

const SCOPE = [{ label: "Quarterly reports", path: "/Fund III/Quarterly" }, { label: "Capital account statements", path: "/Fund III/Capital accounts" }];

function connect(store: DemoSourceConnectionStore, who: RequestIdentity, overrides: { providerKey?: string; scope?: typeof SCOPE; failure?: "auth" | "network" } = {}) {
  const created = store.create(who, {
    providerKey: overrides.providerKey ?? DEMO_TOKEN_PROVIDER_KEY, connectionLabel: "Demo portal", credentialType: "scoped_api_token",
    scope: overrides.scope ?? SCOPE, connectorVersion: "demo-1", testOutcome: overrides.failure ? { ok: false, errorClass: overrides.failure } : { ok: true },
  });
  store.test(who, created.sourceConnectionId);
  return created.sourceConnectionId;
}

test("the demonstration driver finds two fixed PDFs per confirmed folder and nothing else", async () => {
  const driver = demoConnectorDriver("demo-x");
  assert.deepEqual(await driver.testConnection({}, []), { ok: true });
  const refs = await driver.discover({}, [{ label: "Reports", path: "/A/B/" }, { label: "Side letters" }], undefined);
  assert.deepEqual(refs.map((ref) => ref.remotePath), ["/A/B/Quarterly-report-2026-Q2.pdf", "/A/B/Capital-account-statement-2026-Q2.pdf", "/side-letters/Quarterly-report-2026-Q2.pdf", "/side-letters/Capital-account-statement-2026-Q2.pdf"]);
  assert.equal(new Set(refs.map((ref) => ref.remoteDocumentId)).size, 4);
  assert.deepEqual(await driver.discover({}, [{ label: "!!!" }], undefined).then((found) => found.map((ref) => ref.remotePath.split("/")[1])), ["folder", "folder"], "a label with nothing usable still names a folder");
  const downloaded = await driver.download({}, refs[0]!);
  assert.equal(downloaded.contentType, "application/pdf");
  assert.match(downloaded.bytes.toString(), /^%PDF-1\.4\n% Corvis demonstration document/);
});

test("a connected demo connection is collected from when it is due, through the shared collection loop", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  const sink = new Sink();
  const id = connect(store, who);
  assert.equal(store.get(who, id).status, "active");
  assert.equal(store.get(who, id).nextScheduledAt, undefined, "no schedule yet: due at the next collection run");

  const summary = await store.runDueSyncs({ ingest: sink, now: START, identity: who });
  assert.deepEqual(summary, { due: 1, succeeded: 1, failed: 0, refused: 0, skipped: 0, errors: 0 });
  assert.equal(sink.inputs.length, 4, "two documents in each of the two confirmed folders");
  const [run] = store.activity(who).find((entry) => entry.sourceConnectionId === id)!.runs;
  assert.deepEqual([run!.state, run!.trigger, run!.discoveredCount, run!.acceptedCount, run!.duplicateCount, run!.rejectedCount], ["succeeded", "scheduled", 4, 4, 0, 0]);
  assert.equal(run!.acquisitions.length, 4);
  assert.ok(run!.acquisitions.every((acquisition) => acquisition.disposition === "accepted" && acquisition.documentId));
  const connection = store.get(who, id);
  assert.equal(connection.lastSuccessAt, new Date(START).toISOString());
  assert.equal(connection.nextScheduledAt, new Date(START + SYNC_INTERVAL_MS).toISOString());

  assert.equal((await store.runDueSyncs({ ingest: sink, now: START + 1000, identity: who })).due, 0, "not due again before the interval");
  const again = await store.runDueSyncs({ ingest: sink, now: START + SYNC_INTERVAL_MS, identity: who });
  assert.equal(again.succeeded, 1);
  assert.equal(sink.inputs.length, 4, "the second run found every document already collected");
  const [second] = store.activity(who).find((entry) => entry.sourceConnectionId === id)!.runs;
  assert.deepEqual([second!.acceptedCount, second!.duplicateCount], [0, 4]);
  assert.equal(store.activity(who).find((entry) => entry.sourceConnectionId === id)!.runs.length, 2);
});

test("the confirmed scope is honoured: a narrowed connection reads only the folder that was kept", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  const sink = new Sink();
  connect(store, who, { scope: [SCOPE[1]!] });
  await store.runDueSyncs({ ingest: sink, now: START, identity: who });
  assert.deepEqual(sink.inputs.map((input) => input.fileName), ["Quarterly-report-2026-Q2.pdf", "Capital-account-statement-2026-Q2.pdf"]);
  const [run] = store.activity(who)[0]!.runs;
  assert.ok(run!.acquisitions.every((acquisition) => acquisition.remotePath.startsWith("/Fund III/Capital accounts/")));
});

test("a connection whose test failed is never collected from, whatever the schedule says", async () => {
  for (const [failure, status] of [["network", "pending_authorization"], ["auth", "reauthorization_required"]] as const) {
    const store = new DemoSourceConnectionStore(() => new Date(START));
    const who = identity();
    const sink = new Sink();
    const id = connect(store, who, { failure });
    assert.equal(store.get(who, id).status, status, "a failed test never activates the connection");
    assert.deepEqual(await store.runDueSyncs({ ingest: sink, now: START + 10 * SYNC_INTERVAL_MS, identity: who }), { due: 0, succeeded: 0, failed: 0, refused: 0, skipped: 0, errors: 0 });
    assert.equal(sink.inputs.length, 0);
    assert.equal(store.activity(who).find((entry) => entry.sourceConnectionId === id)!.runs.length, 0);
  }
});

test("a paused connection is not collected from until it is resumed", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  const sink = new Sink();
  const id = connect(store, who);
  store.transition(who, id, "pause");
  assert.equal((await store.runDueSyncs({ ingest: sink, now: START, identity: who })).due, 0);
  store.transition(who, id, "resume");
  assert.equal((await store.runDueSyncs({ ingest: sink, now: START, identity: who })).succeeded, 1);
});

test("only connections made through the wizard with a demo provider are collected; the seeded history stays as it was", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  const before = JSON.stringify(store.activity(who));
  const sink = new Sink();
  assert.equal((await store.runDueSyncs({ ingest: sink, now: START + 30 * SYNC_INTERVAL_MS, identity: who })).due, 0);
  assert.equal(JSON.stringify(store.activity(who)), before);
  const seededActive = store.list(who).filter((connection) => connection.status === "active");
  assert.ok(seededActive.length > 0 && seededActive.every((connection) => connection.nextScheduledAt && Date.parse(connection.nextScheduledAt) > START), "a seeded active connection shows a future next sync");
  const other = connect(store, who, { providerKey: "demo-unknown-portal" });
  assert.equal((await store.runDueSyncs({ ingest: sink, now: START, identity: who })).due, 0, "a provider without a demo driver is not collected");
  assert.equal(store.get(who, other).status, "active");
});

test("overlapping passes never collect the same connection twice, and a pass without an identity covers every workspace", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const one = identity("workspace-1");
  const two = identity("workspace-2");
  connect(store, one);
  connect(store, two);
  const sink = new Sink();
  const results = await Promise.all([store.runDueSyncs({ ingest: sink, now: START }), store.runDueSyncs({ ingest: sink, now: START })]);
  assert.equal(results[0].due + results[1].due, 2, "each connection was claimed exactly once");
  assert.equal(sink.inputs.length, 8);
});

test("a transient failure backs off and keeps the connection active; the clock default is the store's", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  const id = connect(store, who);
  const failing = new Map<string, ConnectorDriver>([[DEMO_TOKEN_PROVIDER_KEY, { ...demoConnectorDriver(DEMO_TOKEN_PROVIDER_KEY), discover: async () => { throw new ConnectorError("network", "reset"); } }]]);
  const summary = await store.runDueSyncs({ ingest: new Sink(), identity: who, drivers: failing });
  assert.deepEqual(summary, { due: 1, succeeded: 0, failed: 1, refused: 0, skipped: 0, errors: 0 });
  const connection = store.get(who, id);
  assert.deepEqual([connection.status, connection.consecutiveFailures, connection.lastErrorClass], ["active", 1, "network"]);
  const wait = Date.parse(connection.nextScheduledAt!) - START;
  assert.ok(wait >= 30_000 && wait <= 60_000);
  const [run] = store.activity(who)[0]!.runs;
  assert.deepEqual([run!.state, run!.errorClass, run!.attempt], ["retryable", "network", 1]);
  // The next successful run clears the failure.
  await store.runDueSyncs({ ingest: new Sink(), identity: who, now: Date.parse(connection.nextScheduledAt!) });
  const healed = store.get(who, id);
  assert.deepEqual([healed.consecutiveFailures, healed.lastErrorClass], [0, undefined]);
});

test("a fail-closed failure stops the connection and asks for reauthorization", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  const id = connect(store, who, { providerKey: DEMO_OAUTH_PROVIDER_KEY });
  const failing = new Map<string, ConnectorDriver>([[DEMO_OAUTH_PROVIDER_KEY, { ...demoConnectorDriver(DEMO_OAUTH_PROVIDER_KEY), discover: async () => { throw new ConnectorError("auth", "token rejected"); } }]]);
  const summary = await store.runDueSyncs({ ingest: new Sink(), identity: who, now: START, drivers: failing });
  assert.equal(summary.refused, 1);
  const connection = store.get(who, id);
  assert.deepEqual([connection.status, connection.nextScheduledAt], ["reauthorization_required", undefined]);
  const [run] = store.activity(who)[0]!.runs;
  assert.deepEqual([run!.state, run!.errorClass], ["refused", "auth"]);
  assert.equal((await store.runDueSyncs({ ingest: new Sink(), identity: who, now: START + 10 * SYNC_INTERVAL_MS })).due, 0);
});

test("a document the upload pipeline quarantines is recorded as held, not collected, and is offered again next run", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  const sink = new Sink();
  sink.reject = true;
  connect(store, who, { scope: [SCOPE[0]!] });
  await store.runDueSyncs({ ingest: sink, now: START, identity: who });
  const [run] = store.activity(who)[0]!.runs;
  assert.deepEqual([run!.acceptedCount, run!.rejectedCount], [0, 2]);
  assert.ok(run!.acquisitions.every((acquisition) => acquisition.disposition === "quarantined"));
  sink.reject = false;
  await store.runDueSyncs({ ingest: sink, now: START + SYNC_INTERVAL_MS, identity: who });
  assert.equal(store.activity(who)[0]!.runs[0]!.acceptedCount, 2);
});

test("a document the driver lists outside the confirmed scope is rejected in the run record", async () => {
  const store = new DemoSourceConnectionStore(() => new Date(START));
  const who = identity();
  connect(store, who, { scope: [SCOPE[0]!] });
  const wandering = new Map<string, ConnectorDriver>([[DEMO_TOKEN_PROVIDER_KEY, {
    ...demoConnectorDriver(DEMO_TOKEN_PROVIDER_KEY),
    discover: async () => [{ remoteDocumentId: "x", remoteVersion: "v1", remotePath: "/Fund III/Other/secret.pdf" }],
  }]]);
  await store.runDueSyncs({ ingest: new Sink(), identity: who, now: START, drivers: wandering });
  const [run] = store.activity(who)[0]!.runs;
  assert.deepEqual([run!.acceptedCount, run!.rejectedCount], [0, 1]);
  assert.equal(run!.acquisitions[0]!.disposition, "rejected");
});
