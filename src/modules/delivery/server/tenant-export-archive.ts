import {
  TENANT_EXPORT_ESTIMATED_ROW_BYTES,
  tenantExportProgressPercent,
  type TenantExportBuildPhase,
  type TenantExportDataset,
  type TenantExportFile,
  type TenantExportManifest,
  type TenantExportProgress,
} from "../domain/tenant-export.ts";
import { EXPORT_COLUMNS, renderCsv, type ExportCell, type ExportRow } from "./export-renderer.ts";
import type { GcsControlClient } from "../../../platform/gcp/gcs.ts";
import type { PostgresRow, PostgresSqlApi } from "../../../platform/database/postgres.ts";
import { TENANT_ACCESS_AUDIT_FILTER } from "../../identity-access/server/tenant-admin-self-service.ts";
import {
  TENANT_EXPORT_MANIFEST_PATH,
  TENANT_EXPORT_README_PATH,
  buildTenantExportManifest,
  publicTenantExportManifest,
  tenantExportManifestBytes,
  tenantExportReadme,
} from "./tenant-export-bundle.ts";
import { keysetTimestampSql } from "../../../platform/http/keyset-sql.ts";
import { zipStream, type ZipEntryResult, type ZipSource } from "../../../platform/zip-stream.ts";

/**
 * The archive of a full tenant export, built as a stream (F10b #322, F10c #323). Nothing here holds the data set, or even
 * one file, in memory:
 *
 *  - **Data sets** (observations, the access audit, the document inventory) are read with keyset pages of a few thousand
 *    rows and written as numbered CSV parts of at most `rowsPerFile` rows, so a data set of any size is exported
 *    completely. Each page is its own statement: no transaction is held open across the build, and a retry (a new attempt
 *    after a failure or an expired lease) simply starts over from the first page.
 *  - **Source document files** are copied object by object from the object store into the archive as they are read, only
 *    for documents the organization may redistribute and whose source-file access is granted (both taken from
 *    `tenant_export_rights`, evaluated again for every page of documents, so a right withdrawn during a long build is
 *    honoured for the files not yet written). Their SHA-256 and size are measured while they stream and compared with the
 *    values recorded when the file was uploaded and scanned: a file that does not match fails the build instead of being
 *    delivered. A document that has no released, clean file, or whose stored object has gone, is counted, never listed.
 *  - **The manifest** is the last entry, because it lists every other file with its measured checksum.
 *
 * What memory does hold is bounded by the page and the stream chunk, plus a few hundred bytes of manifest entry per file
 * written (which cannot be avoided while the manifest must list them) and the ids of the funds and documents the archive
 * covers (kept for the rights re-check at download).
 */

export const TENANT_EXPORT_ROWS_PER_FILE = 100_000;
export const TENANT_EXPORT_PAGE_ROWS = 5_000;
export const TENANT_EXPORT_DOCUMENT_PAGE = 100;
/** How often the build reports progress (which also extends its lease). The lease is ten minutes, so a build that is alive reports long before it. */
export const TENANT_EXPORT_PROGRESS_INTERVAL_MS = 15_000;

const INVENTORY_COLUMNS = ["document_id", "display_name", "media_type", "status", "created_at", "size_bytes", "sha256"] as const;
const AUDIT_COLUMNS = ["occurred_at", "actor", "action", "workspace_id", "target_type", "target_id", "outcome", "metadata"] as const;

/** A stored source file whose bytes do not match the size or SHA-256 recorded when it was uploaded and scanned. Never retried: the same bytes will mismatch again. */
export class TenantExportSourceIntegrityError extends Error {
  readonly retryable = false;
  constructor(documentId: string) {
    super(`source document ${documentId} does not match its recorded size or checksum`);
    this.name = "TenantExportSourceIntegrityError";
  }
}

/** The build lost its lease to another attempt (reported by the progress heartbeat): this attempt stops writing. */
export class TenantExportLeaseLostError extends Error {
  constructor() {
    super("export build lease was lost to another attempt");
    this.name = "TenantExportLeaseLostError";
  }
}

export type TenantExportArchiveObjects = Pick<GcsControlClient, "bucket" | "getObjectStream">;

export type TenantExportArchiveOptions = {
  now?: () => number;
  rowsPerFile?: number;
  pageRows?: number;
  documentPage?: number;
  progressIntervalMs?: number;
  /** Receives each progress report. Resolves false when this attempt no longer owns the build. */
  onProgress?: (progress: TenantExportProgress) => Promise<boolean>;
};

export type TenantExportScope = { fundIds: string[]; documentIds: string[]; sourceDocumentIds: string[] };
export type TenantExportArchiveOutcome = { manifest: TenantExportManifest; publicManifest: TenantExportManifest; scope: TenantExportScope };
export type TenantExportArchive = {
  /** The archive's bytes, in order. Pull it to completion (the upload does) before reading `outcome`. */
  bytes: AsyncGenerator<Buffer>;
  outcome(): TenantExportArchiveOutcome;
};

function cell(value: unknown): ExportCell {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** The name a source document's file has inside the archive: its own name, made safe to unpack anywhere. */
export function safeSourceFileName(name: unknown): string {
  const cleaned = [...String(name ?? "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_").replace(/^\.+/, "").trim()].slice(0, 120).join("").replace(/[. ]+$/, "");
  return cleaned.length > 0 ? cleaned : "document";
}

/** The object key of a source document's file, only when it sits where this tenant's documents live and is pinned to a generation. */
export function sourceObjectKey(bucket: string, tenantId: string, documentId: string, objectUri: unknown, generation: unknown): string | null {
  const prefix = `gs://${bucket}/`;
  const uri = String(objectUri ?? "");
  if (!generation || !uri.startsWith(`${prefix}tenant=${tenantId}/document=${documentId}/`) || uri.includes("..")) return null;
  return uri.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// Queries. Rights are read inside each statement (the function is stable and cheap), so nothing carries a list of ids.
// ---------------------------------------------------------------------------

const RIGHTS = "corvis_control.tenant_export_rights($1::uuid)";

/** Approved observations in the latest published version of each redistributable fund's snapshots, whose source document is also redistributable. The same selection as a per-user observation export, tenant-wide. */
function observationQuery(select: string, tail: string): string {
  return `with entitled_fund as (select r.resource_id from ${RIGHTS} r where r.resource_type = 'fund'),
    entitled_document as (select lower(r.resource_id) as resource_id from ${RIGHTS} r where r.resource_type = 'document'),
    latest_snapshot as (
      select s.snapshot_id, s.fact_ids
      from corvis_consolidated.fund_period_snapshot s
      where s.tenant_id = $1::uuid and s.status = 'published'
        and s.fund_id in (select resource_id from entitled_fund)
        and not exists (select 1 from corvis_consolidated.fund_period_snapshot newer
          where newer.tenant_id = s.tenant_id and newer.snapshot_id = s.snapshot_id and newer.version > s.version)
    ), artifact_observation as (
      select distinct fact_observation.observation_id
      from latest_snapshot rs
      join corvis_consolidated.consolidated_fact cf on cf.tenant_id = $1::uuid and cf.consolidated_fact_id = any(rs.fact_ids)
      cross join lateral unnest(cf.source_observation_ids) as fact_observation(observation_id)
      where ($2::uuid is null or fact_observation.observation_id > $2::uuid)
    )
    select ${select}
    from artifact_observation ao
    join corvis_serving.observations o on o.tenant_id = $1::uuid and o.observation_id = ao.observation_id and o.review_state = 'approved'
    join corvis_source.source_reference r on r.tenant_id = o.tenant_id and r.source_reference_id = o.source_reference_id
    where o.fund_id in (select resource_id from entitled_fund)
      and r.document_id::text in (select resource_id from entitled_document)
    ${tail}`;
}

const OBSERVATION_PAGE = observationQuery(`o.observation_id::text, o.fund_id, o.company_id::text, o.holding_id::text, o.instrument_id::text,
      o.metric_code, o.value_number, o.value_string, o.currency, o.economic_period, o.report_date, o.review_state,
      o.source_reference_id::text, r.document_id::text, o.version, o.updated_at`, "order by o.observation_id limit $3");
const OBSERVATION_COUNT = observationQuery("count(*)::text as n", "");

const AUDIT_PAGE = `select occurred_at, actor_subject, action, workspace_id::text as workspace_id, target_type, target_id, outcome, metadata,
    ${keysetTimestampSql("occurred_at")} as cursor_at, audit_event_id::text as cursor_id
  from corvis_control.audit_event
  where tenant_id = $1::uuid and ${TENANT_ACCESS_AUDIT_FILTER}
    and ($2::timestamptz is null or (occurred_at, audit_event_id) > ($2::timestamptz, $3::uuid))
  order by occurred_at, audit_event_id
  limit $4`;
const AUDIT_COUNT = `select count(*)::text as n from corvis_control.audit_event where tenant_id = $1::uuid and ${TENANT_ACCESS_AUDIT_FILTER}`;

/** Every document the organization may redistribute, with its latest released file's size and checksum (or, with none released, its latest version's). */
const INVENTORY_PAGE = `select d.document_id::text as document_id, d.display_name, d.media_type, d.status, d.created_at, v.size_bytes, v.sha256
  from ${RIGHTS} r
  join corvis_source.document d on d.tenant_id = $1::uuid and d.document_id::text = lower(r.resource_id)
  left join lateral (
    select av.size_bytes, av.sha256 from corvis_source.document_artifact_version av
    where av.tenant_id = d.tenant_id and av.document_id = d.document_id
    order by (av.malware_scan_status = 'clean' and av.quarantine_status = 'released') desc, av.created_at desc limit 1
  ) v on true
  where r.resource_type = 'document' and ($2::uuid is null or d.document_id > $2::uuid)
  order by d.document_id
  limit $3`;

const RELEASED_FILE = `select av.object_uri, av.storage_generation, av.size_bytes, av.sha256 from corvis_source.document_artifact_version av
    where av.tenant_id = d.tenant_id and av.document_id = d.document_id
      and av.malware_scan_status = 'clean' and av.quarantine_status = 'released' and av.storage_generation is not null
    order by av.created_at desc limit 1`;

/** Documents whose file may go in the archive: redistributable, source-file access granted, and a released clean file on record. */
const SOURCE_FILE_PAGE = `select d.document_id::text as document_id, d.display_name, v.object_uri, v.storage_generation, v.size_bytes, v.sha256
  from ${RIGHTS} r
  join corvis_source.document d on d.tenant_id = $1::uuid and d.document_id::text = lower(r.resource_id)
  join lateral (${RELEASED_FILE}) v on true
  where r.resource_type = 'document' and r.source_document_access_allowed and ($2::uuid is null or d.document_id > $2::uuid)
  order by d.document_id
  limit $3`;

const DOCUMENT_ESTIMATE = `select count(*)::text as documents, count(v.object_uri)::text as files, coalesce(sum(v.size_bytes), 0)::text as file_bytes
  from ${RIGHTS} r
  join corvis_source.document d on d.tenant_id = $1::uuid and d.document_id::text = lower(r.resource_id)
  left join lateral (${RELEASED_FILE}) v on r.source_document_access_allowed
  where r.resource_type = 'document'`;

/** How many funds and documents the tenant has, against how many the archive covers, so what was left out is a count. */
const COVERAGE = `select
    (select count(*) from corvis_source.document where tenant_id = $1::uuid)::int as documents,
    (select count(distinct fund_id) from corvis_consolidated.fund_period_snapshot where tenant_id = $1::uuid and status = 'published')::int as funds,
    (select count(distinct s.fund_id) from corvis_consolidated.fund_period_snapshot s join ${RIGHTS} r on r.resource_type = 'fund' and r.resource_id = s.fund_id
       where s.tenant_id = $1::uuid and s.status = 'published')::int as included_funds`;

type PartSpec = {
  dir: string;
  stem: string;
  dataset: TenantExportDataset;
  description: string;
  columns: readonly string[];
  /** Up to `limit` rows after the cursor (null: from the start). */
  fetch(after: string | null, limit: number): Promise<PostgresRow[]>;
  cursorOf(row: PostgresRow): string;
  toRow(row: PostgresRow): ExportRow;
};

type FileInfo = { description: string; dataset: TenantExportDataset; rowCount: number; documentId?: string; expect?: { size: number | null; sha256: string | null } };

export function createTenantExportArchive(claimed: PostgresRow, store: PostgresSqlApi, objects: TenantExportArchiveObjects, options: TenantExportArchiveOptions = {}): TenantExportArchive {
  const tenantId = String(claimed.tenant_id);
  const now = options.now ?? Date.now;
  const rowsPerFile = options.rowsPerFile ?? TENANT_EXPORT_ROWS_PER_FILE;
  const pageRows = options.pageRows ?? TENANT_EXPORT_PAGE_ROWS;
  const documentPage = options.documentPage ?? TENANT_EXPORT_DOCUMENT_PAGE;
  const progressIntervalMs = options.progressIntervalMs ?? TENANT_EXPORT_PROGRESS_INTERVAL_MS;

  const infos = new Map<string, FileInfo>();
  const files: TenantExportFile[] = [];
  const funds = new Set<string>();
  const documents = new Set<string>();
  const sourceDocuments = new Set<string>();
  const state = { phase: "estimating" as TenantExportBuildPhase, estimatedBytes: 0, estimatedRows: 0, estimatedDocuments: 0, bytes: 0, rows: 0, documents: 0, inventory: 0 };
  let lastReport = Number.NEGATIVE_INFINITY;
  let outcome: TenantExportArchiveOutcome | null = null;

  async function report(force: boolean): Promise<void> {
    const at = now();
    if (!force && at - lastReport < progressIntervalMs) return;
    lastReport = at;
    const snapshot: TenantExportProgress = {
      phase: state.phase, estimatedBytes: state.estimatedBytes, bytesWritten: state.bytes, estimatedRows: state.estimatedRows, rowsWritten: state.rows,
      estimatedDocuments: state.estimatedDocuments, documentsWritten: state.documents,
      percent: tenantExportProgressPercent(state.bytes, state.estimatedBytes), updatedAt: new Date(at).toISOString(),
    };
    if (options.onProgress && !(await options.onProgress(snapshot))) throw new TenantExportLeaseLostError();
  }

  async function count(sql: string, parameters: Array<string | null> = [tenantId, null]): Promise<number> {
    return Number((await store.query(sql, parameters))[0]!.n);
  }

  /** What the archive is expected to hold, taken before anything is written, so the request can show its size while it builds. */
  async function estimate(): Promise<void> {
    const [observations, audit] = [await count(OBSERVATION_COUNT), await count(AUDIT_COUNT, [tenantId])];
    const documentRow = (await store.query(DOCUMENT_ESTIMATE, [tenantId]))[0]!;
    state.estimatedRows = observations + audit + Number(documentRow.documents);
    state.estimatedDocuments = Number(documentRow.files);
    state.estimatedBytes = state.estimatedRows * TENANT_EXPORT_ESTIMATED_ROW_BYTES + Number(documentRow.file_bytes);
    await report(true);
  }

  const observationSpec: PartSpec = {
    dir: "published-data", stem: "observations", dataset: "observations", description: "Approved observations in published snapshots", columns: EXPORT_COLUMNS,
    fetch: (after, limit) => store.query(OBSERVATION_PAGE, [tenantId, after, limit]),
    cursorOf: (row) => String(row.observation_id),
    toRow: (row) => {
      funds.add(String(row.fund_id));
      documents.add(String(row.document_id));
      return {
        observation_id: cell(row.observation_id), fund_id: cell(row.fund_id), company_id: cell(row.company_id), holding_id: cell(row.holding_id), instrument_id: cell(row.instrument_id),
        metric_code: cell(row.metric_code),
        // numeric(38,10) stays a decimal string end to end; Number() would lose digits beyond ~15.
        value_number: row.value_number == null ? null : String(row.value_number),
        value_string: cell(row.value_string), currency: cell(row.currency), economic_period: cell(row.economic_period), report_date: cell(row.report_date),
        review_state: cell(row.review_state), source_reference_id: cell(row.source_reference_id), document_id: cell(row.document_id),
        version: row.version == null ? null : Number(row.version), updated_at: cell(row.updated_at),
      };
    },
  };

  const auditSpec: PartSpec = {
    dir: "access-audit", stem: "access-audit", dataset: "access_audit", description: "Access, support, source-connection, data-issue and data-export audit trail", columns: AUDIT_COLUMNS,
    fetch: (after, limit) => {
      const [at, id] = after === null ? [null, null] : after.split("|") as [string, string];
      return store.query(AUDIT_PAGE, [tenantId, at, id, limit]);
    },
    cursorOf: (row) => `${String(row.cursor_at)}|${String(row.cursor_id)}`,
    toRow: (row) => ({
      occurred_at: cell(row.occurred_at), actor: cell(row.actor_subject), action: cell(row.action), workspace_id: cell(row.workspace_id),
      target_type: cell(row.target_type), target_id: cell(row.target_id), outcome: cell(row.outcome),
      metadata: typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata ?? {}),
    }),
  };

  const inventorySpec: PartSpec = {
    dir: "source-documents", stem: "inventory", dataset: "source_inventory", description: "Source documents you may redistribute, with their size and SHA-256", columns: INVENTORY_COLUMNS,
    fetch: (after, limit) => store.query(INVENTORY_PAGE, [tenantId, after, limit]),
    cursorOf: (row) => String(row.document_id),
    toRow: (row) => {
      documents.add(String(row.document_id));
      state.inventory += 1;
      return Object.fromEntries(INVENTORY_COLUMNS.map((column) => [column, cell(row[column])]));
    },
  };

  /** One data set as numbered CSV parts. A part fills to `rowsPerFile` rows before the next starts, and an exact multiple never leaves an empty part behind. */
  async function* parts(spec: PartSpec): AsyncGenerator<ZipSource> {
    const header = renderCsv([], spec.columns);
    let after: string | null = null;
    let hasMore = true;
    let part = 0;
    while (hasMore) {
      part += 1;
      const name = `${spec.dir}/${spec.stem}-${String(part).padStart(4, "0")}.csv`;
      const info: FileInfo = { description: spec.description, dataset: spec.dataset, rowCount: 0 };
      infos.set(name, info);
      const body = async function* (): AsyncGenerator<Uint8Array> {
        yield header;
        while (hasMore && info.rowCount < rowsPerFile) {
          const want = Math.min(pageRows, rowsPerFile - info.rowCount);
          // One row past the page tells whether there is another without counting.
          const rows = await spec.fetch(after, want + 1);
          hasMore = rows.length > want;
          const page = rows.slice(0, want);
          if (page.length === 0) continue;
          after = spec.cursorOf(page[page.length - 1]!);
          info.rowCount += page.length;
          state.rows += page.length;
          yield renderCsv(page.map(spec.toRow), spec.columns).subarray(header.length);
        }
      };
      yield { name, body: body() };
    }
  }

  async function* sourceFiles(): AsyncGenerator<ZipSource> {
    let after: string | null = null;
    for (;;) {
      const rows = await store.query(SOURCE_FILE_PAGE, [tenantId, after, documentPage]);
      for (const row of rows) {
        const documentId = String(row.document_id);
        const key = sourceObjectKey(objects.bucket, tenantId, documentId, row.object_uri, row.storage_generation);
        if (key === null) continue;
        const object = await objects.getObjectStream(key, String(row.storage_generation));
        // The stored object has gone: counted as left out, and the build carries on.
        if (object === null) continue;
        const name = `source-documents/files/${documentId}/${safeSourceFileName(row.display_name)}`;
        const size = row.size_bytes == null ? null : Number(row.size_bytes);
        infos.set(name, { description: "Source document file", dataset: "source_document", rowCount: 0, documentId, expect: { size, sha256: row.sha256 == null ? null : String(row.sha256) } });
        sourceDocuments.add(documentId);
        const body = async function* (): AsyncGenerator<Uint8Array> {
          for await (const chunk of object.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
          state.documents += 1;
        };
        yield { name, body: body(), ...(size !== null ? { sizeHint: size } : {}) };
      }
      if (rows.length < documentPage) return;
      after = String(rows[rows.length - 1]!.document_id);
    }
  }

  async function* entries(): AsyncGenerator<ZipSource> {
    // The estimate comes first, so the very first report (and the first heartbeat) already carries the size.
    await estimate();
    infos.set(TENANT_EXPORT_README_PATH, { description: "How to read and verify this export", dataset: "readme", rowCount: 0 });
    yield { name: TENANT_EXPORT_README_PATH, body: [tenantExportReadme()] };
    state.phase = "data";
    yield* parts(observationSpec);
    yield* parts(auditSpec);
    yield* parts(inventorySpec);
    state.phase = "documents";
    yield* sourceFiles();
    state.phase = "finalizing";
    await report(true);
    const coverage = (await store.query(COVERAGE, [tenantId]))[0]!;
    const documentFiles = files.filter((file) => file.dataset === "source_document").length;
    const excluded = Math.max(0, state.inventory - documentFiles);
    const manifest = buildTenantExportManifest({
      requestId: String(claimed.request_id),
      tenantId,
      generatedAt: new Date(now()).toISOString(),
      requestedBy: String(claimed.requested_by_subject),
      approvedBy: String(claimed.decided_by_subject),
      dataRights: {
        basis: "Funds and documents are included only while every effective contractual data right for them allows client visibility and redistribution, and the organization holds a workspace-level redistribution right. A source document's file is included only where source-file access is also granted.",
        funds: { included: Number(coverage.included_funds), excluded: Math.max(0, Number(coverage.funds) - Number(coverage.included_funds)) },
        documents: { included: state.inventory, excluded: Math.max(0, Number(coverage.documents) - state.inventory) },
      },
      sourceFilesExcluded: excluded,
      notIncluded: excluded === 0 ? [] : [{
        item: "Source document files",
        reason: `${excluded} document${excluded === 1 ? " is" : "s are"} listed in the inventory without ${excluded === 1 ? "its" : "their"} file: source-file access is not granted for ${excluded === 1 ? "it" : "them"}, or the stored file was not released or could not be read.`,
      }],
    }, files);
    outcome = {
      manifest,
      publicManifest: publicTenantExportManifest(manifest),
      scope: { fundIds: [...funds].sort(), documentIds: [...documents].sort(), sourceDocumentIds: [...sourceDocuments].sort() },
    };
    yield { name: TENANT_EXPORT_MANIFEST_PATH, body: [tenantExportManifestBytes(manifest)] };
  }

  /** A file is final once its bytes have been written: its measured checksum goes in the manifest, and a source file must match what was recorded for it. */
  function onEntry(result: ZipEntryResult): void {
    const info = infos.get(result.name);
    // The manifest itself is not listed in the manifest.
    if (!info) return;
    if (info.expect && ((info.expect.size !== null && info.expect.size !== result.sizeBytes) || (info.expect.sha256 !== null && info.expect.sha256 !== result.sha256))) {
      throw new TenantExportSourceIntegrityError(info.documentId!);
    }
    files.push({
      path: result.name, description: info.description, sha256: result.sha256, sizeBytes: result.sizeBytes, rowCount: info.rowCount, dataset: info.dataset,
      ...(info.documentId ? { documentId: info.documentId } : {}),
    });
  }

  async function* bytes(): AsyncGenerator<Buffer> {
    for await (const part of zipStream(entries(), onEntry)) {
      state.bytes += part.length;
      // The heartbeat rides on the stream itself, so a build that is moving bytes keeps its lease however large one file is.
      await report(false);
      yield part;
    }
  }

  return {
    bytes: bytes(),
    outcome() {
      if (!outcome) throw new Error("the archive has not been fully written");
      return outcome;
    },
  };
}
