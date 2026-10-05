import assert from "node:assert/strict";
import test from "node:test";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../../../../platform/database/postgres.ts";
import {
  ConnectorError,
  classifyRunFailure,
  collectDocuments,
  connectorErrorClass,
  runConnectionSync,
  withinConfirmedScope,
  type AcquisitionLedger,
  type CollectionCounts,
  type LedgerEntry,
} from "./source-connector-sync.ts";
import { SYNC_INTERVAL_MS } from "../connections/source-sync-schedule.ts";
import { acquisitionKey, type ConnectorDriver, type IngestInput, type IngestResult, type IngestSink, type RemoteDocumentRef, type SecretStore, type SourceScope } from "./source-connectors.ts";

const TENANT = "00000000-0000-0000-0000-0000000000a1";
const WORKSPACE = "00000000-0000-0000-0000-0000000000b1";
const CONNECTION = "00000000-0000-0000-0000-0000000000c1";

test("a document is inside the confirmed scope only when it sits under one of the confirmed paths", () => {
  const scope: SourceScope[] = [{ label: "Quarterly", path: "/Fund III/Quarterly" }, { label: "Statements", path: "/Fund III/Capital accounts/" }];
  assert.equal(withinConfirmedScope("/Fund III/Quarterly/q1.pdf", scope), true);
  assert.equal(withinConfirmedScope("/Fund III/Quarterly/2026/q1.pdf", scope), true, "nested folders are under the confirmed folder");
  assert.equal(withinConfirmedScope("/Fund III/Capital accounts/a.pdf", scope), true, "a trailing slash on the scope changes nothing");
  assert.equal(withinConfirmedScope("/Fund III/Quarterly", scope), true, "the folder itself");
  assert.equal(withinConfirmedScope("/Fund III/Side letters/s.pdf", scope), false);
  assert.equal(withinConfirmedScope("/Fund III/Quarterly-other/q.pdf", scope), false, "whole path segments, not string prefixes");
  assert.equal(withinConfirmedScope("/Fund III/Quarterly/../Side letters/s.pdf", scope), false, "traversal is never inside");
  assert.equal(withinConfirmedScope("/Fund III/./Quarterly//q1.pdf", scope), true, "dot and empty segments are ignored");
  assert.equal(withinConfirmedScope("/Fund/q.pdf", scope), false, "shorter than the scope");
  assert.equal(withinConfirmedScope("/anything/x.pdf", [{ label: "Escape", path: "/a/../b" }]), false, "a scope path that is itself unusable admits nothing");
});

test("a scope that cannot be checked by path leaves the driver's own scoping as the only check", () => {
  assert.equal(withinConfirmedScope("/anything.pdf", []), true);
  assert.equal(withinConfirmedScope("/anything.pdf", [{ label: "Reports" }]), true);
  assert.equal(withinConfirmedScope("/anything.pdf", [{ label: "Reports", path: "/Reports" }, { label: "Other" }]), true, "one label-only entry makes the whole scope label-scoped");
});

class MemoryLedger implements AcquisitionLedger {
  readonly entries: LedgerEntry[] = [];
  async alreadyAcquired(key: string): Promise<boolean> {
    return this.entries.some((entry) => entry.disposition === "accepted" && acquisitionKey(entry.ref.remoteDocumentId, entry.ref.remoteVersion, entry.contentSha256) === key);
  }
  async record(entry: LedgerEntry): Promise<void> { this.entries.push(entry); }
}

class RecordingSink implements IngestSink {
  readonly inputs: IngestInput[] = [];
  async ingest(input: IngestInput): Promise<IngestResult> {
    this.inputs.push(input);
    return { accepted: true, documentId: "11111111-1111-4111-8111-111111111111", documentArtifactVersionId: "22222222-2222-4222-8222-222222222222" };
  }
}

function ref(path: string, id = path, version = "v1"): RemoteDocumentRef { return { remoteDocumentId: id, remoteVersion: version, remotePath: path }; }

function driverFor(refs: RemoteDocumentRef[], downloads: string[] = []): ConnectorDriver {
  return {
    providerKey: "acme-portal", connectorVersion: "1.0.0",
    testConnection: async () => ({ ok: true }),
    discover: async () => refs,
    download: async (_credential, item) => { downloads.push(item.remotePath); return { bytes: Buffer.from(`bytes of ${item.remoteDocumentId} ${item.remoteVersion}`), contentType: "application/pdf" }; },
  };
}

const connection = { sourceConnectionId: CONNECTION, tenantId: TENANT, workspaceId: WORKSPACE, providerKey: "acme-portal", sourceScope: [{ label: "Quarterly", path: "/Fund III/Quarterly" }] };
const emptyCounts = (): CollectionCounts => ({ discovered: 0, accepted: 0, duplicate: 0, rejected: 0 });

test("whatever a driver lists outside the confirmed scope is rejected without being downloaded", async () => {
  const downloads: string[] = [];
  const ledger = new MemoryLedger();
  const sink = new RecordingSink();
  const counts = emptyCounts();
  await collectDocuments({
    connection, credential: {}, ledger, ingest: sink,
    driver: driverFor([ref("/Fund III/Quarterly/q1.pdf"), ref("/Fund III/Side letters/secret.pdf")], downloads),
  }, counts);
  assert.deepEqual(downloads, ["/Fund III/Quarterly/q1.pdf"], "the out-of-scope document was never read");
  assert.deepEqual(counts, { discovered: 2, accepted: 1, duplicate: 0, rejected: 1 });
  const rejected = ledger.entries.find((entry) => entry.disposition === "rejected")!;
  assert.equal(rejected.rejectionReason, "outside_confirmed_scope");
  assert.match(rejected.contentSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(sink.inputs.map((input) => input.fileName), ["q1.pdf"]);
});

test("the ingest sink is told which connection and which acquisition key the document is, so it can be idempotent", async () => {
  const sink = new RecordingSink();
  await collectDocuments({ connection, credential: {}, ledger: new MemoryLedger(), ingest: sink, driver: driverFor([ref("/Fund III/Quarterly/q1.pdf", "remote-1", "v7")]) }, emptyCounts());
  const [input] = sink.inputs;
  assert.equal(input!.sourceConnectionId, CONNECTION);
  assert.equal(input!.acquisitionKey, acquisitionKey("remote-1", "v7", input!.contentSha256));
});

test("a second pass over the same remote versions ingests nothing again, while a new version is collected", async () => {
  const ledger = new MemoryLedger();
  const sink = new RecordingSink();
  const files = [ref("/Fund III/Quarterly/q1.pdf", "remote-1", "v1")];
  const first = emptyCounts();
  await collectDocuments({ connection, credential: {}, ledger, ingest: sink, driver: driverFor(files) }, first);
  const second = emptyCounts();
  await collectDocuments({ connection, credential: {}, ledger, ingest: sink, driver: driverFor(files) }, second);
  const third = emptyCounts();
  await collectDocuments({ connection, credential: {}, ledger, ingest: sink, driver: driverFor([ref("/Fund III/Quarterly/q1.pdf", "remote-1", "v2")]) }, third);
  assert.deepEqual([first.accepted, second.accepted, second.duplicate, third.accepted], [1, 0, 1, 1]);
  assert.equal(sink.inputs.length, 2, "one ingest per remote version, never per run");
});

test("a rejected or quarantined result is recorded as such and a document-level failure never stops the run", async () => {
  const ledger = new MemoryLedger();
  const results: IngestResult[] = [{ accepted: false, reason: "unsupported_file_type", quarantined: false }, { accepted: false, reason: "upload_integrity_failed", quarantined: true }];
  const sink: IngestSink = { ingest: async () => results.shift()! };
  const failing: ConnectorDriver = {
    ...driverFor([ref("/Fund III/Quarterly/a.pdf", "a"), ref("/Fund III/Quarterly/b.pdf", "b"), ref("/Fund III/Quarterly/c.pdf", "c"), ref("/Fund III/Quarterly/d.pdf", "d")]),
    download: async (_credential, item) => {
      if (item.remoteDocumentId === "d") throw new ConnectorError("download", "file vanished");
      if (item.remoteDocumentId === "c") throw "not an error object";
      return { bytes: Buffer.from(item.remoteDocumentId), contentType: "application/pdf" };
    },
  };
  const counts = emptyCounts();
  await collectDocuments({ connection, credential: {}, ledger, ingest: sink, driver: failing }, counts);
  assert.deepEqual(ledger.entries.map((entry) => [entry.disposition, entry.rejectionReason]), [
    ["rejected", "unsupported_file_type"], ["quarantined", "upload_integrity_failed"], ["rejected", "download_failed"], ["rejected", "file vanished"],
  ]);
  assert.equal(counts.rejected, 4);
});

test("a credential or permission failure on one document fails the whole run closed", async () => {
  const driver: ConnectorDriver = { ...driverFor([ref("/Fund III/Quarterly/a.pdf")]), download: async () => { throw new ConnectorError("permission", "denied"); } };
  await assert.rejects(collectDocuments({ connection, credential: {}, ledger: new MemoryLedger(), ingest: new RecordingSink(), driver }, emptyCounts()), (error: unknown) => error instanceof ConnectorError && error.connectorErrorClass === "permission");
});

test("failures are classified the way the run record and the connection status need", () => {
  assert.equal(connectorErrorClass(new ConnectorError("rate_limit", "slow down")), "rate_limit");
  assert.equal(connectorErrorClass(new Error("plain")), "network", "an unclassified failure is treated as transient");
  assert.equal(connectorErrorClass({ connectorErrorClass: 5 }), "network");
  assert.equal(connectorErrorClass(null), "network");

  assert.deepEqual(classifyRunFailure(new ConnectorError("network", "reset"), 1, 5, 0), { errorClass: "network", message: "reset", state: "retryable", nextStatus: "active" });
  assert.equal(classifyRunFailure(new ConnectorError("network", "reset"), 5, 5, 4).state, "dead_letter", "retries used up");
  assert.equal(classifyRunFailure(new ConnectorError("network", "reset"), 5, 5, 4).nextStatus, "suspended", "the fifth consecutive failure suspends");
  assert.deepEqual(classifyRunFailure(new ConnectorError("auth", "bad token"), 1, 5, 0), { errorClass: "auth", message: "bad token", state: "refused", nextStatus: "reauthorization_required" });
  assert.equal(classifyRunFailure(new ConnectorError("permission", "no"), 1, 5, 0).nextStatus, "suspended");
  assert.equal(classifyRunFailure("boom", 1, 5, 0).message, "sync_failed");
});

// --- the Postgres run: what it writes about the schedule -------------------------------------------------------------

type Update = { sql: string; parameters: PostgresPrimitive[] };

class ScheduleDb implements PostgresSqlApi {
  status = "active";
  consecutiveFailures = 0;
  readonly updates: Update[] = [];
  readonly inserts: Update[] = [];
  async query(sql: string): Promise<PostgresRow[]> {
    if (sql.includes("from corvis_source.source_connection where")) {
      return [{
        source_connection_id: CONNECTION, tenant_id: TENANT, workspace_id: WORKSPACE, provider_key: "acme-portal", status: this.status,
        source_scope: [{ label: "Quarterly", path: "/Fund III/Quarterly" }], secret_reference: "ref", connector_version: "1.0.0", consecutive_failures: this.consecutiveFailures,
      }];
    }
    return [];
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (sql.includes("insert into corvis_source.source_connection_run")) this.inserts.push({ sql, parameters });
    if (sql.includes("update corvis_source.source_connection set")) this.updates.push({ sql, parameters });
  }
  async health() { return true; }
}

const secrets: SecretStore = { write: async () => "ref", read: async () => ({ token: "t" }), revoke: async () => undefined };
const NOW = Date.parse("2026-10-02T12:00:00.000Z");

test("a successful run schedules the next one an interval later", async () => {
  const db = new ScheduleDb();
  const outcome = await runConnectionSync(TENANT, CONNECTION, "scheduled", {
    db, secrets, ingest: new RecordingSink(), now: () => NOW,
    drivers: new Map([["acme-portal", driverFor([ref("/Fund III/Quarterly/q1.pdf")])]]),
  });
  assert.equal(outcome.state, "succeeded");
  assert.equal(db.updates.at(-1)!.parameters[2], new Date(NOW + SYNC_INTERVAL_MS).toISOString());
});

test("a transient failure backs off for a bounded, growing delay and keeps the connection active", async () => {
  const db = new ScheduleDb();
  db.consecutiveFailures = 2;
  const failing: ConnectorDriver = { ...driverFor([]), discover: async () => { throw new ConnectorError("network", "reset"); } };
  const outcome = await runConnectionSync(TENANT, CONNECTION, "scheduled", { db, secrets, ingest: new RecordingSink(), now: () => NOW, drivers: new Map([["acme-portal", failing]]) });
  assert.equal(outcome.state, "retryable");
  const update = db.updates.at(-1)!;
  assert.equal(update.parameters[4], "active");
  const delay = Date.parse(String(update.parameters[5])) - NOW;
  // Three failures: 4 minutes before jitter, jittered to between half and all of that.
  assert.ok(delay >= 2 * 60_000 && delay <= 4 * 60_000, `backoff ${delay}ms`);
});

test("a fail-closed failure stops the connection and clears its schedule so reauthorization starts it again at once", async () => {
  const db = new ScheduleDb();
  const failing: ConnectorDriver = { ...driverFor([]), discover: async () => { throw new ConnectorError("auth", "bad token"); } };
  const outcome = await runConnectionSync(TENANT, CONNECTION, "scheduled", { db, secrets, ingest: new RecordingSink(), now: () => NOW, drivers: new Map([["acme-portal", failing]]) });
  assert.equal(outcome.state, "refused");
  const update = db.updates.at(-1)!;
  assert.equal(update.parameters[4], "reauthorization_required");
  assert.equal(update.parameters[5], null);
});

test("a connection that is not active is refused for its state, not blamed on the provider, and never reaches the driver", async () => {
  for (const status of ["pending_authorization", "paused", "reauthorization_required", "suspended", "revoked"]) {
    const db = new ScheduleDb();
    db.status = status;
    let touched = false;
    const watching: ConnectorDriver = { ...driverFor([]), discover: async () => { touched = true; return []; } };
    const outcome = await runConnectionSync(TENANT, CONNECTION, "scheduled", { db, secrets, ingest: new RecordingSink(), drivers: new Map([["acme-portal", watching]]) });
    assert.equal(outcome.state, "refused");
    assert.equal(touched, false, status);
    assert.equal(db.updates.length, 0, "a refusal changes nothing about the connection");
    assert.match(db.inserts[0]!.sql, /'refused',1,\$5,\$6,now\(\),null,\$7/, "no provider error class on a refusal for the connection's own state");
    assert.equal(db.inserts[0]!.parameters[6], `connection is ${status}`);
  }
});
