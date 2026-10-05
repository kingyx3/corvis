import { createHash } from "node:crypto";
import type { PostgresPrimitive, PostgresRow, PostgresSqlApi } from "../platform/database/postgres.ts";

/**
 * A scripted tenant database and object store for the tenant export build tests (F10b, F10c). The database answers the
 * build's statements by their shape and applies the keyset rules a real page query would (rows strictly after the cursor,
 * in order, at most the limit), so a chunk boundary or a retry behaves as it would against Postgres.
 */

export const TENANT = "11111111-aaaa-4aaa-8aaa-111111111111";
export const REQUEST = "8f3d2c1e-5b6a-4c7d-9e8f-0a1b2c3d4e5f";
export const BUCKET = "corvis-bucket";
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const claimedRow = (attempt = 1): PostgresRow => ({ tenant_id: TENANT, request_id: REQUEST, build_attempts: attempt, requested_by_subject: "idp|alex", decided_by_subject: "idp|morgan" });

export function observationRow(n: number, overrides: PostgresRow = {}): PostgresRow {
  return {
    observation_id: uuid("0b5e0000", n), fund_id: n % 2 === 0 ? "fund-b" : "fund-a", company_id: "c1", holding_id: "h1", instrument_id: null, metric_code: "revenue",
    value_number: "125.0000000000", value_string: null, currency: "USD", economic_period: "LTM", report_date: new Date("2026-06-30T00:00:00.000Z"), review_state: "approved",
    source_reference_id: "s1", document_id: uuid("d0c00000", 1 + (n % 2)), version: "3", updated_at: "2026-09-01 10:00:00+00", ...overrides,
  };
}

export function auditRow(n: number, overrides: PostgresRow = {}): PostgresRow {
  return {
    occurred_at: `2026-09-01 10:00:0${n % 10}+00`, actor_subject: "idp|alex", action: "data_export.requested", workspace_id: null, target_type: "tenant_export_request",
    target_id: REQUEST, outcome: "success", metadata: { n }, cursor_at: `2026-09-01T10:00:00.${String(n).padStart(6, "0")}Z`, cursor_id: uuid("a0d10000", n), ...overrides,
  };
}

export type FakeDocument = {
  document_id: string; display_name: string; media_type: string; status: string; created_at: string; size_bytes: string | null; sha256: string | null;
  object_uri: string | null; storage_generation: string | null;
  /** Source-file access granted for this document (from tenant_export_rights). */
  sourceAccess: boolean;
  /** A released, clean file is on record (the source-file query only returns these). */
  released: boolean;
  /** The bytes the object store holds for it (absent: the object has gone). */
  bytes?: Buffer;
};

export function documentRow(n: number, bytes: Buffer, overrides: Partial<FakeDocument> = {}): FakeDocument {
  const id = uuid("d0c00000", n);
  return {
    document_id: id, display_name: `Report ${n}.pdf`, media_type: "application/pdf", status: "published", created_at: "2026-08-01 10:00:00+00",
    size_bytes: String(bytes.length), sha256: sha256(bytes), object_uri: `gs://${BUCKET}/tenant=${TENANT}/document=${id}/original.pdf`, storage_generation: "17",
    sourceAccess: true, released: true, bytes, ...overrides,
  };
}

export type Script = {
  claims?: PostgresRow[];
  observations?: PostgresRow[];
  audit?: PostgresRow[];
  documents?: FakeDocument[];
  coverage?: PostgresRow;
  completed?: PostgresRow[];
  /** Whether each progress report finds the attempt still the owner (default true). */
  owned?: boolean;
  /** Throws for the n-th statement (1-based, by its kind) once. */
  failOnce?: { pattern: RegExp; nth: number; error: Error };
  failAlways?: { pattern: RegExp; error: Error };
};

export type Call = { sql: string; parameters: PostgresPrimitive[] };

const after = (parameter: PostgresPrimitive | undefined) => (parameter === null || parameter === undefined ? null : String(parameter));

export class FakeTenantDb implements PostgresSqlApi {
  readonly calls: Call[] = [];
  readonly script: Script;
  private readonly claims: PostgresRow[];
  private readonly seen = new Map<RegExp, number>();
  constructor(script: Script = {}) { this.script = script; this.claims = [...(script.claims ?? [])]; }

  async query(sql: string, parameters: PostgresPrimitive[] = []): Promise<PostgresRow[]> {
    this.calls.push({ sql, parameters });
    const { failOnce, failAlways } = this.script;
    if (failAlways?.pattern.test(sql)) throw failAlways.error;
    if (failOnce?.pattern.test(sql)) {
      const count = (this.seen.get(failOnce.pattern) ?? 0) + 1;
      this.seen.set(failOnce.pattern, count);
      if (count === failOnce.nth) throw failOnce.error;
    }
    if (/claim_next_tenant_export_build/.test(sql)) return this.claims.splice(0, 1);
    if (/record_tenant_export_build_progress/.test(sql)) return [{ owned: this.script.owned ?? true }];
    if (/complete_tenant_export_build/.test(sql)) return this.script.completed ?? [{ request_id: REQUEST }];
    if (/fail_tenant_export_build/.test(sql)) return [{ request_id: REQUEST }];
    if (/with entitled_fund/.test(sql)) return /count\(\*\)::text as n/.test(sql) ? [{ n: String((this.script.observations ?? []).length) }] : this.observationPage(parameters);
    if (/select count\(\*\)::text as n from corvis_control\.audit_event/.test(sql)) return [{ n: String((this.script.audit ?? []).length) }];
    if (/from corvis_control\.audit_event/.test(sql)) return this.auditPage(parameters);
    if (/count\(v\.object_uri\)/.test(sql)) return [this.estimate()];
    if (/source_document_access_allowed and/.test(sql)) return this.documentPage(parameters, true);
    if (/order by d\.document_id/.test(sql)) return this.documentPage(parameters, false);
    if (/included_funds/.test(sql)) return [this.script.coverage ?? { documents: 0, funds: 0, included_funds: 0 }];
    return [];
  }

  private observationPage(parameters: PostgresPrimitive[]): PostgresRow[] {
    const cursor = after(parameters[1]);
    return [...(this.script.observations ?? [])].filter((row) => cursor === null || String(row.observation_id) > cursor).slice(0, Number(parameters[2]));
  }

  private auditPage(parameters: PostgresPrimitive[]): PostgresRow[] {
    const at = after(parameters[1]);
    const id = after(parameters[2]);
    const key = (row: PostgresRow) => `${String(row.cursor_at)}|${String(row.cursor_id)}`;
    return [...(this.script.audit ?? [])].filter((row) => at === null || key(row) > `${at}|${id}`).slice(0, Number(parameters[3]));
  }

  private documentPage(parameters: PostgresPrimitive[], files: boolean): PostgresRow[] {
    const cursor = after(parameters[1]);
    return (this.script.documents ?? [])
      .filter((document) => (cursor === null || document.document_id > cursor) && (!files || (document.sourceAccess && document.released)))
      .sort((a, b) => (a.document_id < b.document_id ? -1 : 1))
      .slice(0, Number(parameters[2]))
      .map((document) => {
        const row: Record<string, unknown> = { ...document };
        for (const internal of ["sourceAccess", "released", "bytes"]) delete row[internal];
        return row;
      });
  }

  private estimate(): PostgresRow {
    const documents = this.script.documents ?? [];
    const files = documents.filter((document) => document.sourceAccess && document.released);
    return { documents: String(documents.length), files: String(files.length), file_bytes: String(files.reduce((sum, file) => sum + Number(file.size_bytes ?? 0), 0)) };
  }

  async execute() {}
  async health() { return true; }
}

/** An object store that drains an upload as it arrives (keeping only the bytes a test inspects) and serves stored source files. */
export class FakeObjects {
  readonly bucket = BUCKET;
  readonly puts = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly deleted: string[] = [];
  readonly reads: Array<{ key: string; generation?: string }> = [];
  readonly files = new Map<string, Buffer>();
  /** The largest single piece the upload was handed, and the most bytes it ever held un-consumed. */
  maxPiece = 0;
  failPut?: Error;
  /** Fails the upload after this many pieces (a fault in the middle of a build). */
  failPutAfterPieces?: number;
  failDelete = false;
  keepBytes = true;

  addDocuments(documents: FakeDocument[]): void {
    for (const document of documents) if (document.bytes && document.object_uri) this.files.set(document.object_uri.slice(`gs://${BUCKET}/`.length), document.bytes);
  }

  async putObjectStream(key: string, source: AsyncIterable<Uint8Array>, contentType: string): Promise<{ sizeBytes: number }> {
    if (this.failPut) throw this.failPut;
    const parts: Buffer[] = [];
    let size = 0;
    let pieces = 0;
    for await (const piece of source) {
      pieces += 1;
      this.maxPiece = Math.max(this.maxPiece, piece.length);
      size += piece.length;
      if (this.keepBytes) parts.push(Buffer.from(piece));
      if (this.failPutAfterPieces !== undefined && pieces >= this.failPutAfterPieces) throw new Error("storage fault mid-write");
    }
    this.puts.set(key, { bytes: this.keepBytes ? Buffer.concat(parts) : Buffer.alloc(0), contentType });
    return { sizeBytes: size };
  }

  async getObjectStream(key: string, generation?: string): Promise<{ body: ReadableStream<Uint8Array>; contentType?: string } | null> {
    this.reads.push({ key, ...(generation ? { generation } : {}) });
    const bytes = this.files.get(key);
    return bytes ? { body: new Response(new Uint8Array(bytes)).body!, contentType: "application/pdf" } : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.deleted.push(key);
    if (this.failDelete) throw new Error("delete failed");
  }
}
