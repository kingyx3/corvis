import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { GcsObject, UploadObjectStore } from "./gcs.ts";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "./postgres.ts";
import { releaseScannedUploads } from "./upload-release.ts";

// CI runs unit tests with CORVIS_DEMO_MODE=true, which makes the poll a no-op by design;
// this suite exercises the production path.
process.env.CORVIS_DEMO_MODE = "false";

const BUCKET = "corvis-source-test";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const GENERATION = "1758240000000001";

type StoredObject = { bytes: Buffer; object: GcsObject };

class FakeStore implements UploadObjectStore {
  readonly bucket = BUCKET;
  readonly objects = new Map<string, StoredObject>();
  readonly hashed: string[] = [];
  put(key: string, bytes: Buffer, overrides: Partial<GcsObject> = {}, verdict?: string): void {
    this.objects.set(key, {
      bytes,
      object: {
        generation: GENERATION, size: String(bytes.length),
        metadata: verdict ? { "corvis-malware-status": verdict } : {},
        ...overrides,
      },
    });
  }
  async getObjectMetadata(key: string): Promise<GcsObject | null> { return this.objects.get(key)?.object ?? null; }
  async getObjectSha256(key: string): Promise<string> {
    const stored = this.objects.get(key);
    if (!stored) throw new Error("GCS object hash read failed (404)");
    this.hashed.push(key);
    return createHash("sha256").update(stored.bytes).digest("hex");
  }
  async createResumableUpload(): Promise<string> { throw new Error("unused"); }
  async cancelResumableUpload(): Promise<void> { throw new Error("unused"); }
  async putJson(): Promise<void> { throw new Error("unused"); }
  async getJson<T>(): Promise<T | null> { throw new Error("unused"); }
  async getObjectPrefix(): Promise<Buffer> { throw new Error("unused"); }
  async deleteObject(): Promise<void> { throw new Error("unused"); }
  async listObjects(): Promise<string[]> { throw new Error("unused"); }
}

class FakeDb implements PostgresSqlApi {
  readonly executed: { sql: string; parameters: PostgresPrimitive[] }[] = [];
  readonly released: PostgresPrimitive[][] = [];
  readonly sealed: PostgresPrimitive[][] = [];
  shaMatches = true;
  /** SQL of the pending-rows selection, so the queue ordering can be asserted. */
  queueSql = "";
  /** Makes the attempt stamp fail, as a database outage would. */
  failStamp = false;
  /** What the integrity seal's own read reports the artifact as (undefined = not yet sealed). */
  artifact: PostgresRow | undefined;
  private readonly pending: PostgresRow[];
  constructor(pending: PostgresRow[]) { this.pending = pending; }
  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    if (sql.includes("from corvis_source.document_artifact_version") && sql.includes("malware_scan_status='pending'")) { this.queueSql = sql; return this.pending; }
    if (sql.includes("select malware_scan_status, quarantine_status")) return this.artifact ? [this.artifact] : [];
    if (sql.includes("set sha256=lower(coalesce(sha256")) { this.sealed.push(parameters); return [{ sha_matches: this.shaMatches }]; }
    if (sql.includes("release_clean_artifact")) { this.released.push(parameters); return [{ job_id: `registered:${String(parameters[1])}` }]; }
    throw new Error(`unexpected SQL: ${sql}`);
  }
  async execute(sql: string, parameters: PostgresPrimitive[] = []): Promise<void> {
    if (this.failStamp && sql.includes("last_release_attempt_at")) throw new Error("postgres unavailable");
    this.executed.push({ sql, parameters });
  }
  async health(): Promise<boolean> { return true; }
  /** Artifact ids sent to the back of the queue. */
  stamped(): string[] {
    return this.executed.filter((call) => call.sql.includes("set last_release_attempt_at=now()")).map((call) => String(call.parameters[1]));
  }
  statuses(): string[] {
    return this.executed.map((call) => call.sql.match(/malware_scan_status='([a-z_]+)'/)?.[1]).filter((value): value is string => Boolean(value));
  }
}

function pendingRow(name: string, bytes: Buffer, overrides: PostgresRow = {}): PostgresRow {
  return {
    tenant_id: TENANT, document_id: `d-${name}`, artifact_version_id: `a-${name}`, ingestion_id: `i-${name}`,
    object_uri: `gs://${BUCKET}/tenant=t/${name}.pdf`, size_bytes: bytes.length, storage_generation: GENERATION,
    ...overrides,
  };
}

const pdf = Buffer.from("%PDF-1.7\nquarterly report");

test("a clean verdict that lands after completion seals the digest and releases the artifact", async () => {
  const store = new FakeStore();
  store.put("tenant=t/clean.pdf", pdf, {}, "clean");
  const db = new FakeDb([pendingRow("clean", pdf)]);
  const summary = await releaseScannedUploads({ store, db });

  assert.deepEqual(summary, { scanned: 1, released: 1, threats: 0, integrityFailed: 0, pending: 0, errors: 0 });
  assert.equal(db.sealed[0]?.[2], createHash("sha256").update(pdf).digest("hex"));
  assert.deepEqual(db.released[0], [TENANT, "d-clean", "a-clean", GENERATION, "i-clean"]);
});

test("an artifact another path already released is not released again", async () => {
  const store = new FakeStore();
  store.put("tenant=t/raced.pdf", pdf, {}, "clean");
  const db = new FakeDb([pendingRow("raced", pdf)]);
  // Simulates a concurrent interactive release landing between this tick's
  // pending-rows query and its own integrity seal read.
  db.artifact = { malware_scan_status: "clean", quarantine_status: "released" };
  const summary = await releaseScannedUploads({ store, db });

  assert.deepEqual(summary, { scanned: 1, released: 1, threats: 0, integrityFailed: 0, pending: 0, errors: 0 });
  assert.deepEqual(store.hashed, [], "an already-released artifact is not re-hashed");
  // release_clean_artifact unconditionally resets document.status back to
  // 'queued', so calling it a second time would corrupt a pipeline that has
  // already progressed past that stage.
  assert.equal(db.released.length, 0, "an already-released artifact must not be re-released");
});

test("an artifact with no scanner verdict yet is left quarantined and never read", async () => {
  const store = new FakeStore();
  store.put("tenant=t/waiting.pdf", pdf);
  const db = new FakeDb([pendingRow("waiting", pdf)]);
  const summary = await releaseScannedUploads({ store, db });
  assert.equal(summary.pending, 1);
  assert.equal(db.released.length, 0);
  assert.deepEqual(store.hashed, []);
});

test("a threat verdict is recorded and never released", async () => {
  const store = new FakeStore();
  store.put("tenant=t/threat.pdf", pdf, {}, "threat");
  const db = new FakeDb([pendingRow("threat", pdf)]);
  const summary = await releaseScannedUploads({ store, db });
  assert.equal(summary.threats, 1);
  assert.equal(db.released.length, 0);
  assert.deepEqual(db.statuses(), ["threat"]);
});

test("a clean verdict for a replaced or resized object is an integrity failure, not a release", async () => {
  const store = new FakeStore();
  store.put("tenant=t/replaced.pdf", pdf, { generation: "1758240000000999" }, "clean");
  store.put("tenant=t/grown.pdf", pdf, { size: String(pdf.length + 1) }, "clean");
  const db = new FakeDb([pendingRow("replaced", pdf), pendingRow("grown", pdf)]);
  const summary = await releaseScannedUploads({ store, db });
  assert.equal(summary.integrityFailed, 2);
  assert.equal(db.released.length, 0);
  assert.deepEqual(db.statuses(), ["integrity_failed", "integrity_failed"]);
  assert.deepEqual(store.hashed, [], "a mismatched object is never hashed or trusted");
});

test("bytes that contradict a declared digest are quarantined instead of released", async () => {
  const store = new FakeStore();
  store.put("tenant=t/liar.pdf", pdf, {}, "clean");
  const db = new FakeDb([pendingRow("liar", pdf)]);
  db.shaMatches = false;
  const summary = await releaseScannedUploads({ store, db });
  assert.equal(summary.integrityFailed, 1);
  assert.equal(db.released.length, 0);
});

test("one unreadable artifact does not stop the rest of the batch", async () => {
  const store = new FakeStore();
  store.put("tenant=t/ok.pdf", pdf, {}, "clean");
  const db = new FakeDb([
    pendingRow("foreign", pdf, { object_uri: "gs://another-bucket/x.pdf" }),
    pendingRow("ok", pdf),
  ]);
  const summary = await releaseScannedUploads({ store, db });
  assert.equal(summary.errors, 1);
  assert.equal(summary.released, 1);
});

test("the batch stops starting new artifacts once its time budget is spent", async () => {
  const store = new FakeStore();
  store.put("tenant=t/one.pdf", pdf, {}, "clean");
  store.put("tenant=t/two.pdf", pdf, {}, "clean");
  const db = new FakeDb([pendingRow("one", pdf), pendingRow("two", pdf)]);
  let clock = 0;
  const summary = await releaseScannedUploads({ store, db, budgetMs: 1000, now: () => (clock += 600) });
  assert.equal(summary.scanned, 1, "the second artifact waits for the next tick");
});

test("the latest release_clean_artifact definition refuses any scan verdict other than pending or clean", async () => {
  const directory = "db/postgres/migrations";
  const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(name)).sort();
  let latest = "";
  for (const name of files) {
    const sql = await readFile(`${directory}/${name}`, "utf8");
    if (/create or replace function corvis_source\.release_clean_artifact/i.test(sql)) latest = sql;
  }
  assert.ok(latest, "no migration defines release_clean_artifact");
  const definition = latest.slice(latest.search(/create or replace function corvis_source\.release_clean_artifact/i));
  assert.match(definition, /a\.malware_scan_status into v_previous, v_scan|malware_scan_status into/i, "the verdict is read under the row lock");
  assert.match(definition, /for update/i);
  assert.match(definition, /if v_scan not in \('pending','clean'\) then\s+raise exception/i);
  assert.ok(definition.search(/v_scan not in/i) < definition.search(/update corvis_source\.document_artifact_version/i), "the guard runs before the row is rewritten");
  // Signature and return contract are unchanged.
  assert.match(definition, /p_tenant_id uuid,\s*p_document_id uuid,\s*p_artifact_version_id uuid,\s*p_storage_generation text,\s*p_ingestion_id text\s*\)\s*returns text/i);
});

test("rows that stay pending or fail are stamped so they go to the back of the queue; settled rows are not", async () => {
  const store = new FakeStore();
  store.put("tenant=t/waiting.pdf", pdf);
  store.put("tenant=t/ok.pdf", pdf, {}, "clean");
  store.put("tenant=t/threat.pdf", pdf, {}, "threat");
  const db = new FakeDb([
    pendingRow("waiting", pdf),
    pendingRow("foreign", pdf, { object_uri: "gs://another-bucket/x.pdf" }),
    pendingRow("ok", pdf),
    pendingRow("threat", pdf),
  ]);
  const summary = await releaseScannedUploads({ store, db });
  assert.deepEqual(summary, { scanned: 4, released: 1, threats: 1, integrityFailed: 0, pending: 1, errors: 1 });
  assert.deepEqual(db.stamped(), ["a-waiting", "a-foreign"]);
  assert.deepEqual(db.executed.find((call) => call.sql.includes("last_release_attempt_at"))?.parameters, [TENANT, "a-waiting"]);
});

test("a failed attempt stamp never fails the batch", async () => {
  const store = new FakeStore();
  store.put("tenant=t/waiting.pdf", pdf);
  store.put("tenant=t/ok.pdf", pdf, {}, "clean");
  const db = new FakeDb([pendingRow("waiting", pdf), pendingRow("ok", pdf)]);
  db.failStamp = true;
  const summary = await releaseScannedUploads({ store, db });
  assert.equal(summary.pending, 1);
  assert.equal(summary.released, 1);
  assert.equal(summary.errors, 0);
});

test("the release queue is ordered by recent attempts and interleaved per tenant, not by age alone", async () => {
  const store = new FakeStore();
  const db = new FakeDb([]);
  await releaseScannedUploads({ store, db });
  const sql = db.queueSql.replace(/\s+/g, " ");
  assert.match(sql, /row_number\(\) over \(partition by tenant_id order by last_release_attempt_at nulls first, created_at\) as tenant_rank/);
  assert.match(sql, /order by tenant_rank, last_release_attempt_at nulls first, created_at limit \$1/);
  assert.match(sql, /created_at > now\(\) - make_interval\(secs => \$2\)/, "the retention window still bounds the queue");
});

test("migration 077 adds the attempt column and a partial index covering exactly the release queue", async () => {
  const sql = (await readFile("db/postgres/migrations/077_upload_release_queue_fairness.sql", "utf8")).replace(/--.*$/gm, "").replace(/\s+/g, " ");
  assert.match(sql, /^ ?begin; alter table corvis_source\.document_artifact_version add column if not exists last_release_attempt_at timestamptz; /);
  assert.doesNotMatch(sql, /last_release_attempt_at timestamptz (not null|default)/, "the column is nullable with no default");
  const index = sql.match(/create index if not exists (\w+) on corvis_source\.document_artifact_version \(([^)]*)\) where ([^;]*);/);
  assert.ok(index, "a partial index must be created");
  assert.equal(index[2], "tenant_id, last_release_attempt_at nulls first, created_at");
  // The index predicate must be implied by the poll's own filter, or the planner cannot use it.
  const queue = (await readFile("src/lib/server/upload-release.ts", "utf8")).replace(/\s+/g, " ");
  assert.ok(queue.includes(index[3] ?? "?"), "the index predicate must match the release poll's filter");
  assert.doesNotMatch(sql, /release_clean_artifact/, "the release function is not touched");
  assert.match(sql, / commit; ?$/);
});
