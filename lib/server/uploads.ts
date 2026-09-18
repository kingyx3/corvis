import { createHash, randomUUID } from "crypto";
import type { RequestIdentity } from "@/core/enterprise";
import { getServerConfig } from "@/lib/server/config";
import { s3, type MultipartPart, type S3ControlClient } from "@/lib/server/s3";
import { snowflake, type SnowflakeSqlApi } from "@/lib/server/snowflake";

export type UploadSession = {
  uploadId: string;
  documentId: string;
  artifactVersionId: string;
  ingestionId: string;
  tenantId: string;
  actorSubject: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  partSize: number;
  state: "initiated" | "uploading" | "quarantined" | "complete" | "aborted";
  completedParts: { partNumber: number; etag: string }[];
  checksumSha256?: string;
  idempotencyKey: string;
  createdAt: string;
  objectKey?: string;
  multipartUploadId?: string;
  storageVersionId?: string;
  contentValidated?: boolean;
  malwareScanStatus?: "pending" | "clean" | "threat" | "error";
  releasedAt?: string;
};

export interface UploadSessionPort {
  initiate(identity: RequestIdentity, input: { fileName: string; contentType: string; sizeBytes: number; lastModified?: number; checksumSha256?: string; idempotencyKey: string }): Promise<UploadSession>;
  get(identity: RequestIdentity, uploadId: string): Promise<UploadSession>;
  presignPart(identity: RequestIdentity, uploadId: string, partNumber: number, contentLength: number): Promise<{ url: string; headers?: Record<string,string> }>;
  complete(identity: RequestIdentity, uploadId: string, parts: { partNumber: number; etag: string }[], idempotencyKey: string): Promise<UploadSession>;
  abort(identity: RequestIdentity, uploadId: string): Promise<void>;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
const PART_SIZE = 32 * 1024 * 1024;
const allowedExtensions = /\.(pdf|xlsx|xls|docx|pptx|csv)$/i;
const allowedMime = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "application/csv",
  "application/octet-stream",
]);

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "document"; }
function keyHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sessionKey(tenantId: string, uploadId: string): string { return `_corvis/upload-sessions/tenant=${encodeURIComponent(tenantId)}/${uploadId}.json`; }
function idempotencyKey(tenantId: string, key: string): string { return `_corvis/upload-idempotency/tenant=${encodeURIComponent(tenantId)}/${keyHash(key)}.json`; }

export function validateSourceMagic(fileName: string, bytes: Buffer): boolean {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (/\.(xlsx|docx|pptx)$/i.test(lower)) return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
  if (lower.endsWith(".xls")) return bytes.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]));
  if (lower.endsWith(".csv")) return !bytes.includes(0x00);
  return false;
}

function validateInitiate(input: { fileName: string; contentType: string; sizeBytes: number }): void {
  if (!input.fileName || !allowedExtensions.test(input.fileName)) throw new Error("Unsupported file type");
  if (!allowedMime.has(input.contentType || "application/octet-stream")) throw new Error("Unsupported media type");
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_FILE_BYTES) throw new Error("Invalid file size");
}

function validateCompletedParts(session: UploadSession, parts: MultipartPart[]): MultipartPart[] {
  const expectedCount = Math.ceil(session.sizeBytes / session.partSize);
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (sorted.length !== expectedCount) throw new Error("Upload is missing one or more parts");
  if (sorted.some((part, index) => part.partNumber !== index + 1 || !part.etag)) throw new Error("Invalid completed parts");
  return sorted;
}

class DemoUploadSessions implements UploadSessionPort {
  private sessions = new Map<string, UploadSession>();
  private idempotency = new Map<string, string>();

  async initiate(identity: RequestIdentity, input: Parameters<UploadSessionPort["initiate"]>[1]) {
    validateInitiate(input);
    const existingId = this.idempotency.get(`${identity.tenantId}:${input.idempotencyKey}`);
    if (existingId) return this.get(identity, existingId);
    const session: UploadSession = {
      uploadId: randomUUID(), documentId: randomUUID(), artifactVersionId: randomUUID(), ingestionId: randomUUID(),
      tenantId: identity.tenantId, actorSubject: identity.subject, fileName: input.fileName, contentType: input.contentType, sizeBytes: input.sizeBytes,
      partSize: PART_SIZE, state: "initiated", completedParts: [], checksumSha256: input.checksumSha256,
      idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString(), malwareScanStatus: "clean", contentValidated: true,
    };
    this.sessions.set(session.uploadId, session);
    this.idempotency.set(`${identity.tenantId}:${input.idempotencyKey}`, session.uploadId);
    return session;
  }
  async get(identity: RequestIdentity, uploadId: string) {
    const session = this.sessions.get(uploadId);
    if (!session || session.tenantId !== identity.tenantId) throw new Error("Upload not found");
    return session;
  }
  async presignPart(identity: RequestIdentity, uploadId: string, partNumber: number, contentLength: number) {
    const session = await this.get(identity, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || contentLength <= 0 || contentLength > session.partSize) throw new Error("Invalid upload part");
    return { url: `/api/v1/uploads/${uploadId}/demo-parts/${partNumber}`, headers: { "x-corvis-demo-upload": "true" } };
  }
  async complete(identity: RequestIdentity, uploadId: string, parts: { partNumber: number; etag: string }[], key: string) {
    const session = await this.get(identity, uploadId);
    if (key !== session.idempotencyKey) throw new Error("Upload completion idempotency key does not match session");
    if (session.state === "complete") return session;
    session.completedParts = validateCompletedParts(session, parts);
    session.state = "complete";
    session.releasedAt = new Date().toISOString();
    return session;
  }
  async abort(identity: RequestIdentity, uploadId: string) { const s = await this.get(identity, uploadId); s.state = "aborted"; }
}

class ProductionUploadSessions implements UploadSessionPort {
  constructor(private readonly store: S3ControlClient, private readonly db: SnowflakeSqlApi) {}

  private async persist(session: UploadSession): Promise<void> {
    await this.store.putJson(sessionKey(session.tenantId, session.uploadId), session);
  }

  private async load(identity: RequestIdentity, uploadId: string): Promise<UploadSession> {
    const session = await this.store.getJson<UploadSession>(sessionKey(identity.tenantId, uploadId));
    if (!session || session.tenantId !== identity.tenantId) throw new Error("Upload not found");
    return session;
  }

  private async registerInitiated(session: UploadSession): Promise<void> {
    const objectUri = `s3://${this.store.bucket}/${session.objectKey}`;
    await this.db.execute(`MERGE INTO PM_SOURCE.DOCUMENT t USING (SELECT ? TENANT_ID, ? DOCUMENT_ID) s ON t.TENANT_ID=s.TENANT_ID AND t.DOCUMENT_ID=s.DOCUMENT_ID WHEN NOT MATCHED THEN INSERT (TENANT_ID,DOCUMENT_ID,DISPLAY_NAME,MEDIA_TYPE,STATUS,CREATED_AT,CREATED_BY) VALUES (?,?,?,?, 'uploading', TO_TIMESTAMP_TZ(?), ?)`, [session.tenantId,session.documentId,session.tenantId,session.documentId,session.fileName,session.contentType,session.createdAt,session.actorSubject]);
    await this.db.execute(`MERGE INTO PM_SOURCE.DOCUMENT_ARTIFACT_VERSION t USING (SELECT ? TENANT_ID, ? DOCUMENT_ARTIFACT_VERSION_ID) s ON tî\¥CU]]ÒQ\Ë•SS•ÒQS‘‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓ—ÒQ\Ë‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓ—ÒQÒSˆ“ÕPUÒQSˆS”ÑT•
SS•ÒQĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓ—ÒQĞÕSQS•ÒQS‘ÑTÕSÓ—ÒQĞ’‘PÕÕT’KÒV‘WĞ–UTËÒLM‹PSĞT‘WÔĞĞS—ÔÕUTËUPTS•S‘WÔÕUTËÔ‘PUQĞU
HSQTÈ
ËËËËËËË	Ü[™[™ÉË	Ü[™[™ÉË×ÕSQTÕSTÕŠÊJXÜÙ\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹˜\Y˜Xİ™\œÚ[Û’YÙ\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹˜\Y˜Xİ™\œÚ[Û’YÙ\ÜÚ[Û‹™Øİ[Y[YÙ\ÜÚ[Û‹š[™Ù\İ[Û’YØš™Xİ\šKÙ\ÜÚ[Û‹œÚ^™P]\ËÙ\ÜÚ[Û‹˜ÚXÚÜİ[TÚLMˆÏÈ[Ù\ÜÚ[Û‹˜Ü™X]Y]JNÂˆB‚ˆš]˜]H\Ş[˜È™[X\ÙJÙ\ÜÚ[Ûˆ\ØYÙ\ÜÚ[ÛŠNˆ›ÛZ\ÙO›ÚYˆÂˆYˆ
Ù\ÜÚ[Û‹œİ]HOOH˜ÛÛ\]HŠH™]\›ÂˆÛÛœİ›İÈH™]È]J
KÒTÓÔİš[™Ê
NÂˆÙ\ÜÚ[Û‹œİ]HH˜ÛÛ\]HÂˆÙ\ÜÚ[Û‹›X[Ø\™TØØ[”İ]\ÈH˜ÛX[ˆÂˆÙ\ÜÚ[Û‹œ™[X\ÙY]H›İÎÂˆ]ØZ]\Ë™‹™^Xİ]JTUHWÔÓÕTÑK‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓˆÑUÕÔQÑWÕ‘T”ÒSÓKËPSĞT‘WÔĞĞS—ÔÕUTÏIØÛX[‰ËUPTS•S‘WÔÕUTÏIÜ™[X\ÙY	ÈÒT‘HSS•ÒQOÈS‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓ—ÒQOØKÜÙ\ÜÚ[Û‹œİÜ˜YÙU™\œÚ[Û’YÏÈ[Ù\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹˜\Y˜Xİ™\œÚ[Û’YJNÂˆ]ØZ]\Ë™‹™^Xİ]JTUHWÔÓÕTÑK‘ĞÕSQS•ÑUÕUTÏIÜ]Y]YY	ÈÒT‘HSS•ÒQOÈS‘ĞÕSQS•ÒQOØÜÙ\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹™Øİ[Y[YJNÂˆÛÛœİ›Ø’YH™YÚ\İ\™Y‰ÜÙ\ÜÚ[Û‹™Øİ[Y[YXÂˆ]ØZ]\Ë™‹™^Xİ]JQT‘ÑHS•ÈWĞÓÓ•“Ó”“ĞÑTÔÒS‘×Ò“ĞˆTÒS‘È
ÑSPÕÈSS•ÒQÈ“Ğ—ÒQ
HÈÓˆ•SS•ÒQ\Ë•SS•ÒQS‘;—)PÒ“Ğ—ÒQ\Ë’“Ğ—ÒQÒSˆ“ÕPUÒQSˆS”ÑT•
SS•ÒQ“Ğ—ÒQĞÕSQS•ÒQÕQÑKÕUKUSTPVĞUSTËÓÔ”‘SUSÓ—ÒQ‘T”ÒSÓ‹Ô‘PUQĞUTUQĞU
HSQTÈ
ËËË	Ü™YÚ\İ\™Y	Ë	Ü]Y]YY	ËKËK×ÕSQTÕSTÕŠÊK×ÕSQTÕSTÕŠÊJXÜÙ\ÜÚ[Û‹[˜[Y›Ø’YÙ\ÜÚ[Û‹[˜[Y›Ø’YÙ\ÜÚ[Û‹™Øİ[Y[YÙ\ÜÚ[Û‹š[™Ù\İ[Û’Y›İË›İ×JNÂˆÛÛœİ]™[YHØİ[Y[\™YÚ\İ\™Y‰ÜÙ\ÜÚ[Û‹™Øİ[Y[YXÂˆ]ØZ]\Ë™‹™^Xİ]JQT‘ÑHS•ÈWĞÓÓ•“Ó“ÕU“ÖÑU‘S•TÒS‘È
ÑSPÕÈSS•ÒQÈU‘S•ÒQ
HÈÓˆ•SS•ÒQ\Ë•SS•ÒQS‘‘U‘S•ÒQ\Ë‘U‘S•ÒQÒSˆ“ÕPUÒQSˆS”ÑT•
SS•ÒQU‘S•ÒQU‘S•ÕTKQÑÔ‘QĞUWÕTKQÑÔ‘QĞUWÒQVSĞQÔ‘PUQĞU
HÑSPÕËË	ÑØİ[Y[™YÚ\İ\™Y	Ë	ÙØİ[Y[	ËËT”ÑWÒ”ÓÓŠÊK×ÕSQTÕSTÕŠÊXÜÙ\ÜÚ[Û‹[˜[Y]™[YÙ\ÜÚ[Û‹[˜[Y]™[YÙ\ÜÚ[Û‹™Øİ[Y[Y”ÓÓ‹œİš[™ÚYJÈØİ[Y[YˆÙ\ÜÚ[Û‹™Øİ[Y[Y\Y˜Xİ™\œÚ[Û’YˆÙ\ÜÚ[Û‹˜\Y˜Xİ™\œÚ[Û’Y[™Ù\İ[Û’YˆÙ\ÜÚ[Û‹š[™Ù\İ[Û’YJK›İ×JNÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆB‚ˆš]˜]H\Ş[˜È™Yœ™\ÚØØ[ŠÙ\ÜÚ[Ûˆ\ØYÙ\ÜÚ[ÛŠNˆ›ÛZ\ÙO\ØYÙ\ÜÚ[ÛˆÂˆYˆ
Ù\ÜÚ[Û‹œİ]HOOHœ]X\˜[[™Yˆ\Ù\ÜÚ[Û‹›Øš™XİÙ^JH™]\›ˆÙ\ÜÚ[ÛÂˆÛÛœİÛÛ™šYÈHÙ]Ù\™\ÛÛ™šYÊ
NÂˆÛÛœİYÜÈH]ØZ]\ËœİÜ™K™Ù]YÜÊÙ\ÜÚ[Û‹›Øš™XİÙ^JNÂˆÛÛœİİ]\ÈHYÜÖØÛÛ™šYË›X[Ø\™PÛX[•YÒÙ^HÏÈ‘İX\™]SX[Ø\™TØØ[”İ]\È—NÂˆYˆ
İ]\ÈOOHÛÛ™šYË›X[Ø\™PÛX[•YÕ˜[YJHÂˆ]ØZ]\Ëœ™[X\ÙJÙ\ÜÚ[ÛŠNÂˆH[ÙHYˆ
İ]\ÈOOHÛÛ™šYË›X[Ø\™U™X]YÕ˜[YJHÂˆÙ\ÜÚ[Û‹›X[Ø\™TØØ[”İ]\ÈH™X]Âˆ]ØZ]\Ë™‹™^Xİ]JTUHWÔÓÕTÑK‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓˆÑUPSĞT‘WÔĞĞS—ÔÕUTÏIİ™X]	ËUPTS•S‘WÔÕUTÏIÜ]X\˜[[™Y	ÈÒT‘HSS•ÒQÏÈS‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓ—ÒQOØÜÙ\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹˜\Y˜Xİ™\œÚ[Û’YJNÂˆ]ØZ]\Ë™‹™^Xİ]JTUHWÔÓÕTÑK‘ĞÕSQS•ÑUÕUTÏIÜ]X\˜[[™Y	ÈÒT‘HSS•ÒQÏÈS‘ĞÕSQS•ÒQØÜÙ\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹™Øİ[Y[YJNÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆBˆ™]\›ˆÙ\ÜÚ[ÛÂˆB‚ˆ\Ş[˜È[š]X]JY[]Nˆ™\]Y\İY[]K[œ]ˆ\˜[Y]\œÏ\ØYÙ\ÜÚ[Û”ÜÈš[š]X]H—O–ÌWJNˆ›ÛZ\ÙO\ØYÙ\ÜÚ[ÛˆÂˆ˜[Y]R[š]X]J[œ]
NÂˆÛÛœİš[ÜˆH]ØZ]\ËœİÜ™K™Ù]œÛÛÈ\ØYYˆİš[™ÈOŠY[\İ[˜ŞRÙ^JY[]K[˜[Y[œ]šY[\İ[˜ŞRÙ^JJNÂˆYˆ
š[ÜË\ØYY
H™]\›ˆ\Ë™Ù]
Y[]Kš[Ü‹\ØYY
NÂˆÛÛœİ\ØYYH˜[™ÛUURQ

NÈÛÛœİØİ[Y[YH˜[™ÛUURQ

NÈÛÛœİ\Y˜Xİ™\œÚ[Û’YH˜[™ÛUURQ

NÈÛÛœİ[™Ù\İ[Û’YH˜[™ÛUURQ

NÂˆÛÛœİØš™XİÙ^HH[˜[IÜØY™S˜[YJY[]K[˜[Y
_KÙØİ[Y[IÙØİ[Y[YKØ\Y˜XİIØ\Y˜Xİ™\œÚ[Û’YKÛÜšYÚ[˜[ÉÜØY™S˜[YJ[œ]™š[S˜[YJ_XÂˆÛÛœİ][\\\ØYYH]ØZ]\ËœİÜ™K˜Ü™X]S][\\\ØY
Øš™XİÙ^KÈ[˜[ˆY[]K[˜[YØİ[Y[ˆØİ[Y[Y\Y˜Xİˆ\Y˜Xİ™\œÚ[Û’Y[™Ù\İ[Ûˆ[™Ù\İ[Û’YJNÂˆÛÛœİÙ\ÜÚ[Ûˆ\ØYÙ\ÜÚ[ÛˆHÂˆ\ØYYØİ[Y[Y\Y˜Xİ™\œÚ[Û’Y[™Ù\İ[Û’Y[˜[YˆY[]K[˜[YXİÜ”İXš™XİˆY[]KœİXš™Xİˆš[S˜[YNˆ[œ]™š[S˜[YKÛÛ[\Nˆ[œ]˜ÛÛ[\KÚ^™P]\Îˆ[œ]œÚ^™P]\Ë\Ú^™NˆT•ÔÒV‘Kİ]Nˆš[š]X]Y‹ˆÛÛ\]Y\Îˆ×KÚXÚÜİ[TÚLMˆ[œ]˜ÚXÚÜİ[TÚLM‹Y[\İ[˜ŞRÙ^Nˆ[œ]šY[\İ[˜ŞRÙ^KÜ™X]Y]ˆ™]È]J
KÒTÓÔİš[™Ê
KˆØš™XİÙ^K][\\\ØYYÛÛ[˜[Y]Yˆ˜[ÙKX[Ø\™TØØ[”İ]\Îˆœ[™[™È‹ˆNÂˆHÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆ]ØZ]\ËœİÜ™Kœ]œÛÛŠY[\İ[˜ŞRÙ^JY[]K[˜[Y[œ]šY[\İ[˜ŞRÙ^JKÈ\ØYYJNÂˆ]ØZ]\Ëœ™YÚ\İ\’[š]X]Y
Ù\ÜÚ[ÛŠNÂˆ™]\›ˆÙ\ÜÚ[ÛÂˆHØ]Ú
\œ›ÜŠHÂˆ]ØZ]\ËœİÜ™K˜X›Ü][\\\ØY
Øš™XİÙ^K][\\\ØYY
K˜Ø]Ú


HOˆ[™Yš[™Y
NÂˆ›İÈ\œ›ÜÂˆBˆB‚ˆ\Ş[˜ÈÙ]
Y[]Nˆ™\]Y\İY[]K\ØYYˆİš[™ÊNˆ›ÛZ\ÙO\ØYÙ\ÜÚ[ÛˆÂˆÛÛœİÙ\ÜÚ[ÛˆH]ØZ]\Ë›ØY
Y[]K\ØYY
NÂˆYˆ
Ù\ÜÚ[Û‹›][\\\ØYY	‰ˆÙ\ÜÚ[Û‹›Øš™XİÙ^H	‰ˆÈš[š]X]Y‹\ØY[™È—Kš[˜ÛY\ÊÙ\ÜÚ[Û‹œİ]JJHÂˆÙ\ÜÚ[Û‹˜ÛÛ\]Y\ÈH]ØZ]\ËœİÜ™K›\İ\ÊÙ\ÜÚ[Û‹›Øš™XİÙ^KÙ\ÜÚ[Û‹›][\\\ØYY
NÂˆYˆ
Ù\ÜÚ[Û‹˜ÛÛ\]Y\Ë›[™İ
HÙ\ÜÚ[Û‹œİ]HH\ØY[™ÈÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆBˆ™]\›ˆ\Ëœ™Yœ™\ÚØØ[ŠÙ\ÜÚ[ÛŠNÂˆB‚ˆ\Ş[˜È™\ÚYÛ”\
Y[]Nˆ™\]Y\İY[]K\ØYYˆİš[™Ë\[X™\ˆ[X™\‹ÛÛ[[™İˆ[X™\ŠHÂˆÛÛœİÙ\ÜÚ[ÛˆH]ØZ]\Ë›ØY
Y[]K\ØYY
NÂˆYˆ
\Ù\ÜÚ[Û‹›Øš™XİÙ^H\Ù\ÜÚ[Û‹›][\\\ØYYVÈš[š]X]Y‹\ØY[™È—Kš[˜ÛY\ÊÙ\ÜÚ[Û‹œİ]JJH›İÈ™]È\œ›ÜŠ•\ØY\È›İXØÙ\[™È\ÈŠNÂˆÛÛœİ^XİYÛİ[HX]˜ÙZ[
Ù\ÜÚ[Û‹œÚ^™P]\ÈÈÙ\ÜÚ[Û‹œ\Ú^™JNÂˆYˆ
S[X™\‹š\Ò[YÙ\Š\[X™\ŠH\[X™\ˆH\[X™\ˆˆ^XİYÛİ[
H›İÈ™]È\œ›ÜŠ’[˜[Y\ØY\ŠNÂˆÛÛœİ^XİY[™İH\[X™\ˆOOH^XİYÛİ[ÈÙ\ÜÚ[Û‹œÚ^™P]\ÈH
\[X™\ˆHJH
ˆÙ\ÜÚ[Û‹œ\Ú^™HˆÙ\ÜÚ[Û‹œ\Ú^™NÂˆYˆ
ÛÛ[[™İOOH^XİY[™İ
H›İÈ™]È\œ›ÜŠ•\ØY\[™İÙ\È›İX]ÚÙ\ÜÚ[ÛˆŠNÂˆÙ\ÜÚ[Û‹œİ]HH\ØY[™ÈÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆ™]\›ˆÈ\›ˆ\ËœİÜ™Kœ™\ÚYÛ•\ØY\
Ù\ÜÚ[Û‹›Øš™XİÙ^KÙ\ÜÚ[Û‹›][\\\ØYY\[X™\ŠHNÂˆB‚ˆ\Ş[˜ÈÛÛ\]JY[]Nˆ™\]Y\İY[]K\ØYYˆİš[™Ë\Îˆ][\\\×KÙ^Nˆİš[™ÊNˆ›ÛZ\ÙO\ØYÙ\ÜÚ[ÛˆÂˆÛÛœİÙ\ÜÚ[ÛˆH]ØZ]\Ë›ØY
Y[]K\ØYY
NÂˆYˆ
Ù^HOOHÙ\ÜÚ[Û‹šY[\İ[˜ŞRÙ^JH›İÈ™]È\œ›ÜŠ•\ØYÛÛ\][ÛˆY[\İ[˜ŞHÙ^HÙ\È›İX]ÚÙ\ÜÚ[ÛˆŠNÂˆYˆ
Ù\ÜÚ[Û‹œİ]HOOH˜ÛÛ\]HŠH™]\›ˆÙ\ÜÚ[ÛÂˆYˆ
\Ù\ÜÚ[Û‹›Øš™XİÙ^H\Ù\ÜÚ[Û‹›][\\\ØYY
H›İÈ™]È\œ›ÜŠ•\ØYÙ\ÜÚ[Ûˆ\È›İ[š]X[^™YŠNÂˆÛÛœİXİX[\ÈH]ØZ]\ËœİÜ™K›\İ\ÊÙ\ÜÚ[Û‹›Øš™XİÙ^KÙ\ÜÚ[Û‹›][\\\ØYY
NÂˆÛÛœİ^XİY\ÈH˜[Y]PÛÛ\]Y\ÊÙ\ÜÚ[Û‹XİX[\ÊNÂˆÛÛœİÛY[\ÈH˜[Y]PÛÛ\]Y\ÊÙ\ÜÚ[Û‹\ÊNÂˆ›Üˆ
]HHÈH^XİY\Ë›[™İÈJÊÊHÂˆYˆ
^XİY\ÖÚWKœ\[X™\ˆOOHÛY[\ÖÚWKœ\[X™\ˆ^XİY\ÖÚWK™]YËœ™\XÙP[
	È‰ËˆŠHOOHÛY[\ÖÚWK™]YËœ™\XÙP[
	È‰ËˆŠJH›İÈ™]È\œ›ÜŠÛY[ÛÛ\][ÛˆÙ\È›İX]ÚİÜ™Y\ÈŠNÂˆBˆÛÛœİÛÛ\]YH]ØZ]\ËœİÜ™K˜ÛÛ\]S][\\\ØY
Ù\ÜÚ[Û‹›Øš™XİÙ^KÙ\ÜÚ[Û‹›][\\\ØYY^XİY\ÊNÂˆÙ\ÜÚ[Û‹˜ÛÛ\]Y\ÈH^XİY\ÎÂˆÙ\ÜÚ[Û‹œİÜ˜YÙU™\œÚ[Û’YHÛÛ\]Y™\œÚ[Û’YÂˆÛÛœİXY\ˆH]ØZ]\ËœİÜ™K™Ù]Øš™Xİ™Yš^
Ù\ÜÚ[Û‹›Øš™XİÙ^KÌŠNÂˆÙ\ÜÚ[Û‹˜ÛÛ[˜[Y]YH˜[Y]TÛİ\˜ÙSXYÚXÊÙ\ÜÚ[Û‹™š[S˜[YKXY\ŠNÂˆYˆ
\Ù\ÜÚ[Û‹˜ÛÛ[˜[Y]Y
HÂˆÙ\ÜÚ[Û‹œİ]HHœ]X\˜[[™YÈÙ\ÜÚ[Û‹›X[Ø\™TØØ[”İ]\ÈH™\œ›ÜˆÂˆ]ØZ]\Ë™‹™^Xİ]JTUHWÔÓÕTÑK‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓˆÑUÕÔQÑWÕ‘T”ÒSÓOËPSUĞT‘WÔĞĞS—ÔÕUTÏIÙ\œ›Ü‰ËUPTS•S‘WÔÕUTÏIÜ]X\˜[[™Y	ÈÒT‘HSS•ÒQOÈS‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓ—ÒQOØKÜÙ\ÜÚ[Û‹œİÜ˜YÙU™\œÚ[Û’YÏÈ[Ù\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹˜\Y˜Xİ™\œÚ[Û’YJNÂˆ]ØZ]\Ë™‹™^Xİ]JTUHWÔÓÕTÑK‘ĞÕSQS•ÑUÕUTÏIÜ]X\˜[[™Y	ÈÒT‘HSS•ÒQOÈS‘ĞÕSQS•ÒQOØKÜÙ\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹™Øİ[Y[YJNÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆ›İÈ™]È\œ›ÜŠ•\ØYYØš™XİÚYÛ˜]\™HÙ\È›İX]ÚHXÛ\™Yš[H\HŠNÂˆBˆÙ\ÜÚ[Û‹œİ]HHœ]X\˜[[™YÂˆÙ\ÜÚ[Û‹›X[Ø\™TØØ[”İ]\ÈHœ[™[™ÈÂˆ]ØZ]\Ë™‹™^Xİ]JTUHWÔÓÕTÑK‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓˆÑUÕÔQÑWÕ‘T”ÒSÓOËPSUĞT‘WÔĞĞS—ÔÕUTÏIÜ[™[™ÉËUPTS•S‘WÔÕUTÏIÜ]X\˜[[™Y	ÈÒT‘HSS•ÒQOÈS‘ĞÕSQS•ĞT•QPÕÕ‘T”ÒSÓ—ÒQØÜÙ\ÜÚ[Û‹œİÜ˜YÙU™\œÚ[Û’YÏÈ[Ù\ÜÚ[Û‹[˜[YÙ\ÜÚ[Û‹˜\Y˜Xİ™\œÚ[Û’YJNÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆ™]\›ˆ\Ëœ™Yœ™\ÚØØ[ŠÙ\ÜÚ[ÛŠNÂˆB‚ˆ\Ş[˜ÈX›Ü
Y[]Nˆ™\]Y\İY[]K\ØYYˆİš[™ÊNˆ›ÛZ\ÙO›ÚYˆÂˆÛÛœİÙ\ÜÚ[ÛˆH]ØZ]\Ë›ØY
Y[]K\ØYY
NÂˆYˆ
Ù\ÜÚ[Û‹›Øš™XİÙ^H	‰ˆÙ\ÜÚ[Û‹›][\\\ØYY
H]ØZ]\ËœİÜ™K˜X›Ü][\\\ØY
Ù\ÜÚ[Û‹›Øš™XİÙ^KÙ\ÜÚ[Û‹›][\\\ØYY
NÂˆÙ\ÜÚ[Û‹œİ]HH˜X›ÜYÂˆ]ØZ]\Ëœ\œÚ\İ
Ù\ÜÚ[ÛŠNÂˆBŸB‚˜ÛÛœİ[[Ó[ÙHH›ØÙ\ÜË™[‹ÓÔ•’T×ÑSS×ÓSÑHOOHYHÂ›]Ú[™Û]Ûˆ\ØYÙ\ÜÚ[Û”Ü[™Yš[™YÂ™^Ü[˜İ[Ûˆ\ØYÙ\ÜÚ[ÛœÊ
Nˆ\ØYÙ\ÜÚ[Û”ÜÂˆYˆ
\Ú[™Û]ÛŠHÚ[™Û]ÛˆH[[Ó[ÙHÈ™]È[[Õ\ØYÙ\ÜÚ[ÛœÊ
Hˆ™]È›ÙXİ[Û•\ØYÙ\ÜÚ[ÛœÊÌÊ
KÛ›İÙ›ZÙJ
JNÂˆ™]\›ˆÚ[™Û]ÛÂŸB