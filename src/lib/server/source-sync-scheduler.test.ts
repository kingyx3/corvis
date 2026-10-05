import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { RequestIdentity } from "../../core/enterprise.ts";
import { DEMO_TOKEN_PROVIDER_KEY, DEMO_TOKENS } from "../../adapters/demo/source-providers.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { demoSourceConnectionService } from "./source-connection-service.ts";
import { ConnectorError } from "./source-connector-sync.ts";
import { approvedSourceProvider, registerApprovedSourceProvider, unregisterApprovedSourceProvider } from "./source-providers.ts";
import { processDueSourceSyncs } from "./source-sync-scheduler.ts";
import { SYNC_INTERVAL_MS, SYNC_LEASE_MS } from "./source-sync-schedule.ts";
import type { ConnectorDriver, IngestInput, IngestResult, IngestSink, RemoteDocumentRef, SecretPayload, SecretStore } from "./source-connectors.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";
const START = Date.parse("2026-10-02T12:00:00.000Z");

const originalDemo = process.env.CORVIS_DEMO_MODE;
afterEach(() => {
  if (originalDemo === undefined) delete process.env.CORVIS_DEMO_MODE; else process.env.CORVIS_DEMO_MODE = originalDemo;
});

type ConnectionState = {
  id: string; providerKey: string; status: string; nextScheduledAt: number | null; consecutiveFailures: number; credentialType: string;
  scope: Array<{ label: string; path?: string }>; lastSuccessAt?: number; lastErrorClass?: string;
};
type RunState = { runId: string; connectionId: string; state: string; errorClass?: string | null };

/**
 * A stateful stand-in for the control database: it implements the claim, listing and run bookkeeping the scheduler and
 * `runConnectionSync` issue, with a clock the test moves, so leases, schedules and idempotency are exercised as behavior.
 */
class FakeControlDb implements PostgresSqlApi {
  clock = START;
  readonly connections = new Map<string, ConnectionState>();
  readonly runs: RunState[] = [];
  readonly acquired: Array<{ connectionId: string; key: string; disposition: string }> = [];
  failNextRunInsert = false;

  add(overrides: Partial<ConnectionState> & { id: string }): ConnectionState {
    const state: ConnectionState = { providerKey: "acme-portal", status: "active", nextScheduledAt: null, consecutiveFailures: 0, credentialType: "scoped_api_token", scope: [{ label: "Reports", path: "/Reports" }], ...overrides };
    this.connections.set(state.id, state);
    return state;
  }

  private due(state: ConnectionState): boolean { return state.status === "active" && (state.nextScheduledAt === null || state.nextScheduledAt <= this.clock); }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("select tenant_id, source_connection_id from corvis_source.source_connection")) {
      const providers = JSON.parse(String(parameters[1])) as string[];
      return [...this.connections.values()].filter((state) => this.due(state) && providers.includes(state.providerKey)).slice(0, Number(parameters[0])).map((state) => ({ tenant_id: TENANT, source_connection_id: state.id }));
    }
    if (sql.includes("returning workspace_id")) {
      const state = this.connections.get(String(parameters[1]));
      if (!state || !this.due(state)) return [];
      state.nextScheduledAt = Date.parse(String(parameters[2]));
      return [{ workspace_id: WORKSPACE }];
    }
    if (sql.includes("from corvis_source.source_connection where tenant_id=$1 and source_connection_id")) {
      const state = this.connections.get(String(parameters[1]));
      return state ? [{
        source_connection_id: state.id, tenant_id: TENANT, workspace_id: WORKSPACE, provider_key: state.providerKey, credential_type: state.credentialType, status: state.status,
        source_scope: state.scope, secret_reference: "ref", connector_version: "1.0.0", consecutive_failures: state.consecutiveFailures,
      }] : [];
    }
    if (sql.includes("from corvis_source.acquired_document") && sql.includes("acquisition_key=$3")) {
      return this.acquired.some((row) => row.connectionId === parameters[1] && row.key === parameters[2] && row.disposition === "accepted") ? [{ one: 1 }] : [];
    }
    return [];
  }

  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_source.source_connection_run")) {
      if (this.failNextRunInsert) { this.failNextRunInsert = false; throw new Error("database unavailable"); }
      const refused = sql.includes("'refused'");
      this.runs.push({ runId: String(parameters[1]), connectionId: String(parameters[2]), state: refused ? "refused" : "running", ...(refused ? { errorClass: null } : {}) });
      return;
    }
    if (sql.includes("update corvis_source.source_connection_run set state='failed'")) {
      for (const run of this.runs) if (run.connectionId === parameters[1] && run.state === "running") run.state = "failed";
      return;
    }
    if (sql.includes("update corvis_source.source_connection_run set")) {
      const run = this.runs.find((row) => row.runId === parameters[1])!;
      run.state = sql.includes("state='succeeded'") ? "succeeded" : String(parameters[2]);
      if (sql.includes("error_class=$8")) run.errorClass = String(parameters[7]);
      return;
    }
    if (sql.includes("insert into corvis_source.acquired_document")) {
      this.acquired.push({ connectionId: String(parameters[1]), key: String(parameters[9]), disposition: String(parameters[11]) });
      return;
    }
    if (sql.includes("update corvis_source.source_connection set") && sql.includes("consecutive_failures=0")) {
      const state = this.connections.get(String(parameters[1]))!;
      state.consecutiveFailures = 0; state.lastErrorClass = undefined; state.lastSuccessAt = this.clock;
      state.nextScheduledAt = parameters[2] === null ? null : Date.parse(String(parameters[2]));
      return;
    }
    if (sql.includes("update corvis_source.source_connection set") && sql.includes("last_error_class=$4")) {
      const state = this.connections.get(String(parameters[1]))!;
      state.consecutiveFailures = Number(parameters[2]); state.lastErrorClass = String(parameters[3]); state.status = String(parameters[4]);
      state.nextScheduledAt = parameters[5] === null ? null : Date.parse(String(parameters[5]));
      return;
    }
    if (sql.includes("update corvis_source.source_connection set next_scheduled_at=$3::timestamptz") && sql.includes("and next_scheduled_at=$4")) {
      const state = this.connections.get(String(parameters[1]))!;
      if (state.nextScheduledAt === Date.parse(String(parameters[3]))) state.nextScheduledAt = Date.parse(String(parameters[2]));
    }
  }
  async health() { return true; }
}

class FakeSecrets implements SecretStore {
  payload: SecretPayload = { token: "t" };
  async write(): Promise<string> { return "ref"; }
  async read(): Promise<SecretPayload> { return this.payload; }
  async revoke(): Promise<void> {}
}

class CountingSink implements IngestSink {
  readonly inputs: IngestInput[] = [];
  private readonly seen = new Map<string, IngestResult>();
  /** Idempotent per acquisition key, like the upload sink: the same remote version is the same document. */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const key = `${input.sourceConnectionId}:${input.acquisitionKey}`;
    if (!this.seen.has(key)) {
      this.inputs.push(input);
      this.seen.set(key, { accepted: true, documentId: `00000000-0000-4000-8000-${String(this.inputs.length).padStart(12, "0")}`, documentArtifactVersionId: "22222222-2222-4222-8222-222222222222" });
    }
    return this.seen.get(key)!;
  }
}

function driver(overrides: Partial<ConnectorDriver> = {}, refs: RemoteDocumentRef[] = [{ remoteDocumentId: "r1", remoteVersion: "v1", remotePath: "/Reports/q1.pdf" }]): ConnectorDriver {
  return {
    providerKey: "acme-portal", connectorVersion: "1.0.0", testConnection: async () => ({ ok: true }), discover: async () => refs,
    download: async (_credential, ref) => ({ bytes: Buffer.from(`${ref.remoteDocumentId}:${ref.remoteVersion}`), contentType: "application/pdf" }),
    ...overrides,
  };
}

function harness(drivers: Map<string, ConnectorDriver> = new Map([["acme-portal", driver()]])) {
  const db = new FakeControlDb();
  const sink = new CountingSink();
  const secrets = new FakeSecrets();
  const pass = (limit = 25) => processDueSourceSyncs(limit, { db, secrets, drivers, ingest: sink, now: () => db.clock });
  return { db, sink, secrets, pass };
}

test("an active connection that is due is collected from, and its next run is scheduled an interval later", async () => {
  const { db, sink, pass } = harness();
  db.add({ id: "c1" });
  const summary = await pass();
  assert.deepEqual(summary, { due: 1, succeeded: 1, failed: 0, refused: 0, skipped: 0, errors: 0 });
  assert.equal(sink.inputs.length, 1);
  assert.deepEqual([db.runs[0]!.state, db.connections.get("c1")!.nextScheduledAt], ["succeeded", START + SYNC_INTERVAL_MS]);

  // Not due again until the interval has passed.
  assert.equal((await pass()).due, 0);
  db.clock = START + SYNC_INTERVAL_MS - 1;
  assert.equal((await pass()).due, 0);
  db.clock = START + SYNC_INTERVAL_MS;
  assert.equal((await pass()).succeeded, 1);
});

test("a re-run over the same remote documents never duplicates them, and a new version is collected once", async () => {
  const refs: RemoteDocumentRef[] = [{ remoteDocumentId: "r1", remoteVersion: "v1", remotePath: "/Reports/q1.pdf" }];
  const { db, sink, pass } = harness(new Map([["acme-portal", driver({}, refs)]]));
  db.add({ id: "c1" });
  await pass();
  db.clock += SYNC_INTERVAL_MS;
  await pass();
  assert.equal(sink.inputs.length, 1, "the second run found the same version and ingested nothing");
  assert.deepEqual(db.acquired.map((row) => row.disposition), ["accepted", "duplicate"]);
  refs[0] = { remoteDocumentId: "r1", remoteVersion: "v2", remotePath: "/Reports/q1.pdf" };
  db.clock += SYNC_INTERVAL_MS;
  await pass();
  assert.equal(sink.inputs.length, 2);
});

test("only active connections are listed: pending, paused, revoked, suspended and reauthorization-required ones never sync", async () => {
  const { db, sink, pass } = harness();
  for (const status of ["pending_authorization", "paused", "reauthorization_required", "suspended", "revoked"]) db.add({ id: status, status });
  assert.deepEqual(await pass(), { due: 0, succeeded: 0, failed: 0, refused: 0, skipped: 0, errors: 0 });
  assert.equal(sink.inputs.length, 0);
  assert.equal(db.runs.length, 0);
});

test("a connection whose first test failed (still pending) never syncs, and syncs once a passing test activates it", async () => {
  const { db, sink, pass } = harness();
  const pending = db.add({ id: "c1", status: "pending_authorization", lastErrorClass: "auth" });
  await pass();
  assert.equal(sink.inputs.length, 0);
  pending.status = "active";
  assert.equal((await pass()).succeeded, 1);
});

test("a connection whose provider has no registered driver is left alone, not counted as an error", async () => {
  const { db, pass } = harness();
  db.add({ id: "c1", providerKey: "no-driver" });
  assert.deepEqual(await pass(), { due: 0, succeeded: 0, failed: 0, refused: 0, skipped: 0, errors: 0 });
});

test("two workers racing for one connection never both run it: the loser's claim matches nothing", async () => {
  const { db, sink, pass } = harness();
  db.add({ id: "c1" });
  const [first, second] = await Promise.all([pass(), pass()]);
  assert.equal(sink.inputs.length, 1);
  assert.equal(db.runs.length, 1, "one run record");
  assert.equal(first.succeeded + second.succeeded, 1);
  assert.equal(first.skipped + second.skipped, 1, "the other worker saw it due, then lost the claim");
});

test("a claimed connection is held for the lease, and a dead worker's lease lapses so the connection is collected again", async () => {
  // A worker claimed the connection and died: the lease is still in the future and a run was left in `running`.
  const { db, pass } = harness();
  db.add({ id: "c1", nextScheduledAt: START + SYNC_LEASE_MS });
  db.runs.push({ runId: "orphan", connectionId: "c1", state: "running" });
  assert.equal((await pass()).due, 0, "still leased: nobody else touches it");
  assert.equal(db.runs.find((run) => run.runId === "orphan")!.state, "running");

  db.clock = START + SYNC_LEASE_MS + 1;
  assert.equal((await pass()).succeeded, 1);
  assert.equal(db.runs.find((run) => run.runId === "orphan")!.state, "failed", "the dead worker's run is closed, not left running forever");
});

test("a transient provider failure backs off and keeps the connection active; repeated failures eventually suspend it", async () => {
  const failing = driver({ discover: async () => { throw new ConnectorError("network", "reset"); } });
  const { db, pass } = harness(new Map([["acme-portal", failing]]));
  const state = db.add({ id: "c1" });
  assert.deepEqual(await pass(), { due: 1, succeeded: 0, failed: 1, refused: 0, skipped: 0, errors: 0 });
  assert.equal(state.status, "active");
  assert.equal(state.consecutiveFailures, 1);
  const wait = state.nextScheduledAt! - START;
  assert.ok(wait >= 30_000 && wait <= 60_000, `first retry in 30-60s, got ${wait}`);
  assert.equal((await pass()).due, 0, "not retried before its backoff");

  for (let attempt = 2; attempt <= 5; attempt += 1) {
    db.clock = state.nextScheduledAt!;
    await pass();
  }
  assert.equal(state.status, "suspended", "the fifth consecutive failure suspends");
  assert.equal(state.nextScheduledAt, null);
  assert.equal(db.runs.at(-1)!.state, "dead_letter");
  db.clock += 24 * 60 * 60 * 1000;
  assert.equal((await pass()).due, 0, "a suspended connection never syncs");
});

test("a fail-closed credential error stops the connection, is recorded as a refusal with its class, and is not retried", async () => {
  const rejected = driver({ discover: async () => { throw new ConnectorError("auth", "token rejected"); } });
  const { db, pass } = harness(new Map([["acme-portal", rejected]]));
  const state = db.add({ id: "c1" });
  assert.deepEqual(await pass(), { due: 1, succeeded: 0, failed: 0, refused: 1, skipped: 0, errors: 0 });
  assert.equal(state.status, "reauthorization_required");
  assert.equal(state.nextScheduledAt, null);
  assert.deepEqual([db.runs[0]!.state, db.runs[0]!.errorClass], ["refused", "auth"]);
  db.clock += SYNC_INTERVAL_MS;
  assert.equal((await pass()).due, 0);
});

test("an expired OAuth credential that cannot be renewed fails the run closed and sends the connection to reauthorization", async () => {
  const { db, secrets, pass } = harness();
  const state = db.add({ id: "c1", credentialType: "oauth_authorization_code" });
  secrets.payload = { accessToken: "old", expiresAt: START - 1000 };
  const summary = await pass();
  assert.equal(summary.refused, 1);
  assert.equal(state.status, "reauthorization_required");
  assert.equal(db.runs[0]!.errorClass, "reauthorization");
});

test("an OAuth credential about to expire is refreshed through the approved provider before the driver sees it", async () => {
  const seen: SecretPayload[] = [];
  const oauthDriver = driver({ discover: async (credential) => { seen.push(credential); return []; } });
  registerApprovedSourceProvider({
    providerKey: "acme-portal", displayName: "Acme", summary: "Acme", demo: false, connect: { method: "oauth" },
    scope: [{ label: "Reports", path: "/Reports" }], disclosure: { reads: [], behaviour: [], limits: [] }, connectorVersion: "1.0.0",
    oauth: {
      authorizationUrl: () => "https://provider.test/consent",
      exchangeCode: async () => ({}),
      refresh: async ({ refreshToken }) => ({ accessToken: `fresh-for-${refreshToken}`, expiresAt: START + 3_600_000 }),
    },
  }, oauthDriver);
  try {
    const { db, secrets, pass } = harness(new Map([["acme-portal", oauthDriver]]));
    db.add({ id: "c1", credentialType: "oauth_authorization_code" });
    secrets.payload = { accessToken: "old", refreshToken: "r1", expiresAt: START + 1000 };
    assert.equal((await pass()).succeeded, 1);
    assert.equal(seen[0]!.accessToken, "fresh-for-r1");
  } finally {
    unregisterApprovedSourceProvider("acme-portal");
  }
});

test("a connection that stopped being active between the listing and the claim is skipped", async () => {
  const { db, pass } = harness();
  const state = db.add({ id: "c1" });
  const realQuery = db.query.bind(db);
  db.query = async (sql, parameters) => {
    const rows = await realQuery(sql, parameters);
    if (sql.includes("select tenant_id, source_connection_id")) state.status = "paused";
    return rows;
  };
  assert.deepEqual(await pass(), { due: 1, succeeded: 0, failed: 0, refused: 0, skipped: 1, errors: 0 });
  assert.equal(db.runs.length, 0);
});

test("an unexpected fault in one connection is counted, logged and retried after a backoff without holding back the others", async () => {
  const { db, sink, pass } = harness();
  const broken = db.add({ id: "c1" });
  db.add({ id: "c2" });
  db.failNextRunInsert = true;
  const summary = await pass();
  assert.deepEqual(summary, { due: 2, succeeded: 1, failed: 0, refused: 0, skipped: 0, errors: 1 });
  assert.equal(sink.inputs.length, 1, "the second connection was still collected from");
  assert.ok(broken.nextScheduledAt! > START && broken.nextScheduledAt! <= START + 60_000, "released from its lease for a prompt retry");
  db.clock = broken.nextScheduledAt!;
  assert.equal((await pass()).succeeded, 1);
});

test("a fault that also prevents releasing the lease is absorbed, leaving the lease to lapse", async () => {
  const { db, pass } = harness();
  db.add({ id: "c1" });
  db.failNextRunInsert = true;
  const realExecute = db.execute.bind(db);
  db.execute = async (sql, parameters) => {
    if (sql.includes("and next_scheduled_at=$4")) throw new Error("still down");
    return realExecute(sql, parameters);
  };
  assert.equal((await pass()).errors, 1);
  assert.equal(db.connections.get("c1")!.nextScheduledAt, START + SYNC_LEASE_MS);
});

test("a fault that is not an Error object is still counted", async () => {
  const { db, pass } = harness();
  db.add({ id: "c1" });
  const realExecute = db.execute.bind(db);
  db.execute = async (sql, parameters) => {
    if (sql.includes("insert into corvis_source.source_connection_run")) throw "plain string";
    return realExecute(sql, parameters);
  };
  assert.equal((await pass()).errors, 1);
});

test("a pass is bounded by its limit; the rest wait for the next tick", async () => {
  const { db, pass } = harness();
  for (const id of ["c1", "c2", "c3"]) db.add({ id });
  assert.equal((await pass(2)).due, 2);
  assert.equal((await pass(2)).due, 1);
});

// --- demo mode: the same loop over the in-memory connections, with the demonstration driver -------------------------

function demoIdentity(workspaceId: string): RequestIdentity {
  return { subject: "demo|admin", tenantId: "demo-sync-tenant", workspaceId, roles: ["admin"], entitlements: { workspaceIds: [workspaceId], sourceDocumentAccessAllowed: false }, authMethod: "demo", sessionId: "s" };
}

test("in demo mode the tick collects from a connected demo provider through the demo driver and the upload pipeline's sink", async () => {
  process.env.CORVIS_DEMO_MODE = "true";
  const identity = demoIdentity("workspace-scheduler");
  const provider = approvedSourceProvider(DEMO_TOKEN_PROVIDER_KEY)!;
  const connected = await demoSourceConnectionService.connect(identity, { provider, connectionLabel: "Demo portal", secret: { token: DEMO_TOKENS.valid } }, "c1");
  assert.equal(connected.connection.status, "active");

  const sink = new CountingSink();
  const summary = await processDueSourceSyncs(25, { ingest: sink, now: () => Date.now() });
  assert.ok(summary.succeeded >= 1);
  assert.ok(sink.inputs.every((input) => input.providerKey === DEMO_TOKEN_PROVIDER_KEY || input.providerKey.startsWith("demo-")));
  const activity = await demoSourceConnectionService.activity(identity);
  const mine = activity.find((entry) => entry.sourceConnectionId === connected.connection.sourceConnectionId)!;
  assert.equal(mine.runs[0]!.state, "succeeded");
});
